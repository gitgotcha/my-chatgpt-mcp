import test from "node:test";
import assert from "node:assert/strict";
import {
  classifySubmission,
  validateQuery,
  canonicalJson,
  hashJson,
  envelopeHashOf,
  contentHashOf,
  businessKeyFor,
  decideIntent,
  BUSINESS_KEY_EVENT_TYPES
} from "../../../shared/rds2-protocol.mjs";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const NAME = "乔炳源";

function envelope(overrides = {}) {
  return {
    schemaVersion: "1.2",
    namespace: "system",
    eventType: "system.user-registered",
    identity: { username: NAME, userId: USER },
    payload: { displayName: NAME, userId: USER, username: NAME },
    requestId: "r6-t01-request",
    ...overrides
  };
}

function algorithmEvent(overrides = {}) {
  return {
    schemaVersion: "1.2",
    eventId: "44444444-4444-4444-8444-444444444444",
    eventKey: `${USER}:algorithm-learning:two-sum:2026-08-14T10:00:00.000Z`,
    eventType: "algorithm.learning.completed",
    userId: USER,
    username: NAME,
    observedAt: "2026-08-14T10:00:00.000Z",
    source: "qa",
    topic: "two-sum",
    problem: { title: "Two Sum", source: "Hot100", url: "" },
    outcome: "consulted",
    evidence: "用户请求讲解两数之和。",
    tags: ["hash-map"],
    confidence: "medium",
    ...overrides
  };
}

function sessionEvent(overrides = {}) {
  const sessionId = "MOCK-20260814T000000Z-44444444-4444-4444-8444-444444444444";
  return {
    schemaVersion: "1.2",
    eventId: "22222222-2222-4222-8222-222222222222",
    eventKey: `${USER}:interview:session:${sessionId}:v1`,
    eventType: "interview.session.completed",
    userId: USER,
    username: NAME,
    sessionId,
    interviewType: "mock",
    domain: "java-backend",
    startedAt: "2026-08-14T00:00:00.000Z",
    completedAt: "2026-08-14T00:30:00.000Z",
    status: "review_pending",
    resumeContext: { used: false, source: "current_conversation", claims: [] },
    questions: [],
    ...overrides
  };
}

function reviewEvent(overrides = {}) {
  const sessionId = "MOCK-20260814T000000Z-44444444-4444-4444-8444-444444444444";
  return {
    schemaVersion: "1.2",
    eventId: "33333333-3333-4333-8333-333333333333",
    eventKey: `${USER}:interview:review:${sessionId}:v1`,
    eventType: "interview.review.completed",
    userId: USER,
    username: NAME,
    sessionId,
    interviewType: "mock",
    domain: "java-backend",
    reviewVersion: 1,
    sourceSessionEventId: "22222222-2222-4222-8222-222222222222",
    sourceType: "mock",
    evidenceType: "full_transcript",
    evidenceConfidence: "high",
    questionReviews: [],
    profileChanges: [],
    recommendations: ["复测并发基础"],
    applyProfileChanges: true,
    completedAt: "2026-08-14T01:00:00.000Z",
    ...overrides
  };
}

function resumeIngested(overrides = {}) {
  return {
    schemaVersion: "1.2",
    eventId: "a0000000-0000-4000-8000-000000000001",
    eventKey: `${USER}:resume:resume-2026-08-30-a`,
    eventType: "resume-knowledge.resume-ingested",
    userId: USER,
    username: NAME,
    resumeVersion: "resume-2026-08-30-a",
    fingerprint: "sha256-def456",
    activatedAt: "2026-08-30T00:00:00.000Z",
    claims: [{ claimId: "claim-redis", evidence: "explicit" }],
    claimRelations: [],
    techTags: ["Redis"],
    evidenceLocations: [{ claimId: "claim-redis", location: "项目经历 · 订单缓存" }],
    ...overrides
  };
}

function resumeClaim(eventType, overrides = {}) {
  return {
    schemaVersion: "1.2",
    eventId: "a0000000-0000-4000-8000-00000000000b",
    eventKey: `${USER}:claim:claim-redis`,
    eventType,
    userId: USER,
    username: NAME,
    resumeVersion: "resume-2026-08-30-a",
    claimId: "claim-redis",
    decidedAt: "2026-08-30T02:00:00.000Z",
    ...overrides
  };
}

