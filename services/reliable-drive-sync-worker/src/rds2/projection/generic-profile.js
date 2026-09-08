// T11 generic-profile projection primitives.
//
// The business oracle remains the already-reviewed V1 reducer.  This module
// gives the V2 projection layer a stable, bounded planning surface around
// that oracle: validation/ordering/correction semantics are reused verbatim,
// while page reads are declared by member key instead of carrying history in
// continuation_json.
import { rebuildGenericProfile } from "../../generic-profile-model.js";

export const GENERIC_PROFILE_ROW_KINDS = Object.freeze([
  "observation", "event_activity", "source_signal", "member"
]);
export const GENERIC_PROFILE_MAX_MEMBER_KEYS = 50;

function withStableCode(error) {
  if (error && typeof error === "object" && !error.code && typeof error.message === "string") {
    error.code = error.message;
  }
  return error;
}

/**
 * Run the V1 business oracle without allowing a raw Error message to leak
 * through the V2 task classifier.  The oracle is pure and clones its input.
 */
export function reduceGenericProfile(events, options) {
  try {
    return rebuildGenericProfile(events, options);
  } catch (error) {
    throw withStableCode(error);
  }
}

function profileEventOf(event) {
  return event?.payload?.event ?? event?.event ?? event;
}

// Events fetched by the projection engine carry transport fields (eventSeq,
// eventType, payload) around the domain event.  The V1 oracle deliberately
// rejects those fields, so the staged fold keeps a clean domain copy.
function cleanProfileEvent(event) {
  const source = profileEventOf(event) ?? {};
  return {
    schemaVersion: source.schemaVersion,
    eventId: source.eventId,
    eventKey: source.eventKey,
    observedAt: source.observedAt,
    sourceSkill: source.sourceSkill,
    action: source.action,
    ...(source.targetEventKey === undefined ? {} : { targetEventKey: source.targetEventKey }),
    observations: structuredClone(source.observations ?? []),
    userId: source.userId ?? event?.userId ?? null,
    username: source.username ?? event?.username ?? null,
    domain: source.domain ?? event?.domain ?? null
  };
}

function memberKeyOf(observation) {
  return `${observation.dimensionKey}\u0000${observation.subjectKey}`;
}

/**
 * Choose a non-empty event prefix whose distinct member keys fit the absolute
 * 50-key read cap.  We never split an event's observations: a page either
 * consumes the whole event or leaves it for the next page.
 */
export function selectMemberReadPrefix(events = [], maxKeys = GENERIC_PROFILE_MAX_MEMBER_KEYS) {
  if (!Array.isArray(events) || !Number.isSafeInteger(maxKeys) || maxKeys < 1) {
    return { events: [], consumedCount: 0, keys: [] };
  }
  const keys = new Set();
  let consumedCount = 0;
  for (const candidate of events) {
    const source = profileEventOf(candidate);
    const next = new Set(keys);
    for (const observation of source?.observations ?? []) next.add(memberKeyOf(observation));
    if (next.size > maxKeys) break;
    keys.clear();
    for (const key of next) keys.add(key);
    consumedCount += 1;
  }
  return { events: events.slice(0, consumedCount), consumedCount, keys: [...keys] };
}

function memberReadPlan(events) {
  const selected = selectMemberReadPrefix(events);
  return {
    reads: [
      ...(selected.keys.length ? [{ rowKind: "member", rowKeys: selected.keys }] : []),
      ...events.flatMap((candidate) => {
        const source = profileEventOf(candidate);
        return source?.targetEventKey ? [{ rowKind: "event_activity", rowKeys: [source.targetEventKey] }] : [];
      })
    ],
    consumedCount: selected.consumedCount
  };
}

function activityValue(event, memberKeys) {
  return {
    event: cleanProfileEvent(event),
    eventKey: profileEventOf(event)?.eventKey ?? null,
    memberKeys: [...new Set(memberKeys)].sort()
  };
}

