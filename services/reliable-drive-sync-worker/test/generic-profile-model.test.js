import assert from "node:assert/strict";
import test from "node:test";
import { rebuildGenericProfile } from "../src/generic-profile-model.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const IDENTITY = { userId: USER_ID, username: "乔炳源" };
const DOMAIN = "english-learning";

let eventCounter = 0;

function observedAt(minutes) {
  const base = Date.parse("2026-09-01T10:00:00.000Z");
  return new Date(base + minutes * 60_000).toISOString();
}

function eventId() {
  eventCounter += 1;
  return `11111111-1111-4111-8111-${String(eventCounter).padStart(12, "0")}`;
}

function observation(overrides = {}) {
  return {
    dimensionKey: "vocabulary",
    subjectKey: "concurrency",
    outcome: "stuck",
    evidence: "用户无法解释 concurrency 的含义。",
    confidence: "high",
    sourceRef: "conversation:2026-09-01:turn-18",
    ...overrides
  };
}

function profileEvent(overrides = {}) {
  const id = eventId();
  return {
    schemaVersion: "1.0",
    eventId: id,
    eventKey: `english-learning:vocabulary:concurrency:2026-09-01:${id.slice(-2)}`,
    observedAt: observedAt(eventCounter),
    sourceSkill: "english-learning",
    action: "observe",
    observations: [observation()],
    userId: USER_ID,
    username: "乔炳源",
    domain: DOMAIN,
    ...overrides
  };
}

function reduce(events) {
  return rebuildGenericProfile(events, { identity: IDENTITY, domain: DOMAIN });
}

test("an empty event set projects the canonical empty snapshot", () => {
  const snapshot = reduce([]);
  assert.deepEqual(snapshot, {
    schemaVersion: "1.0",
    userId: USER_ID,
    username: "乔炳源",
    domain: DOMAIN,
    generatedAt: null,
    headEventId: null,
    sourceEventKeys: [],
    openWeaknesses: [],
    improvingSignals: [],
    stableStrengths: [],
    observations: []
  });
});

for (const outcome of ["stuck", "incorrect", "failed"]) {
  test(`a single ${outcome} observation opens a weakness`, () => {
    const snapshot = reduce([profileEvent({ observations: [observation({ outcome })] })]);
    assert.equal(snapshot.openWeaknesses.length, 1);
    const weakness = snapshot.openWeaknesses[0];
    assert.equal(weakness.dimensionKey, "vocabulary");
    assert.equal(weakness.subjectKey, "concurrency");
    assert.equal(weakness.latestOutcome, outcome);
    assert.equal(weakness.confidence, "high");
    assert.equal(weakness.positiveEvidenceCount, 0);
    assert.equal(weakness.negativeEvidenceCount, 1);
    assert.equal(weakness.partialEvidenceCount, 0);
    assert.equal(weakness.evidenceRefs.length, 1);
    assert.equal(weakness.sourceRefs.length, 1);
    assert.deepEqual(snapshot.improvingSignals, []);
    assert.deepEqual(snapshot.stableStrengths, []);
    assert.deepEqual(snapshot.observations, []);
  });
}

test("a partial outcome after a negative becomes an improving signal", () => {
  const negative = profileEvent({ observedAt: observedAt(1) });
  const partial = profileEvent({
    observedAt: observedAt(5),
    eventKey: "english-learning:vocabulary:concurrency:2026-09-01:partial",
    observations: [observation({ outcome: "partial", sourceRef: "conversation:2026-09-01:turn-19" })]
  });
  const snapshot = reduce([negative, partial]);
  assert.equal(snapshot.improvingSignals.length, 1);
  assert.equal(snapshot.improvingSignals[0].latestOutcome, "partial");
  assert.equal(snapshot.improvingSignals[0].negativeEvidenceCount, 1);
  assert.equal(snapshot.improvingSignals[0].partialEvidenceCount, 1);
  assert.deepEqual(snapshot.openWeaknesses, []);
});