function bankQuestion(overrides = {}) {
  return {
    questionKey: "redis-cache-penetration",
    knowledgePointId: "redis",
    evidence: "explicit",
    type: "principle",
    prompt: "什么是缓存穿透？如何解决？",
    answerChain: ["定义", "核心机制", "关键流程"],
    scoringPoints: ["布隆过滤器", "空值缓存"],
    referenceAnswer: "缓存穿透指查询不存在的数据……",
    resumeEvidenceRefs: ["claim-redis"],
    conditional: false,
    confirmed: false,
    masteryScore: null,
    lastScoredLocalDate: null,
    ...overrides
  };
}

function answerScored(overrides = {}) {
  return {
    schemaVersion: "1.2",
    eventId: "a0000000-0000-4000-8000-000000000004",
    eventKey: `${USER}:answer:2026-08-30:redis-cache-penetration:v1`,
    eventType: "resume-knowledge.answer-scored",
    userId: USER,
    username: NAME,
    questionKey: "redis-cache-penetration",
    localDate: "2026-08-30",
    resumeVersion: "resume-2026-08-30-a",
    scoredAt: "2026-08-30T02:00:00.000Z",
    scores: { correctness: 28, completeness: 17.5, structure: 14, resumeRelevance: 10.5 },
    total: 70,
    feedback: {
      strengths: ["说出了布隆过滤器"],
      issues: ["遗漏空值缓存"],
      issueCategories: ["关键点遗漏"],
      answerChain: ["定义", "核心机制", "关键流程"],
      referenceAnswer: "缓存穿透指查询不存在的数据……"
    },
    ...overrides
  };
}

function resumePlan(overrides = {}) {
  return {
    schemaVersion: "1.2",
    eventId: "a0000000-0000-4000-8000-000000000003",
    eventKey: `${USER}:daily-plan:2026-08-30`,
    eventType: "resume-knowledge.daily-plan-created",
    userId: USER,
    username: NAME,
    resumeVersion: "resume-2026-08-30-a",
    localDate: "2026-08-30",
    planId: "plan-2026-08-30",
    timezone: "Asia/Shanghai",
    generatedAt: "2026-08-30T01:00:00.000Z",
    items: [{
      questionKey: "redis-cache-penetration",
      slot: "untested-explicit",
      knowledgePointId: "redis",
      evidence: "explicit",
      type: "principle",
      prompt: "什么是缓存穿透？如何解决？"
    }],
    ...overrides
  };
}

function algorithmPlan(overrides = {}) {
  return {
    schemaVersion: "1.2",
    eventId: "55555555-5555-4555-8555-555555555555",
    eventKey: `${USER}:algorithm-plan:2026-08-14`,
    eventType: "algorithm.daily-plan-created",
    userId: USER,
    username: NAME,
    localDate: "2026-08-14",
    planId: "plan-2026-08-14",
    timezone: "Asia/Shanghai",
    generatedAt: "2026-08-14T01:00:00.000Z",
    items: [],
    ...overrides
  };
}

function profileEvidence(overrides = {}) {
  return {
    schemaVersion: "1.2",
    namespace: "profile",
    eventType: "profile.evidence.recorded",
    identity: { username: NAME, userId: USER },
    payload: {
      domain: "english-learning",
      event: {
        schemaVersion: "1.0",
        eventId: "30000000-0000-4000-8000-000000000001",
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
          sourceRef: "conversation:2026-09-01:turn-1"
        }]
      }
    },
    requestId: "r6-profile-evidence",
    ...overrides
  };
}