function stableEventCompare(left, right) {
  const time = Date.parse(left?.observedAt ?? "") - Date.parse(right?.observedAt ?? "");
  if (time !== 0) return time;
  const key = String(left?.eventKey ?? "").localeCompare(String(right?.eventKey ?? ""));
  return key || String(left?.eventId ?? "").localeCompare(String(right?.eventId ?? ""));
}

function replaceMember(snapshot, member, keyOverride = null, bucketOverride = null) {
  const key = keyOverride ?? (member ? memberKeyOf(member) : null);
  if (!key) return;
  for (const bucket of ["openWeaknesses", "improvingSignals", "stableStrengths", "observations"]) {
    snapshot[bucket] = (snapshot[bucket] ?? []).filter((item) => memberKeyOf(item) !== key);
  }
  if (member) (snapshot[bucketOverride] ?? snapshot.observations).push(member);
}

function sortSnapshotBuckets(snapshot) {
  const sortMembers = (members) => members.sort((a, b) =>
    a.dimensionKey === b.dimensionKey
      ? String(a.subjectKey).localeCompare(String(b.subjectKey))
      : String(a.dimensionKey).localeCompare(String(b.dimensionKey)));
  for (const bucket of ["openWeaknesses", "improvingSignals", "stableStrengths", "observations"]) {
    sortMembers(snapshot[bucket]);
  }
  return snapshot;
}

/**
 * The reducer is intentionally pure: it only declares reads and delegates
 * business semantics to reduceGenericProfile.  Corrections request a full
 * fixed-target rebuild; incremental wiring is added by the build engine once
 * the staged observation paginator is available.
 */