test("a partial outcome alone stays a neutral observation", () => {
  const snapshot = reduce([profileEvent({ observations: [observation({ outcome: "partial" })] })]);
  assert.equal(snapshot.observations.length, 1);
  assert.equal(snapshot.observations[0].latestOutcome, "partial");
  assert.equal(snapshot.observations[0].partialEvidenceCount, 1);
  assert.deepEqual(snapshot.openWeaknesses, []);
  assert.deepEqual(snapshot.improvingSignals, []);
});

test("one positive outcome after a negative does not close the weakness", () => {
  const negative = profileEvent({ observedAt: observedAt(1) });
  const positive = profileEvent({
    observedAt: observedAt(5),
    eventKey: "english-learning:vocabulary:concurrency:2026-09-01:positive",
    observations: [observation({ outcome: "correct", sourceRef: "conversation:2026-09-01:turn-20" })]
  });
  const snapshot = reduce([negative, positive]);
  assert.equal(snapshot.openWeaknesses.length, 1);
  assert.equal(snapshot.openWeaknesses[0].latestOutcome, "correct");
  assert.equal(snapshot.openWeaknesses[0].positiveEvidenceCount, 1);
  assert.equal(snapshot.openWeaknesses[0].negativeEvidenceCount, 1);
  assert.deepEqual(snapshot.stableStrengths, []);
});

test("two positives from distinct sources close the weakness into a stable strength", () => {
  const negative = profileEvent({ observedAt: observedAt(1) });
  const first = profileEvent({
    observedAt: observedAt(5),
    eventKey: "english-learning:vocabulary:concurrency:2026-09-01:p1",
    observations: [observation({ outcome: "correct", sourceRef: "conversation:2026-09-01:turn-20" })]
  });
  const second = profileEvent({
    observedAt: observedAt(9),
    eventKey: "english-learning:vocabulary:concurrency:2026-09-01:p2",
    observations: [observation({ outcome: "passed", sourceRef: "quiz:2026-09-01:q-3" })]
  });
  const snapshot = reduce([negative, first, second]);
  assert.deepEqual(snapshot.openWeaknesses, []);
  assert.equal(snapshot.stableStrengths.length, 1);
  const strength = snapshot.stableStrengths[0];
  assert.equal(strength.latestOutcome, "passed");
  assert.equal(strength.positiveEvidenceCount, 2);
  assert.equal(strength.negativeEvidenceCount, 1);
  assert.equal(strength.confidence, "high");
  assert.deepEqual(strength.evidenceRefs, [negative.eventKey, first.eventKey, second.eventKey]);
  assert.deepEqual(strength.sourceRefs, ["conversation:2026-09-01:turn-18", "conversation:2026-09-01:turn-20", "quiz:2026-09-01:q-3"]);
});

test("repeated positives sharing one sourceRef do not close the weakness", () => {
  const negative = profileEvent({ observedAt: observedAt(1) });
  const first = profileEvent({
    observedAt: observedAt(5),
    eventKey: "english-learning:vocabulary:concurrency:2026-09-01:p1",
    observations: [observation({ outcome: "correct", sourceRef: "conversation:2026-09-01:turn-20" })]
  });
  const second = profileEvent({
    observedAt: observedAt(9),
    eventKey: "english-learning:vocabulary:concurrency:2026-09-01:p2",
    observations: [observation({ outcome: "correct", sourceRef: "conversation:2026-09-01:turn-20" })]
  });
  const snapshot = reduce([negative, first, second]);
  assert.equal(snapshot.openWeaknesses.length, 1);
  assert.equal(snapshot.openWeaknesses[0].positiveEvidenceCount, 2);
  assert.deepEqual(snapshot.stableStrengths, []);
});

for (const outcome of ["observed", "consulted"]) {
  test(`a lone ${outcome} outcome stays a neutral observation`, () => {
    const snapshot = reduce([profileEvent({ observations: [observation({ outcome })] })]);
    assert.equal(snapshot.observations.length, 1);
    assert.equal(snapshot.observations[0].latestOutcome, outcome);
    assert.deepEqual(snapshot.openWeaknesses, []);
    assert.deepEqual(snapshot.stableStrengths, []);
    assert.deepEqual(snapshot.improvingSignals, []);
  });
}