function submissionFor(eventType) {
  switch (eventType) {
    case "system.user-registered":
      return envelope();
    case "system.legacy-migration-requested":
      return envelope({
        eventType,
        payload: { displayName: NAME, mode: "dry-run" }
      });
    case "system.capabilities.read":
      return envelope({ eventType, payload: {}, requestId: "r6-capabilities" });
    case "system.user.resolve":
      return envelope({ eventType, payload: { displayName: NAME }, requestId: "r6-resolve" });
    case "algorithm.learning.completed":
      return envelope({ namespace: "algorithm", eventType, payload: { event: algorithmEvent() } });
    case "algorithm.daily-plan-created":
      return envelope({ namespace: "algorithm", eventType, payload: { event: algorithmPlan() } });
    case "interview.session.list":
      return envelope({ namespace: "interview", eventType, payload: {}, requestId: "r6-list" });
    case "interview.session.load":
      return envelope({
        namespace: "interview", eventType,
        payload: { sessionId: "MOCK-20260814T000000Z-44444444-4444-4444-8444-444444444444" },
        requestId: "r6-load"
      });
    case "interview.session.completed":
      return envelope({ namespace: "interview", eventType, payload: { event: sessionEvent() } });
    case "interview.review.completed":
      return envelope({ namespace: "interview", eventType, payload: { event: reviewEvent() } });
    case "resume-knowledge.resume-ingested":
      return envelope({ namespace: "resume-knowledge", eventType, payload: { event: resumeIngested() } });
    case "resume-knowledge.claim-confirmed":
      return envelope({ namespace: "resume-knowledge", eventType, payload: { event: resumeClaim(eventType) } });
    case "resume-knowledge.claim-rejected":
      return envelope({ namespace: "resume-knowledge", eventType, payload: { event: resumeClaim(eventType) } });
    case "resume-knowledge.question-bank-created":
      return envelope({
        namespace: "resume-knowledge", eventType,
        payload: {
          event: {
            schemaVersion: "1.2",
            eventId: "a0000000-0000-4000-8000-000000000002",
            eventKey: `${USER}:question-bank:resume-2026-08-30-a`,
            eventType,
            userId: USER,
            username: NAME,
            resumeVersion: "resume-2026-08-30-a",
            generatedAt: "2026-08-30T01:00:00.000Z",
            questions: [bankQuestion()]
          }
        }
      });
    case "resume-knowledge.daily-plan-created":
      return envelope({ namespace: "resume-knowledge", eventType, payload: { event: resumePlan() } });
    case "resume-knowledge.answer-scored":
      return envelope({ namespace: "resume-knowledge", eventType, payload: { event: answerScored() } });
    case "profile.evidence.recorded":
      return profileEvidence();
    case "profile.snapshot.read":
      return envelope({
        namespace: "profile", eventType,
        payload: { domain: "english-learning" },
        requestId: "r6-profile-read"
      });
    default:
      throw new Error(`unknown event type ${eventType}`);
  }
}

const KIND_BY_TYPE = {
  "system.user-registered": "adminOnly",
  "system.legacy-migration-requested": "disabled",
  "system.capabilities.read": "read",
  "system.user.resolve": "read",
  "algorithm.learning.completed": "write",
  "algorithm.daily-plan-created": "write",
  "interview.session.list": "read",
  "interview.session.load": "read",
  "interview.session.completed": "write",
  "interview.review.completed": "write",
  "resume-knowledge.resume-ingested": "write",
  "resume-knowledge.claim-confirmed": "write",
  "resume-knowledge.claim-rejected": "write",
  "resume-knowledge.question-bank-created": "write",
  "resume-knowledge.daily-plan-created": "write",
  "resume-knowledge.answer-scored": "write",
  "profile.evidence.recorded": "write",
  "profile.snapshot.read": "read"
};

