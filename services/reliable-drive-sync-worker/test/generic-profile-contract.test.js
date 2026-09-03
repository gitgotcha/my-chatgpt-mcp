import assert from "node:assert/strict";
import test from "node:test";
import {
  GENERIC_PROFILE_SCHEMA_VERSION,
  GENERIC_PROFILE_ACTIONS,
  GENERIC_PROFILE_OUTCOMES,
  GENERIC_PROFILE_CONFIDENCES,
  GENERIC_PROFILE_RESERVED_DOMAINS,
  genericProfileEnabled,
  validateGenericProfileDomain,
  validateGenericProfileEvent
} from "../src/generic-profile-contract.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";

function callerEvent(overrides = {}) {
  return {
    schemaVersion: "1.0",
    eventId: "11111111-1111-4111-8111-111111111111",
    eventKey: "english-learning:vocabulary:concurrency:2026-09-01:1",
    observedAt: "2026-09-01T10:00:00.000Z",
    sourceSkill: "english-learning",
    action: "observe",
    observations: [{
      dimensionKey: "vocabulary",
      subjectKey: "concurrency",
      outcome: "stuck",
      evidence: "用户无法解释 concurrency 的含义。",
      confidence: "high",
      sourceRef: "conversation:2026-09-01:turn-18"
    }],
    ...overrides
  };
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

test("genericProfileEnabled is true only for the exact string true", () => {
  assert.equal(genericProfileEnabled({ GENERIC_PROFILE_ENABLED: "true" }), true);
  assert.equal(genericProfileEnabled({ GENERIC_PROFILE_ENABLED: "false" }), false);
  assert.equal(genericProfileEnabled({ GENERIC_PROFILE_ENABLED: "" }), false);
  assert.equal(genericProfileEnabled({ GENERIC_PROFILE_ENABLED: "TRUE" }), false);
  assert.equal(genericProfileEnabled({ GENERIC_PROFILE_ENABLED: "1" }), false);
  assert.equal(genericProfileEnabled({}), false);
  assert.equal(genericProfileEnabled(), false);
});

test("contract constants are frozen and complete", () => {
  assert.equal(GENERIC_PROFILE_SCHEMA_VERSION, "1.0");
  assert.deepEqual([...GENERIC_PROFILE_ACTIONS], ["observe", "supersede", "invalidate"]);
  assert.deepEqual([...GENERIC_PROFILE_OUTCOMES], [
    "observed", "consulted", "stuck", "incorrect", "partial",
    "completed", "correct", "passed", "failed"
  ]);
  assert.deepEqual([...GENERIC_PROFILE_CONFIDENCES], ["high", "medium", "low"]);
  assert.deepEqual([...GENERIC_PROFILE_RESERVED_DOMAINS], [
    "algorithm", "interview", "resume-knowledge", "system", "profile"
  ]);
  for (const frozen of [GENERIC_PROFILE_ACTIONS, GENERIC_PROFILE_OUTCOMES, GENERIC_PROFILE_CONFIDENCES, GENERIC_PROFILE_RESERVED_DOMAINS]) {
    assert.ok(Object.isFrozen(frozen));
  }
});

test("validateGenericProfileDomain accepts a well-formed generic domain", () => {
  assert.equal(validateGenericProfileDomain("english-learning"), "english-learning");
  assert.equal(validateGenericProfileDomain("ab"), "ab");
  assert.equal(validateGenericProfileDomain("a".repeat(64)), "a".repeat(64));
  assert.equal(validateGenericProfileDomain("a1-b2"), "a1-b2");
});

test("validateGenericProfileDomain rejects every reserved domain", () => {
  for (const domain of ["algorithm", "interview", "resume-knowledge", "system", "profile"]) {
    assert.throws(() => validateGenericProfileDomain(domain), /invalid_domain/);
  }
});

test("validateGenericProfileDomain rejects malformed and traversal domains", () => {
  for (const domain of [
    "A", "English-Learning", "-english", "english-", "a", "a".repeat(65),
    "english_learning", "english.learning", "english/learning", "english\\learning",
    "english%2flearning", "english%5clearning", "../interview", "..", ".", "",
    null, undefined, 42, {}
  ]) {
    assert.throws(() => validateGenericProfileDomain(domain), /invalid_domain/, `domain: ${String(domain)}`);
  }
});

test("the exact caller event shape validates and is returned as a clone", () => {
  const event = callerEvent();
  const validated = validateGenericProfileEvent(event);
  assert.deepEqual(validated, event);
  validated.observations[0].evidence = "mutated";
  assert.equal(event.observations[0].evidence, "用户无法解释 concurrency 的含义。");
});

test("caller events may not carry server-owned identity or domain fields", () => {
  for (const extra of [
    { userId: USER_ID },
    { username: "乔炳源" },
    { domain: "english-learning" }
  ]) {
    assert.throws(() => validateGenericProfileEvent(callerEvent(extra)), /invalid_profile_event/);
  }
});

test("unknown or missing event fields are rejected", () => {
  assert.throws(() => validateGenericProfileEvent(callerEvent({ extra: 1 })), /invalid_profile_event/);
  for (const field of ["schemaVersion", "eventId", "eventKey", "observedAt", "sourceSkill", "action", "observations"]) {
    const event = callerEvent();
    delete event[field];
    assert.throws(() => validateGenericProfileEvent(event), /invalid_profile_event/, `missing ${field}`);
  }
  assert.throws(() => validateGenericProfileEvent(callerEvent({ schemaVersion: "1.2" })), /invalid_profile_event/);
});

test("invalid eventId, eventKey, observedAt and sourceSkill values are rejected", () => {
  assert.throws(() => validateGenericProfileEvent(callerEvent({ eventId: "not-a-uuid" })), /invalid_profile_event/);
  assert.throws(() => validateGenericProfileEvent(callerEvent({ eventKey: "   " })), /invalid_profile_event/);
  assert.throws(() => validateGenericProfileEvent(callerEvent({ eventKey: 42 })), /invalid_profile_event/);
  assert.throws(() => validateGenericProfileEvent(callerEvent({ observedAt: "2026-09-01 10:00:00" })), /invalid_profile_event/);
  assert.throws(() => validateGenericProfileEvent(callerEvent({ observedAt: "2026-13-01T10:00:00.000Z" })), /invalid_profile_event/);
  assert.throws(() => validateGenericProfileEvent(callerEvent({ sourceSkill: " " })), /invalid_profile_event/);
});

test("every allowed outcome and confidence is accepted", () => {
  for (const outcome of GENERIC_PROFILE_OUTCOMES) {
    validateGenericProfileEvent(callerEvent({ observations: [observation({ outcome })] }));
  }
  for (const confidence of GENERIC_PROFILE_CONFIDENCES) {
    validateGenericProfileEvent(callerEvent({ observations: [observation({ confidence })] }));
  }
});

test("unknown outcome and confidence values are rejected", () => {
  assert.throws(() => validateGenericProfileEvent(callerEvent({
    observations: [observation({ outcome: "mastered" })]
  })), /invalid_profile_event/);
  assert.throws(() => validateGenericProfileEvent(callerEvent({
    observations: [observation({ confidence: "certain" })]
  })), /invalid_profile_event/);
});

test("observation field rules are enforced exactly", () => {
  assert.throws(() => validateGenericProfileEvent(callerEvent({
    observations: [observation({ extra: 1 })]
  })), /invalid_profile_event/);
  const missing = observation();
  delete missing.sourceRef;
  assert.throws(() => validateGenericProfileEvent(callerEvent({ observations: [missing] })), /invalid_profile_event/);
  for (const field of ["dimensionKey", "subjectKey", "evidence", "sourceRef"]) {
    assert.throws(() => validateGenericProfileEvent(callerEvent({
      observations: [observation({ [field]: "  " })]
    })), /invalid_profile_event/, `blank ${field}`);
    assert.throws(() => validateGenericProfileEvent(callerEvent({
      observations: [observation({ [field]: 7 })]
    })), /invalid_profile_event/, `non-string ${field}`);
  }
  assert.throws(() => validateGenericProfileEvent(callerEvent({ observations: "not-an-array" })), /invalid_profile_event/);
  assert.throws(() => validateGenericProfileEvent(callerEvent({ observations: [null] })), /invalid_profile_event/);
});

test("observe requires observations and forbids targetEventKey", () => {
  assert.throws(() => validateGenericProfileEvent(callerEvent({ observations: [] })), /invalid_profile_event/);
  assert.throws(() => validateGenericProfileEvent(callerEvent({ targetEventKey: "english-learning:vocabulary:concurrency:2026-09-01:1" })), /invalid_profile_event/);
});

test("supersede requires observations and a non-empty targetEventKey", () => {
  const target = "english-learning:vocabulary:concurrency:2026-09-01:1";
  validateGenericProfileEvent(callerEvent({ action: "supersede", targetEventKey: target }));
  assert.throws(() => validateGenericProfileEvent(callerEvent({ action: "supersede", targetEventKey: target, observations: [] })), /invalid_profile_event/);
  assert.throws(() => validateGenericProfileEvent(callerEvent({ action: "supersede" })), /invalid_profile_event/);
  assert.throws(() => validateGenericProfileEvent(callerEvent({ action: "supersede", targetEventKey: "  " })), /invalid_profile_event/);
  assert.throws(() => validateGenericProfileEvent(callerEvent({ action: "supersede", targetEventKey: 5 })), /invalid_profile_event/);
});

test("invalidate requires empty observations and a non-empty targetEventKey", () => {
  const target = "english-learning:vocabulary:concurrency:2026-09-01:1";
  validateGenericProfileEvent(callerEvent({ action: "invalidate", targetEventKey: target, observations: [] }));
  assert.throws(() => validateGenericProfileEvent(callerEvent({ action: "invalidate", targetEventKey: target })), /invalid_profile_event/);
  assert.throws(() => validateGenericProfileEvent(callerEvent({ action: "invalidate", targetEventKey: target, observations: [observation()] })), /invalid_profile_event/);
  assert.throws(() => validateGenericProfileEvent(callerEvent({ action: "invalidate", observations: [] })), /invalid_profile_event/);
  assert.throws(() => validateGenericProfileEvent(callerEvent({ action: "explode", targetEventKey: target, observations: [] })), /invalid_profile_event/);
});

test("bound validation requires both options together", () => {
  const boundIdentity = { userId: USER_ID, username: "乔炳源" };
  assert.throws(() => validateGenericProfileEvent(callerEvent(), { boundIdentity }), /invalid_profile_event/);
  assert.throws(() => validateGenericProfileEvent(callerEvent(), { domain: "english-learning" }), /invalid_profile_event/);
});

test("bound validation accepts the exact server-owned fields", () => {
  const boundIdentity = { userId: USER_ID, username: "乔炳源" };
  const event = callerEvent({ userId: USER_ID, username: "乔炳源", domain: "english-learning" });
  assert.deepEqual(validateGenericProfileEvent(event, { boundIdentity, domain: "english-learning" }), event);
});

test("bound validation rejects mismatched and malformed identity binding", () => {
  const boundIdentity = { userId: USER_ID, username: "乔炳源" };
  const base = { userId: USER_ID, username: "乔炳源", domain: "english-learning" };
  assert.throws(() => validateGenericProfileEvent(callerEvent(base), {
    boundIdentity: { userId: "22222222-2222-4222-8222-222222222222", username: "乔炳源" },
    domain: "english-learning"
  }), /invalid_profile_event/);
  assert.throws(() => validateGenericProfileEvent(callerEvent(base), {
    boundIdentity: { userId: USER_ID, username: "别人" },
    domain: "english-learning"
  }), /invalid_profile_event/);
  assert.throws(() => validateGenericProfileEvent(callerEvent(base), {
    boundIdentity: { userId: "not-a-uuid", username: "乔炳源" },
    domain: "english-learning"
  }), /invalid_profile_event/);
  assert.throws(() => validateGenericProfileEvent(callerEvent(base), {
    boundIdentity: { userId: USER_ID, username: "  " },
    domain: "english-learning"
  }), /invalid_profile_event/);
});

test("bound validation surfaces invalid_domain from the domain option", () => {
  const boundIdentity = { userId: USER_ID, username: "乔炳源" };
  const event = callerEvent({ userId: USER_ID, username: "乔炳源", domain: "algorithm" });
  assert.throws(() => validateGenericProfileEvent(event, { boundIdentity, domain: "algorithm" }), /invalid_domain/);
});