test("supersede replaces the active target in the projection but keeps the audit trail", () => {
  const target = profileEvent({
    observedAt: observedAt(1),
    eventKey: "english-learning:vocabulary:concurrency:2026-09-01:1"
  });
  const supersede = profileEvent({
    observedAt: observedAt(5),
    eventKey: "english-learning:vocabulary:concurrency:2026-09-01:2",
    action: "supersede",
    targetEventKey: target.eventKey,
    observations: [observation({ outcome: "correct", sourceRef: "conversation:2026-09-01:turn-20" })]
  });
  const snapshot = reduce([target, supersede]);
  assert.deepEqual(snapshot.openWeaknesses, []);
  assert.deepEqual(snapshot.stableStrengths, []);
  assert.equal(snapshot.observations.length, 1);
  assert.equal(snapshot.observations[0].latestOutcome, "correct");
  assert.deepEqual(snapshot.observations[0].evidenceRefs, [supersede.eventKey]);
  assert.deepEqual(snapshot.sourceEventKeys, [target.eventKey, supersede.eventKey]);
  assert.equal(snapshot.headEventId, supersede.eventId);
  assert.equal(snapshot.generatedAt, supersede.observedAt);
});

test("invalidate removes the active target without deleting the audit trail", () => {
  const target = profileEvent({
    observedAt: observedAt(1),
    eventKey: "english-learning:vocabulary:concurrency:2026-09-01:1"
  });
  const invalidate = profileEvent({
    observedAt: observedAt(5),
    eventKey: "english-learning:vocabulary:concurrency:2026-09-01:2",
    action: "invalidate",
    targetEventKey: target.eventKey,
    observations: []
  });
  const snapshot = reduce([target, invalidate]);
  assert.deepEqual(snapshot.openWeaknesses, []);
  assert.deepEqual(snapshot.improvingSignals, []);
  assert.deepEqual(snapshot.stableStrengths, []);
  assert.deepEqual(snapshot.observations, []);
  assert.deepEqual(snapshot.sourceEventKeys, [target.eventKey, invalidate.eventKey]);
  assert.equal(snapshot.headEventId, invalidate.eventId);
  assert.equal(snapshot.generatedAt, invalidate.observedAt);
});

test("an unknown correction target is rejected", () => {
  const correction = profileEvent({
    action: "invalidate",
    targetEventKey: "english-learning:vocabulary:concurrency:2026-09-01:missing",
    observations: []
  });
  assert.throws(() => reduce([correction]), /target_event_not_found/);
});

test("a correction targeting a future event is rejected", () => {
  const early = profileEvent({
    observedAt: observedAt(5),
    eventKey: "english-learning:vocabulary:concurrency:2026-09-01:correction",
    action: "invalidate",
    targetEventKey: "english-learning:vocabulary:concurrency:2026-09-01:later",
    observations: []
  });
  const later = profileEvent({
    observedAt: observedAt(9),
    eventKey: "english-learning:vocabulary:concurrency:2026-09-01:later"
  });
  assert.throws(() => reduce([early, later]), /target_event_not_found/);
});

test("a correction whose observedAt is not strictly later than its target is rejected", () => {
  const sameTime = observedAt(5);
  const target = profileEvent({
    observedAt: sameTime,
    eventKey: "english-learning:vocabulary:concurrency:2026-09-01:a-target"
  });
  const correction = profileEvent({
    observedAt: sameTime,
    eventKey: "english-learning:vocabulary:concurrency:2026-09-01:b-correction",
    action: "invalidate",
    targetEventKey: target.eventKey,
    observations: []
  });
  assert.throws(() => reduce([target, correction]), /invalid_profile_event/);
});

test("a correction cannot target itself", () => {
  const event = profileEvent({
    action: "invalidate",
    observations: []
  });
  const self = { ...event, targetEventKey: event.eventKey };
  assert.throws(() => reduce([self]), /invalid_profile_event|target_event_not_found/);
});