function firstInvalidMutation(eventType) {
  switch (eventType) {
    case "system.user-registered":
      return { payload: { displayName: "" } };
    case "system.legacy-migration-requested":
      return { payload: { displayName: NAME, mode: "execute" } };
    case "system.capabilities.read":
      return { payload: { unexpected: true } };
    case "system.user.resolve":
      return { payload: { username: NAME } };
    case "algorithm.learning.completed":
      return { payload: { event: algorithmEvent({ outcome: "skipped" }) } };
    case "algorithm.daily-plan-created":
      return { payload: { event: algorithmPlan({ planId: "bad id!" }) } };
    case "interview.session.list":
      return { payload: { unexpected: true } };
    case "interview.session.load":
      return { payload: { sessionId: "../escape" } };
    case "interview.session.completed":
      return { payload: { event: sessionEvent({ status: "done" }) } };
    case "interview.review.completed":
      return { payload: { event: reviewEvent({ reviewVersion: 0 }) } };
    case "resume-knowledge.resume-ingested":
      return { payload: { event: resumeIngested({ claims: [{ claimId: "c", evidence: "guessed" }] }) } };
    case "resume-knowledge.claim-confirmed":
      return { payload: { event: resumeClaim(eventType, { claimId: "bad id!" }) } };
    case "resume-knowledge.claim-rejected":
      return { payload: { event: resumeClaim(eventType, { decidedAt: "not-a-time" }) } };
    case "resume-knowledge.question-bank-created":
      return { payload: { event: { schemaVersion: "1.2", eventId: "a0000000-0000-4000-8000-000000000002", eventKey: "k", eventType, userId: USER, username: NAME, resumeVersion: "resume-2026-08-30-a", generatedAt: "2026-08-30T01:00:00.000Z", questions: [bankQuestion({ type: "essay" })] } } };
    case "resume-knowledge.daily-plan-created":
      return { payload: { event: resumePlan({ items: [{ questionKey: "redis-cache-penetration", slot: "nonexistent-slot" }] }) } };
    case "resume-knowledge.answer-scored":
      return { payload: { event: answerScored({ total: 55 }) } };
    case "profile.evidence.recorded":
      return { payload: { domain: "algorithm", event: profileEvidence().payload.event } };
    case "profile.snapshot.read":
      return { payload: { domain: "algorithm" } };
    default:
      throw new Error(`unknown event type ${eventType}`);
  }
}

test("every existing event type classifies with a legal and an illegal sample", () => {
  const types = Object.keys(KIND_BY_TYPE);
  assert.equal(types.length, 18);
  for (const eventType of types) {
    const valid = classifySubmission(submissionFor(eventType));
    assert.equal(valid.kind, KIND_BY_TYPE[eventType], `classification of ${eventType}`);
    assert.throws(() => classifySubmission(submissionFor(eventType) && {
      ...submissionFor(eventType), ...firstInvalidMutation(eventType)
    }), Error, `invalid sample for ${eventType} must be rejected`);
  }
});

test("resolve uses displayName and never becomes a write", () => {
  const input = {
    schemaVersion: "1.2", namespace: "system", requestId: "r6-resolve-test",
    eventType: "system.user.resolve", payload: { displayName: "乔炳源" }
  };
  assert.equal(classifySubmission(input).kind, "read");
  assert.throws(() => classifySubmission({ ...input, payload: { username: "乔炳源" } }));
});

test("adminOnly and disabled system submissions never touch payload.event", () => {
  const registered = classifySubmission(envelope());
  assert.equal(registered.kind, "adminOnly");
  assert.equal(registered.envelope.payload.event, undefined);
  const migration = classifySubmission(envelope({
    eventType: "system.legacy-migration-requested",
    payload: { displayName: NAME, mode: "dry-run" }
  }));
  assert.equal(migration.kind, "disabled");
  assert.equal(migration.envelope.payload.event, undefined);
});

test("classifySubmission rejects malformed envelopes with V1 error codes", () => {
  assert.throws(() => classifySubmission(envelope({ schemaVersion: "1.1" })), (error) => error.message === "invalid_schema_version");
  assert.throws(() => classifySubmission(envelope({ namespace: "algorithm" })), (error) => error.message === "invalid_event_type");
  assert.throws(() => classifySubmission(envelope({ requestId: "" })), (error) => error.message === "invalid_request_id");
});

