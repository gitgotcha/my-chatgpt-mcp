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
    reads: selected.keys.length
      ? [{ rowKind: "member", rowKeys: selected.keys }]
      : [],
    consumedCount: selected.consumedCount
  };
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

  // Kept as an explicit contract point for the build engine.  Calling it
  // before the staged observation paginator is available is a deterministic
  // refusal, never an incorrect best-effort projection.
  buildPage() {
    const error = new Error("generic_profile_staged_paginator_required");
    error.code = "generic_profile_staged_paginator_required";
    throw error;
  }
});

export { memberKeyOf, profileEventOf };