export const genericProfileReducer = Object.freeze({
  reads({ event }) {
    return memberReadPlan([event]).reads.flatMap((read) =>
      read.rowKeys.map((rowKey) => ({ as: rowKey, rowKind: read.rowKind, rowKey })));
  },

  plan({ event }) {
    const source = profileEventOf(event);
    if (!source || !GENERIC_PROFILE_ROW_KINDS.includes("member")) {
      const error = new Error("unsupported_generic_profile_event");
      error.code = "unsupported_generic_profile_event";
      throw error;
    }
    // A correction can alter any earlier active contribution.  Until the
    // indexed staged paginator is wired, forcing a fixed-target rebuild is
    // the only correct behavior; it never applies a partial correction.
    return { rebuild: true, reason: source.action === "observe" ? "generic_profile_rebuild" : "generic_profile_correction" };
  },

  planPageReads({ events }) {
    return memberReadPlan(events);
  },

  // Corrections first read the target activity row.  Only then is its member
  // impact known; the engine executes this second, still-budgeted declaration
  // before calling buildPage, so reducers never perform I/O themselves.
  expandPageReads({ events, staged }) {
    const keys = [];
    for (const candidate of events ?? []) {
      const source = profileEventOf(candidate);
      if (!source?.targetEventKey) continue;
      const activity = staged?.event_activity?.get(source.targetEventKey);
      for (const key of activity?.memberKeys ?? []) keys.push(key);
    }
    const unique = [...new Set(keys)];
    return { reads: unique.length ? [{ rowKind: "member", rowKeys: unique }] : [] };
  },

  buildPage({ events = [], continuation = {}, staged = {} } = {}) {
    const summary = continuation.summary ? structuredClone(continuation.summary) : {
      schemaVersion: "1.0", userId: null, username: null, domain: null,
      generatedAt: null, headEventId: null, sourceEventKeys: [],
      openWeaknesses: [], improvingSignals: [], stableStrengths: [], observations: []
    };
    for (const bucket of ["openWeaknesses", "improvingSignals", "stableStrengths", "observations"]) {
      summary[bucket] = Array.isArray(summary[bucket]) ? summary[bucket] : [];
    }
    const rowChanges = [];
    let processed = 0;
    const members = new Map(staged.member ?? []);
    const activities = new Map(staged.event_activity ?? []);
    for (const candidate of events) {
      const source = cleanProfileEvent(candidate);
      const raw = profileEventOf(candidate);
      const ownKeys = (source.observations ?? []).map(memberKeyOf);
      const targetActivity = raw?.targetEventKey ? activities.get(raw.targetEventKey) : null;
      const affectedKeys = [...new Set([...ownKeys, ...(targetActivity?.memberKeys ?? [])])];
      const activityEvents = [];
      if (targetActivity?.event) activityEvents.push(targetActivity.event);
      for (const memberKey of affectedKeys) {
        const previous = members.get(memberKey);
        const history = Array.isArray(previous?.events) ? structuredClone(previous.events) : [...activityEvents];
        if (history.every((item) => item.eventKey !== source.eventKey)) history.push(source);
        // A target activity may be absent from a newly affected member's row;
        // include it solely to validate the correction relationship.
        for (const target of activityEvents) {
          if (history.every((item) => item.eventKey !== target.eventKey)) history.unshift(target);
        }
        const identity = summary.userId && summary.username
          ? { userId: summary.userId, username: summary.username }
          : { userId: source.userId, username: source.username };
        const domain = summary.domain ?? source.domain;
        const projected = reduceGenericProfile(history, { identity, domain });
        members.set(memberKey, { memberKey, events: history, projected });
        const projectedMember = projected.openWeaknesses[0] ?? projected.improvingSignals[0]
          ?? projected.stableStrengths[0] ?? projected.observations[0] ?? null;
        const projectedBucket = ["openWeaknesses", "improvingSignals", "stableStrengths", "observations"]
          .find((bucket) => projected[bucket]?.length);
        replaceMember(summary, projectedMember, memberKey, projectedBucket);
      }
      for (const observation of source.observations ?? []) {
        const memberKey = memberKeyOf(observation);
        rowChanges.push({
          rowKind: "observation", rowKey: `${source.eventKey}\u0000${rowChanges.length}`,
          memberKey, sortKey: String(raw?.eventSeq ?? "").padStart(20, "0"),
          value: { eventKey: source.eventKey, eventId: source.eventId,
            observedAt: source.observedAt, memberKey, observation }
        });
        rowChanges.push({
          rowKind: "source_signal", rowKey: `${memberKey}\u0000${observation.sourceRef}`,
          memberKey, sortKey: observation.sourceRef,
          value: { sourceRef: observation.sourceRef, lastEventKey: source.eventKey }
        });
      }
      const activity = activityValue(candidate, affectedKeys);
      activities.set(source.eventKey, activity);
      rowChanges.push({
        rowKind: "event_activity", rowKey: source.eventKey,
        sortKey: String(raw?.eventSeq ?? "").padStart(20, "0"),
        value: activity
      });
      for (const memberKey of affectedKeys) {
        const row = members.get(memberKey);
        rowChanges.push({ rowKind: "member", rowKey: memberKey, memberKey, sortKey: memberKey,
          value: { memberKey, events: row?.events ?? [], projected: row?.projected ?? null } });
      }
      summary.sourceEventKeys = [...new Set([...(summary.sourceEventKeys ?? []), source.eventKey])].sort();
      if (!summary.userId) { summary.userId = source.userId; summary.username = source.username; summary.domain = source.domain; }
      if (!summary.headEventId || stableEventCompare(source, {
        eventId: summary.headEventId, eventKey: summary.headEventId, observedAt: summary.generatedAt
      }) > 0) {
        summary.headEventId = source.eventId;
        summary.generatedAt = source.observedAt;
      }
      processed += 1;
      if (rowChanges.length > 16) break;
    }
    if (processed === 0 && events.length > 0) {
      const error = new Error("changes_too_large");
      error.code = "changes_too_large";
      throw error;
    }
    summary.openWeaknesses = summary.openWeaknesses ?? [];
    summary.improvingSignals = summary.improvingSignals ?? [];
    summary.stableStrengths = summary.stableStrengths ?? [];
    summary.observations = summary.observations ?? [];
    sortSnapshotBuckets(summary);
    return {
      rowChanges,
      summary,
      continuation: {
        nextEventSeq: processed > 0
          ? Number(events[processed - 1].eventSeq) + 1
          : continuation.nextEventSeq,
        page: (continuation.page ?? 1) + 1
      }
    };
  }
});

export { memberKeyOf, profileEventOf };