test("key order does not change hashes and requestId only moves the envelope hash", async () => {
  const base = submissionFor("algorithm.learning.completed");
  const reordered = {
    requestId: base.requestId,
    payload: { event: { ...base.payload.event, tags: base.payload.event.tags } },
    identity: { ...base.identity },
    eventType: base.eventType,
    namespace: base.namespace,
    schemaVersion: base.schemaVersion
  };
  reordered.payload.event = {
    confidence: base.payload.event.confidence,
    tags: base.payload.event.tags,
    evidence: base.payload.event.evidence,
    outcome: base.payload.event.outcome,
    problem: { url: base.payload.event.problem.url, source: base.payload.event.problem.source, title: base.payload.event.problem.title },
    topic: base.payload.event.topic,
    source: base.payload.event.source,
    observedAt: base.payload.event.observedAt,
    username: base.payload.event.username,
    userId: base.payload.event.userId,
    eventKey: base.payload.event.eventKey,
    eventType: base.payload.event.eventType,
    eventId: base.payload.event.eventId,
    schemaVersion: base.payload.event.schemaVersion
  };
  assert.notEqual(JSON.stringify(Object.keys(reordered)), JSON.stringify(Object.keys(base)));
  assert.notEqual(JSON.stringify(Object.keys(reordered.payload.event)), JSON.stringify(Object.keys(base.payload.event)));
  assert.equal(await hashJson(base), await hashJson(reordered));
  assert.equal(await contentHashOf(base), await contentHashOf(reordered));
  const newRequestId = { ...base, requestId: "r6-t01-other-request" };
  assert.equal(await contentHashOf(newRequestId), await contentHashOf(base));
  assert.notEqual(await envelopeHashOf(newRequestId), await envelopeHashOf(base));
});

test("canonicalJson keeps array order and rejects non-JSON values", () => {
  assert.equal(canonicalJson({ b: 2, a: [1, 2] }), canonicalJson({ a: [1, 2], b: 2 }));
  assert.equal(canonicalJson({ a: 1 }), '{"a":1}');
  assert.throws(() => canonicalJson({ a: undefined }));
  assert.throws(() => canonicalJson({ a: () => 1 }));
  assert.throws(() => canonicalJson({ a: Number.NaN }));
  assert.throws(() => canonicalJson({ a: 1n }));
  const circular = {};
  circular.self = circular;
  assert.throws(() => canonicalJson(circular));
});

test("decideIntent replays the original request when envelope hash matches", () => {
  const rows = {
    request: { requestId: "r6-t01-request", envelopeHash: "h-request", canonicalEventId: "e-1" },
    eventById: null,
    eventByKey: null,
    businessKey: null
  };
  const decision = decideIntent(rows, {
    requestId: "r6-t01-request", eventId: "e-1", eventKey: "k-1",
    eventType: "algorithm.learning.completed",
    envelopeHash: "h-request", contentHash: "c-1",
    businessKeyConfigured: false
  });
  assert.equal(decision.outcome, "replay");
  assert.equal(decision.code, "already_recorded");
  assert.equal(decision.eventId, "e-1");
});

test("same requestId with different envelope conflicts", () => {
  const decision = decideIntent({
    request: { requestId: "r6-t01-request", envelopeHash: "h-request", canonicalEventId: "e-1" },
    eventById: null, eventByKey: null, businessKey: null
  }, {
    requestId: "r6-t01-request", eventId: "e-1", eventKey: "k-1",
    eventType: "algorithm.learning.completed",
    envelopeHash: "h-other", contentHash: "c-2", businessKeyConfigured: false
  });
  assert.equal(decision.outcome, "conflict");
  assert.equal(decision.code, "request_id_conflict");
});

test("event id alias records the submission against the original event", () => {
  const decision = decideIntent({
    request: null,
    eventById: { eventId: "e-1", contentHash: "c-1" },
    eventByKey: { eventId: "e-1", contentHash: "c-1" },
    businessKey: null
  }, {
    requestId: "r6-t01-new", eventId: "e-1", eventKey: "k-1",
    eventType: "algorithm.learning.completed",
    envelopeHash: "h-2", contentHash: "c-1", businessKeyConfigured: false
  });
  assert.equal(decision.outcome, "alias");
  assert.equal(decision.code, "already_recorded");
  assert.equal(decision.eventId, "e-1");
});

test("event id or key with different content conflicts", () => {
  const byId = decideIntent({
    request: null,
    eventById: { eventId: "e-1", contentHash: "c-1" },
    eventByKey: null, businessKey: null
  }, {
    requestId: "r6-t01-new", eventId: "e-1", eventKey: "k-2",
    eventType: "algorithm.learning.completed",
    envelopeHash: "h-2", contentHash: "c-9", businessKeyConfigured: false
  });
  assert.equal(byId.outcome, "conflict");
  assert.equal(byId.code, "event_id_conflict");

  const byKey = decideIntent({
    request: null, eventById: null,
    eventByKey: { eventId: "e-7", contentHash: "c-1" },
    businessKey: null
  }, {
    requestId: "r6-t01-new", eventId: "e-8", eventKey: "k-1",
    eventType: "algorithm.learning.completed",
    envelopeHash: "h-2", contentHash: "c-9", businessKeyConfigured: false
  });
  assert.equal(byKey.outcome, "conflict");
  assert.equal(byKey.code, "event_key_conflict");
});

