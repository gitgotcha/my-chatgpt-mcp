import assert from "node:assert/strict";
import test from "node:test";
import {
  genericProfileReducer,
  reduceGenericProfile,
  selectMemberReadPrefix
} from "../src/rds2/projection/generic-profile.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const IDENTITY = { userId: USER_ID, username: "乔炳源" };
const DOMAIN = "english-learning";
let sequence = 0;

function at(minutes) {
  return new Date(Date.parse("2026-09-01T10:00:00.000Z") + minutes * 60000).toISOString();
}

function event(overrides = {}) {
  sequence += 1;
  const id = `11111111-1111-4111-8111-${String(sequence).padStart(12, "0")}`;
  return {
    schemaVersion: "1.0",
    eventId: id,
    eventKey: `english-learning:event:${sequence}`,
    observedAt: at(sequence),
    sourceSkill: "algorithm-learning",
    action: "observe",
    observations: [{
      dimensionKey: "topic",
      subjectKey: "arrays",
      outcome: "stuck",
      evidence: "无法完成双指针实现",
      confidence: "high",
      sourceRef: "conversation:1"
    }],
    userId: USER_ID,
    username: "乔炳源",
    domain: DOMAIN,
    ...overrides
  };
}

test("T11 generic reducer accepts multiple observations and declares bounded member reads", () => {
  const input = event({
    observations: [
      { dimensionKey: "topic", subjectKey: "arrays", outcome: "stuck", evidence: "a", confidence: "high", sourceRef: "conversation:1" },
      { dimensionKey: "topic", subjectKey: "hash", outcome: "consulted", evidence: "b", confidence: "medium", sourceRef: "conversation:1" }
    ]
  });
  const plan = genericProfileReducer.planPageReads({ events: [input] });
  assert.deepEqual(plan.reads, [{
    rowKind: "member",
    rowKeys: ["topic\u0000arrays", "topic\u0000hash"]
  }]);
  const snapshot = reduceGenericProfile([input], { identity: IDENTITY, domain: DOMAIN });
  assert.equal(snapshot.openWeaknesses.length, 1);
  assert.equal(snapshot.observations.length, 1);
});

test("T11 observe, supersede and invalidate preserve the V1 active-event semantics", () => {
  const original = event({ eventKey: "original" });
  const replacement = event({
    eventKey: "replacement",
    observedAt: at(10),
    action: "supersede",
    targetEventKey: original.eventKey,
    observations: [{
      dimensionKey: "topic", subjectKey: "arrays", outcome: "correct",
      evidence: "完成实现", confidence: "high", sourceRef: "quiz:1"
    }]
  });
  const invalidation = event({
    eventKey: "invalidation",
    observedAt: at(20),
    action: "invalidate",
    targetEventKey: replacement.eventKey,
    observations: []
  });
  const snapshot = reduceGenericProfile([invalidation, replacement, original], {
    identity: IDENTITY, domain: DOMAIN
  });
  assert.deepEqual(snapshot.openWeaknesses, []);
  assert.deepEqual(snapshot.stableStrengths, []);
  assert.deepEqual(snapshot.observations, []);
  assert.deepEqual(snapshot.sourceEventKeys, ["invalidation", "original", "replacement"]);
});

test("T11 corrections reject missing, inactive, non-later and cross-domain targets with stable codes", () => {
  const missing = event({ action: "invalidate", observations: [], targetEventKey: "missing" });
  assert.throws(() => reduceGenericProfile([missing], { identity: IDENTITY, domain: DOMAIN }),
    (error) => error.code === "target_event_not_found");

  const original = event({ eventKey: "original" });
  const first = event({ eventKey: "first", observedAt: at(10), action: "invalidate", observations: [], targetEventKey: "original" });
  const second = event({ eventKey: "second", observedAt: at(20), action: "invalidate", observations: [], targetEventKey: "original" });
  assert.throws(() => reduceGenericProfile([original, first, second], { identity: IDENTITY, domain: DOMAIN }),
    (error) => error.code === "target_event_inactive");

  const sameTime = event({ eventKey: "same", observedAt: original.observedAt, action: "invalidate", observations: [], targetEventKey: "original" });
  assert.throws(() => reduceGenericProfile([original, sameTime], { identity: IDENTITY, domain: DOMAIN }),
    (error) => error.code === "invalid_profile_event");

  const foreign = event({ userId: "22222222-2222-4222-8222-222222222222" });
  assert.throws(() => reduceGenericProfile([foreign], { identity: IDENTITY, domain: DOMAIN }),
    (error) => error.code === "invalid_profile_event");
});

