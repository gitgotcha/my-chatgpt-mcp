import { validateGenericProfileDomain, validateGenericProfileEvent } from "./generic-profile-contract.js";

// Conservative outcome categories shared by the projection rules.
const POSITIVE_OUTCOMES = new Set(["completed", "correct", "passed"]);
const NEGATIVE_OUTCOMES = new Set(["stuck", "incorrect", "failed"]);
const NEUTRAL_OUTCOMES = new Set(["observed", "consulted"]);
const PARTIAL_OUTCOME = "partial";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function compareStable(a, b) {
  const time = Date.parse(a.observedAt) - Date.parse(b.observedAt);
  if (time !== 0) return time;
  if (a.eventKey < b.eventKey) return -1;
  if (a.eventKey > b.eventKey) return 1;
  if (a.eventId < b.eventId) return -1;
  if (a.eventId > b.eventId) return 1;
  return 0;
}

export function rebuildGenericProfile(events, { identity, domain } = {}) {
  if (!identity || typeof identity !== "object"
    || typeof identity.userId !== "string" || !UUID.test(identity.userId)
    || typeof identity.username !== "string" || !identity.username.trim()) {
    throw new Error("invalid_identity");
  }
  try {
    validateGenericProfileDomain(domain);
  } catch {
    throw new Error("invalid_domain");
  }

  // Validate and clone every event so caller data is never mutated or trusted
  // by reference.
  const validated = [];
  for (const source of Array.isArray(events) ? events : []) {
    validated.push(validateGenericProfileEvent(source, { boundIdentity: identity, domain }));
  }
  validated.sort(compareStable);

  // Idempotent dedupe by eventKey with conflict detection before any
  // correction is applied.
  const deduped = [];
  const byKey = new Map();
  for (const event of validated) {
    const existing = byKey.get(event.eventKey);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(event)) {
        throw new Error("event_key_conflict");
      }
      continue;
    }
    byKey.set(event.eventKey, event);
    deduped.push(event);
  }

  // Apply corrections in stable order. A correction may only target an
  // earlier, still-active observe or supersede event with a strictly earlier
  // observedAt, which also makes cycles impossible.
  const processed = new Map();
  const deactivated = new Set();
  const activeEvents = [];
  for (const event of deduped) {
    if (event.action === "observe") {
      activeEvents.push(event);
      processed.set(event.eventKey, event);
      continue;
    }
    if (event.targetEventKey === event.eventKey) {
      throw new Error("invalid_profile_event");
    }
    const target = processed.get(event.targetEventKey);
    if (!target) {
      throw new Error("target_event_not_found");
    }
    if (!(Date.parse(event.observedAt) > Date.parse(target.observedAt))) {
      throw new Error("invalid_profile_event");
    }
    if (deactivated.has(target.eventKey) || target.action === "invalidate") {
      throw new Error("target_event_inactive");
    }
    deactivated.add(target.eventKey);
    if (event.action === "supersede") {
      activeEvents.push(event);
    }
    processed.set(event.eventKey, event);
  }
  const active = activeEvents.filter((event) => !deactivated.has(event.eventKey));

  // Group active observations by dimension and subject.
  const groups = new Map();
  for (const event of active) {
    for (const observation of event.observations) {
      const key = `${observation.dimensionKey}\u0000${observation.subjectKey}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ observation, event });
    }
  }

  const memberOf = (entries) => {
    const latest = entries[entries.length - 1];
    const eventKeys = [...new Set(entries.map((entry) => entry.event.eventKey))].sort();
    const sourceRefs = [...new Set(entries.map((entry) => entry.observation.sourceRef))].sort();
    let positiveEvidenceCount = 0;
    let negativeEvidenceCount = 0;
    let partialEvidenceCount = 0;
    for (const { observation } of entries) {
      if (POSITIVE_OUTCOMES.has(observation.outcome)) positiveEvidenceCount += 1;
      else if (NEGATIVE_OUTCOMES.has(observation.outcome)) negativeEvidenceCount += 1;
      else if (observation.outcome === PARTIAL_OUTCOME) partialEvidenceCount += 1;
    }
    return {
      dimensionKey: latest.observation.dimensionKey,
      subjectKey: latest.observation.subjectKey,
      latestOutcome: latest.observation.outcome,
      latestObservedAt: latest.event.observedAt,
      confidence: latest.observation.confidence,
      positiveEvidenceCount,
      negativeEvidenceCount,
      partialEvidenceCount,
      evidenceRefs: eventKeys,
      sourceRefs
    };
  };

  const openWeaknesses = [];
  const improvingSignals = [];
  const stableStrengths = [];
  const observations = [];
  for (const entries of groups.values()) {
    const member = memberOf(entries);
    const latestOutcome = member.latestOutcome;
    // Distinct positive sources since the most recent negative evidence; a
    // negative resets the count so closure always needs fresh confirmation.
    const distinctPositiveSources = new Set();
    let hasNegative = false;
    for (const { observation } of entries) {
      if (NEGATIVE_OUTCOMES.has(observation.outcome)) {
        hasNegative = true;
        distinctPositiveSources.clear();
      } else if (POSITIVE_OUTCOMES.has(observation.outcome)) {
        distinctPositiveSources.add(observation.sourceRef);
      }
    }
    // Conservative classification: a negative opens a weakness; only two
    // positives from distinct sources after the most recent negative close it
    // into a stable strength; a partial after a negative signals improvement;
    // observed/consulted never create or close anything on their own.
    if (distinctPositiveSources.size >= 2 && !NEGATIVE_OUTCOMES.has(latestOutcome)) {
      stableStrengths.push(member);
    } else if (NEGATIVE_OUTCOMES.has(latestOutcome)) {
      openWeaknesses.push(member);
    } else if (latestOutcome === PARTIAL_OUTCOME) {
      (hasNegative ? improvingSignals : observations).push(member);
    } else if (POSITIVE_OUTCOMES.has(latestOutcome)) {
      (hasNegative ? openWeaknesses : observations).push(member);
    } else {
      (hasNegative ? openWeaknesses : observations).push(member);
    }
  }

  const sortMembers = (members) => members.sort((a, b) =>
    a.dimensionKey === b.dimensionKey
      ? (a.subjectKey < b.subjectKey ? -1 : a.subjectKey > b.subjectKey ? 1 : 0)
      : (a.dimensionKey < b.dimensionKey ? -1 : 1));

  const last = deduped[deduped.length - 1];
  return {
    schemaVersion: "1.0",
    userId: identity.userId,
    username: identity.username,
    domain,
    generatedAt: last ? last.observedAt : null,
    headEventId: last ? last.eventId : null,
    sourceEventKeys: deduped.map((event) => event.eventKey).sort(),
    openWeaknesses: sortMembers(openWeaknesses),
    improvingSignals: sortMembers(improvingSignals),
    stableStrengths: sortMembers(stableStrengths),
    observations: sortMembers(observations)
  };
}