test("four keys hitting different events always conflict as identity_of_intent_conflict", () => {
  const decision = decideIntent({
    request: { requestId: "r6-t01-request", envelopeHash: "h-request", canonicalEventId: "e-req" },
    eventById: { eventId: "e-id", contentHash: "c-id" },
    eventByKey: { eventId: "e-key", contentHash: "c-key" },
    businessKey: { eventId: "e-biz", contentHash: "c-biz" }
  }, {
    requestId: "r6-t01-request", eventId: "e-id", eventKey: "e-key",
    eventType: "resume-knowledge.answer-scored",
    envelopeHash: "h-request", contentHash: "c-id",
    businessKeyConfigured: true
  });
  assert.equal(decision.outcome, "conflict");
  assert.equal(decision.code, "identity_of_intent_conflict");
});

test("same-day duplicate only applies to configured scoring types", () => {
  assert.deepEqual([...BUSINESS_KEY_EVENT_TYPES], ["resume-knowledge.answer-scored"]);
  const rows = {
    request: null, eventById: null, eventByKey: null,
    businessKey: { eventId: "e-first", contentHash: "c-first" }
  };
  const scored = decideIntent(rows, {
    requestId: "r6-t01-second", eventId: "e-second", eventKey: "k-second",
    eventType: "resume-knowledge.answer-scored",
    envelopeHash: "h-2", contentHash: "c-2", businessKeyConfigured: true
  });
  assert.equal(scored.outcome, "firstResult");
  assert.equal(scored.code, "already_recorded");
  assert.equal(scored.ignoredDuplicate, true);
  assert.equal(scored.eventId, "e-first");

  const algorithm = decideIntent(rows, {
    requestId: "r6-t01-second", eventId: "e-second", eventKey: "k-second",
    eventType: "algorithm.learning.completed",
    envelopeHash: "h-2", contentHash: "c-2", businessKeyConfigured: false
  });
  assert.equal(algorithm.outcome, "new");
});

test("no matching rows decides a new submission", () => {
  const decision = decideIntent({
    request: null, eventById: null, eventByKey: null, businessKey: null
  }, {
    requestId: "r6-t01-new", eventId: "e-new", eventKey: "k-new",
    eventType: "algorithm.learning.completed",
    envelopeHash: "h-1", contentHash: "c-1", businessKeyConfigured: false
  });
  assert.equal(decision.outcome, "new");
  assert.equal(decision.code, null);
});

test("validateQuery accepts each documented operation", () => {
  assert.deepEqual(validateQuery({ storageVersion: 2, operation: "capabilities", params: {} }).operation, "capabilities");
  assert.deepEqual(validateQuery({ storageVersion: 2, operation: "user.resolve", params: { displayName: NAME } }).params.displayName, NAME);
  const projection = validateQuery({
    storageVersion: 2, operation: "projection.read",
    params: { namespace: "profile", projectionName: "english-learning", limit: 50, cursor: "c" }
  });
  assert.equal(projection.params.limit, 50);
  validateQuery({ storageVersion: 2, operation: "interview.session.list", params: {} });
  validateQuery({ storageVersion: 2, operation: "interview.session.list", params: { limit: 20 } });
  assert.equal(validateQuery({ storageVersion: 2, operation: "interview.session.load", params: { sessionId: "MOCK-x" } }).params.sessionId, "MOCK-x");
  validateQuery({ storageVersion: 2, operation: "event.status", params: { targetRequestId: "r6-1" } });
  validateQuery({ storageVersion: 2, operation: "event.status", params: { targetEventId: "e-1" } });
});