test("T11 two distinct positive sources close a negative, while one source does not", () => {
  const negative = event({ eventKey: "negative", observedAt: at(1) });
  const first = event({ eventKey: "positive-1", observedAt: at(10), observations: [{
    dimensionKey: "topic", subjectKey: "arrays", outcome: "correct", evidence: "a", confidence: "high", sourceRef: "conversation:2"
  }] });
  const second = event({ eventKey: "positive-2", observedAt: at(20), observations: [{
    dimensionKey: "topic", subjectKey: "arrays", outcome: "passed", evidence: "b", confidence: "high", sourceRef: "quiz:2"
  }] });
  const oneSource = reduceGenericProfile([negative, first, { ...second, eventKey: "positive-2-same", observations: [{ ...second.observations[0], sourceRef: "conversation:2" }] }], { identity: IDENTITY, domain: DOMAIN });
  assert.equal(oneSource.stableStrengths.length, 0);
  const twoSources = reduceGenericProfile([negative, first, second], { identity: IDENTITY, domain: DOMAIN });
  assert.equal(twoSources.stableStrengths.length, 1);
  assert.equal(twoSources.openWeaknesses.length, 0);
});

test("T11 removing an earlier negative changes the affected member classification", () => {
  const negative = event({ eventKey: "negative" });
  const positive = event({ eventKey: "positive", observedAt: at(10), observations: [{
    dimensionKey: "topic", subjectKey: "arrays", outcome: "correct", evidence: "ok", confidence: "high", sourceRef: "quiz:1"
  }] });
  const before = reduceGenericProfile([negative, positive], { identity: IDENTITY, domain: DOMAIN });
  assert.equal(before.openWeaknesses.length, 1);
  const invalidate = event({ eventKey: "invalidate-negative", observedAt: at(20), action: "invalidate", targetEventKey: "negative", observations: [] });
  const after = reduceGenericProfile([negative, positive, invalidate], { identity: IDENTITY, domain: DOMAIN });
  assert.equal(after.openWeaknesses.length, 0);
  assert.equal(after.observations.length, 1);
});

test("T11 out-of-order input is deep-equal to the V1-stable result", () => {
  const first = event({ eventKey: "first", observedAt: at(1) });
  const second = event({ eventKey: "second", observedAt: at(2), observations: [{
    dimensionKey: "topic", subjectKey: "arrays", outcome: "partial", evidence: "一半", confidence: "medium", sourceRef: "conversation:2"
  }] });
  const third = event({ eventKey: "third", observedAt: at(3), observations: [{
    dimensionKey: "topic", subjectKey: "hash", outcome: "consulted", evidence: "了解", confidence: "low", sourceRef: "conversation:3"
  }] });
  const expected = reduceGenericProfile([first, second, third], { identity: IDENTITY, domain: DOMAIN });
  assert.deepEqual(
    reduceGenericProfile([third, first, second], { identity: IDENTITY, domain: DOMAIN }),
    expected
  );
});

test("T11 member-read planning consumes a complete event prefix at the 50-key boundary", () => {
  const many = event({
    eventKey: "many",
    observations: Array.from({ length: 50 }, (_, index) => ({
      dimensionKey: "topic",
      subjectKey: `member-${String(index).padStart(2, "0")}`,
      outcome: "observed",
      evidence: "ok",
      confidence: "low",
      sourceRef: "conversation:many"
    }))
  });
  const next = event({
    eventKey: "next",
    observations: [{
      dimensionKey: "topic", subjectKey: "member-50", outcome: "observed",
      evidence: "ok", confidence: "low", sourceRef: "conversation:next"
    }]
  });
  const selected = selectMemberReadPrefix([many, next]);
  assert.equal(selected.consumedCount, 1);
  assert.equal(selected.keys.length, 50);
  assert.equal(genericProfileReducer.planPageReads({ events: [many, next] }).consumedCount, 1);
});