test("a second correction on the same target is rejected", () => {
  const target = profileEvent({
    observedAt: observedAt(1),
    eventKey: "english-learning:vocabulary:concurrency:2026-09-01:1"
  });
  const first = profileEvent({
    observedAt: observedAt(5),
    eventKey: "english-learning:vocabulary:concurrency:2026-09-01:2",
    action: "invalidate",
    targetEventKey: target.eventKey,
    observations: []
  });
  const second = profileEvent({
    observedAt: observedAt(9),
    eventKey: "english-learning:vocabulary:concurrency:2026-09-01:3",
    action: "invalidate",
    targetEventKey: target.eventKey,
    observations: []
  });
  assert.throws(() => reduce([target, first, second]), /target_event_inactive/);
});

test("a superseded event can itself be superseded later", () => {
  const first = profileEvent({
    observedAt: observedAt(1),
    eventKey: "english-learning:vocabulary:concurrency:2026-09-01:1"
  });
  const second = profileEvent({
    observedAt: observedAt(5),
    eventKey: "english-learning:vocabulary:concurrency:2026-09-01:2",
    action: "supersede",
    targetEventKey: first.eventKey,
    observations: [observation({ outcome: "correct", sourceRef: "conversation:2026-09-01:turn-20" })]
  });
  const third = profileEvent({
    observedAt: observedAt(9),
    eventKey: "english-learning:vocabulary:concurrency:2026-09-01:3",
    action: "supersede",
    targetEventKey: second.eventKey,
    observations: [observation({ outcome: "stuck", sourceRef: "conversation:2026-09-01:turn-30" })]
  });
  const snapshot = reduce([first, second, third]);
  assert.equal(snapshot.openWeaknesses.length, 1);
  assert.equal(snapshot.openWeaknesses[0].latestOutcome, "stuck");
  assert.deepEqual(snapshot.openWeaknesses[0].evidenceRefs, [third.eventKey]);
  assert.deepEqual(snapshot.sourceEventKeys, [first.eventKey, second.eventKey, third.eventKey]);
});

test("duplicate identical events are idempotent", () => {
  const event = profileEvent();
  const snapshot = reduce([structuredClone(event), structuredClone(event)]);
  assert.equal(snapshot.openWeaknesses.length, 1);
  assert.equal(snapshot.openWeaknesses[0].negativeEvidenceCount, 1);
  assert.deepEqual(snapshot.sourceEventKeys, [event.eventKey]);
});

test("the same eventKey with different content conflicts", () => {
  const first = profileEvent();
  const second = profileEvent({
    observations: [observation({ evidence: "用户部分理解了 concurrency 的含义。" })]
  });
  second.eventKey = first.eventKey;
  assert.throws(() => reduce([first, second]), /event_key_conflict/);
});

test("input permutations produce deep-equal snapshots", () => {
  const events = [
    profileEvent({ observedAt: observedAt(1), eventKey: "english-learning:vocabulary:concurrency:2026-09-01:1" }),
    profileEvent({
      observedAt: observedAt(5),
      eventKey: "english-learning:vocabulary:concurrency:2026-09-01:2",
      observations: [observation({ outcome: "correct", sourceRef: "conversation:2026-09-01:turn-20" })]
    }),
    profileEvent({
      observedAt: observedAt(9),
      eventKey: "english-learning:vocabulary:grammar:articles:2026-09-01:3",
      observations: [observation({ dimensionKey: "grammar", subjectKey: "articles", outcome: "partial" })]
    })
  ];
  const baseline = reduce(events);
  const permutations = [
    [events[2], events[0], events[1]],
    [events[1], events[2], events[0]],
    [events[2], events[1], events[0]]
  ];
  for (const permutation of permutations) {
    assert.deepEqual(reduce(permutation), baseline);
  }
});