test("validateQuery rejects bad dto shapes with stable codes", () => {
  assert.throws(() => validateQuery({ storageVersion: 1, operation: "capabilities", params: {} }), (error) => error.code === "invalid_query_storage_version");
  assert.throws(() => validateQuery({ storageVersion: 2, operation: "capabilities.write", params: {} }), (error) => error.code === "invalid_query_operation");
  assert.throws(() => validateQuery({ storageVersion: 2, operation: "capabilities", params: { extra: 1 } }), (error) => error.code === "invalid_query_params");
  assert.throws(() => validateQuery({ storageVersion: 2, operation: "user.resolve", params: {} }), (error) => error.code === "invalid_query_params");
  assert.throws(() => validateQuery({ storageVersion: 2, operation: "user.resolve", params: { displayName: "" } }), (error) => error.code === "invalid_query_params");
  assert.throws(() => validateQuery({ storageVersion: 2, operation: "projection.read", params: { namespace: "profile" } }), (error) => error.code === "invalid_query_params");
  assert.throws(() => validateQuery({ storageVersion: 2, operation: "projection.read", params: { namespace: "profile", projectionName: "english-learning", limit: 51 } }), (error) => error.code === "invalid_query_params");
  assert.throws(() => validateQuery({ storageVersion: 2, operation: "interview.session.load", params: { sessionId: "MOCK-x", extra: 1 } }), (error) => error.code === "invalid_query_params");
  assert.throws(() => validateQuery({ storageVersion: 2, operation: "event.status", params: {} }), (error) => error.code === "invalid_query_params");
  assert.throws(() => validateQuery({ storageVersion: 2, operation: "event.status", params: { targetRequestId: "r6-1", targetEventId: "e-1" } }), (error) => error.code === "invalid_query_params");
  assert.throws(() => validateQuery({ storageVersion: 2, operation: "capabilities", params: {}, extra: 1 }), (error) => error.code === "invalid_query");
});

test("businessKey derivation binds server userId, event type, questionKey and localDate", async () => {
  const scored = submissionFor("resume-knowledge.answer-scored");
  const key = await businessKeyFor(scored, USER);
  assert.match(key, /^[0-9a-f]{64}$/);
  const otherUser = await businessKeyFor(scored, OTHER_USER);
  assert.notEqual(key, otherUser);
  const same = await businessKeyFor(
    submissionFor("resume-knowledge.answer-scored"),
    USER
  );
  assert.equal(key, same);
  const otherDay = await businessKeyFor({
    ...scored, payload: { event: answerScored({ localDate: "2026-08-31" }) }
  }, USER);
  assert.notEqual(key, otherDay);
  assert.equal(await businessKeyFor(submissionFor("algorithm.learning.completed"), USER), null);
});

// ---------------------------------------------------------------------------
// R8 regression: canonical JSON must reject sparse and self-referential
// arrays with controlled errors, and validateQuery must receive a real
// params object instead of patching null into {}.
// ---------------------------------------------------------------------------

test("R8 canonicalJson rejects sparse arrays with a controlled error", () => {
  assert.throws(() => canonicalJson(new Array(2)), (error) => error.message === "sparse_array");
  assert.throws(() => canonicalJson({ list: [1, , 3] }), (error) => error.message === "sparse_array");
});

test("R8 canonicalJson rejects self-referential and mixed cycles in arrays", () => {
  const selfLoop = [];
  selfLoop.push(selfLoop);
  assert.throws(() => canonicalJson(selfLoop), (error) => error.message === "circular_reference");
  const mixed = { items: [] };
  mixed.items.push(mixed);
  assert.throws(() => canonicalJson(mixed), (error) => error.message === "circular_reference");
  // A deeply nested but acyclic array stays representable.
  assert.equal(canonicalJson({ a: [[1, [2]], [{ b: 3 }]] }), canonicalJson({ a: [[1, [2]], [{ b: 3 }]] }));
});