test("groups are independent per dimension and subject", () => {
  const events = [
    profileEvent({
      eventKey: "english-learning:vocabulary:concurrency:2026-09-01:1",
      observations: [observation({ outcome: "stuck" })]
    }),
    profileEvent({
      eventKey: "english-learning:vocabulary:idioms:2026-09-01:2",
      observations: [observation({ subjectKey: "idioms", outcome: "correct", sourceRef: "quiz:2026-09-01:q-1" })]
    }),
    profileEvent({
      eventKey: "english-learning:grammar:articles:2026-09-01:3",
      observations: [observation({ dimensionKey: "grammar", subjectKey: "articles", outcome: "failed" })]
    })
  ];
  const snapshot = reduce(events);
  assert.equal(snapshot.openWeaknesses.length, 2);
  assert.deepEqual(
    snapshot.openWeaknesses.map((item) => `${item.dimensionKey}:${item.subjectKey}`).sort(),
    ["grammar:articles", "vocabulary:concurrency"]
  );
  assert.equal(snapshot.observations.length, 1);
  assert.equal(snapshot.observations[0].subjectKey, "idioms");
});

test("evidence after a newer negative restarts the two-positive count", () => {
  const events = [
    profileEvent({
      observedAt: observedAt(1),
      eventKey: "english-learning:vocabulary:concurrency:2026-09-01:n1",
      observations: [observation({ outcome: "stuck", sourceRef: "conversation:2026-09-01:turn-1" })]
    }),
    profileEvent({
      observedAt: observedAt(5),
      eventKey: "english-learning:vocabulary:concurrency:2026-09-01:p1",
      observations: [observation({ outcome: "correct", sourceRef: "conversation:2026-09-01:turn-2" })]
    }),
    profileEvent({
      observedAt: observedAt(9),
      eventKey: "english-learning:vocabulary:concurrency:2026-09-01:p2",
      observations: [observation({ outcome: "passed", sourceRef: "quiz:2026-09-01:q-1" })]
    }),
    profileEvent({
      observedAt: observedAt(13),
      eventKey: "english-learning:vocabulary:concurrency:2026-09-01:n2",
      observations: [observation({ outcome: "incorrect", sourceRef: "conversation:2026-09-01:turn-3" })]
    }),
    profileEvent({
      observedAt: observedAt(17),
      eventKey: "english-learning:vocabulary:concurrency:2026-09-01:p3",
      observations: [observation({ outcome: "correct", sourceRef: "conversation:2026-09-01:turn-4" })]
    })
  ];
  const snapshot = reduce(events);
  assert.deepEqual(snapshot.stableStrengths, []);
  assert.equal(snapshot.openWeaknesses.length, 1);
  const weakness = snapshot.openWeaknesses[0];
  assert.equal(weakness.latestOutcome, "correct");
  assert.equal(weakness.positiveEvidenceCount, 3);
  assert.equal(weakness.negativeEvidenceCount, 2);
  assert.equal(weakness.latestObservedAt, observedAt(17));
});

test("the reducer never mutates the caller's events", () => {
  const events = [profileEvent(), profileEvent({
    eventKey: "english-learning:vocabulary:concurrency:2026-09-01:2",
    observations: [observation({ outcome: "correct", sourceRef: "quiz:2026-09-01:q-1" })]
  })];
  const before = structuredClone(events);
  reduce(events);
  assert.deepEqual(events, before);
});

test("identity and domain options are validated", () => {
  assert.throws(() => rebuildGenericProfile([], {}), /invalid_identity/);
  assert.throws(() => rebuildGenericProfile([], { identity: { userId: "not-a-uuid", username: "乔炳源" }, domain: DOMAIN }), /invalid_identity/);
  assert.throws(() => rebuildGenericProfile([], { identity: IDENTITY }), /invalid_domain/);
  assert.throws(() => rebuildGenericProfile([], { identity: IDENTITY, domain: "algorithm" }), /invalid_domain/);
});

test("events bound to another identity or domain are rejected", () => {
  const foreign = profileEvent({ userId: "22222222-2222-4222-8222-222222222222" });
  assert.throws(() => reduce([foreign]), /invalid_profile_event/);
  const wrongDomain = profileEvent({ domain: "another-domain" });
  assert.throws(() => reduce([wrongDomain]), /invalid_profile_event/);
});