test("R8 validateQuery rejects null, array and missing params objects", () => {
  assert.throws(() => validateQuery({ storageVersion: 2, operation: "capabilities", params: null }),
    (error) => error.code === "invalid_query_params");
  assert.throws(() => validateQuery({ storageVersion: 2, operation: "interview.session.list", params: null }),
    (error) => error.code === "invalid_query_params");
  assert.throws(() => validateQuery({ storageVersion: 2, operation: "capabilities", params: [1, 2] }),
    (error) => error.code === "invalid_query_params");
  assert.throws(() => validateQuery({ storageVersion: 2, operation: "capabilities", params: "nope" }),
    (error) => error.code === "invalid_query_params");
  // A present, empty params object remains the only accepted shape.
  assert.deepEqual(validateQuery({ storageVersion: 2, operation: "capabilities", params: {} }).params, {});
});

// ---------------------------------------------------------------------------
// R9 regression: decideIntent returns a uniform decision shape on every
// branch, and the replay branch never smuggles an eventId into the
// createdByRequest field. Classification tallies are asserted automatically.
// ---------------------------------------------------------------------------

test("R9 decideIntent returns a uniform decision shape on every branch", () => {
  const incoming = {
    requestId: "req-1", eventId: "e-1", eventKey: "k-1",
    eventType: "algorithm.learning.completed",
    envelopeHash: "h-1", contentHash: "c-1", businessKeyConfigured: false
  };
  const noRows = { request: null, eventById: null, eventByKey: null, businessKey: null };
  assert.deepEqual(decideIntent(noRows, incoming), {
    outcome: "new", code: null, eventId: "e-1", ignoredDuplicate: false, createdByRequest: null
  });

  const requestRows = {
    request: { requestId: "req-1", envelopeHash: "h-1", canonicalEventId: "e-1" },
    eventById: null, eventByKey: null, businessKey: null
  };
  const replay = decideIntent(requestRows, incoming);
  assert.deepEqual(replay, {
    outcome: "replay", code: "already_recorded", eventId: "e-1", ignoredDuplicate: false, createdByRequest: null
  });
  assert.notEqual(replay.createdByRequest, replay.eventId, "createdByRequest must never hold an eventId");

  const idRows = {
    request: null,
    eventById: { eventId: "e-1", contentHash: "c-1", createdByRequest: "req-0" },
    eventByKey: null, businessKey: null
  };
  const alias = decideIntent(idRows, incoming);
  assert.deepEqual(alias, {
    outcome: "alias", code: "already_recorded", eventId: "e-1", ignoredDuplicate: false, createdByRequest: "req-0"
  });
  assert.notEqual(alias.createdByRequest, alias.eventId);

  const conflict = decideIntent({
    request: null, eventById: { eventId: "e-1", contentHash: "c-other", createdByRequest: "req-0" },
    eventByKey: null, businessKey: null
  }, incoming);
  assert.deepEqual(conflict, {
    outcome: "conflict", code: "event_id_conflict", eventId: "e-1", ignoredDuplicate: false, createdByRequest: null
  });

  const firstResult = decideIntent({
    request: null, eventById: null, eventByKey: null,
    businessKey: { eventId: "e-first", contentHash: "c-first", createdByRequest: "req-first" }
  }, { ...incoming, eventType: "resume-knowledge.answer-scored", businessKeyConfigured: true });
  assert.deepEqual(firstResult, {
    outcome: "firstResult", code: "already_recorded", eventId: "e-first", ignoredDuplicate: true, createdByRequest: "req-first"
  });

  const identityConflict = decideIntent({
    request: { requestId: "req-1", envelopeHash: "h-1", canonicalEventId: "e-req" },
    eventById: { eventId: "e-1", contentHash: "c-1", createdByRequest: "req-0" },
    eventByKey: null, businessKey: null
  }, incoming);
  assert.deepEqual(identityConflict, {
    outcome: "conflict", code: "identity_of_intent_conflict", eventId: null, ignoredDuplicate: false, createdByRequest: null
  });
});

test("R9 classification kinds tally to 5 reads, 1 adminOnly, 1 disabled and 11 writes", () => {
  const tally = { read: 0, adminOnly: 0, disabled: 0, write: 0 };
  for (const eventType of Object.keys(KIND_BY_TYPE)) {
    const { kind } = classifySubmission(submissionFor(eventType));
    tally[kind] += 1;
  }
  assert.deepEqual(tally, { read: 5, adminOnly: 1, disabled: 1, write: 11 });
  assert.equal(Object.keys(KIND_BY_TYPE).length, 18);
});
