import assert from "node:assert/strict";
import test from "node:test";
import { validateEnvelope } from "../src/protocol.js";

const USER_ID = "00000000-0000-4000-8000-000000000001";

const common = {
  schemaVersion: "1.2",
  eventId: "30000000-0000-4000-8000-000000000001",
  eventKey: "resume:2026-08-29:key-1",
  userId: USER_ID,
  username: "张三"
};

const envelope = (eventType, event) => ({
  schemaVersion: "1.2",
  namespace: eventType.split(".")[0],
  eventType,
  payload: { event },
  requestId: "req-1"
});

const accept = (eventType, event) => validateEnvelope(envelope(eventType, event));
const reject = (eventType, event) => assert.throws(
  () => validateEnvelope(envelope(eventType, event)),
  /invalid_event/
);

const resumeIngested = (overrides = {}) => ({
  ...common,
  eventType: "resume-knowledge.resume-ingested",
  resumeVersion: "resume-2026-08-29-a",
  fingerprint: "sha256-abc123",
  activatedAt: "2026-08-29T01:00:00.000Z",
  claims: [{ claimId: "claim-redis", evidence: "explicit" }],
  claimRelations: [{ claimId: "claim-redis", projectId: "project-1" }],
  techTags: ["java", "redis"],
  evidenceLocations: [{ claimId: "claim-redis", location: "项目经历第二段" }],
  ...overrides
});

const claimDecision = (eventType, overrides = {}) => ({
  ...common,
  eventType,
  resumeVersion: "resume-2026-08-29-a",
  claimId: "claim-mq",
  decidedAt: "2026-08-29T01:30:00.000Z",
  ...overrides
});

const bankQuestion = (overrides = {}) => ({
  questionKey: "redis-cache-penetration",
  knowledgePointId: "redis",
  evidence: "explicit",
  type: "principle",
  prompt: "什么是缓存穿透？如何解决？",
  answerChain: ["定义", "核心机制"],
  scoringPoints: ["布隆过滤器", "空值缓存"],
  referenceAnswer: "缓存穿透指查询不存在的数据。",
  resumeEvidenceRefs: ["claim-redis"],
  conditional: false,
  confirmed: false,
  masteryScore: null,
  lastScoredLocalDate: null,
  ...overrides
});

const questionBank = (overrides = {}) => ({
  ...common,
  eventType: "resume-knowledge.question-bank-created",
  resumeVersion: "resume-2026-08-29-a",
  generatedAt: "2026-08-29T01:40:00.000Z",
  questions: [bankQuestion()],
  ...overrides
});

const dailyPlan = (overrides = {}) => ({
  ...common,
  eventType: "resume-knowledge.daily-plan-created",
  resumeVersion: "resume-2026-08-29-a",
  localDate: "2026-08-29",
  planId: "plan-abc",
  timezone: "Asia/Shanghai",
  generatedAt: "2026-08-29T01:50:00.000Z",
  items: [{ questionKey: "redis-cache-penetration", slot: "lowest-mastery" }],
  ...overrides
});

const answerScored = (overrides = {}) => ({
  ...common,
  eventType: "resume-knowledge.answer-scored",
  questionKey: "redis-cache-penetration",
  localDate: "2026-08-29",
  resumeVersion: "resume-2026-08-29-a",
  scoredAt: "2026-08-29T02:00:00.000Z",
  scores: { correctness: 28, completeness: 17, structure: 15, resumeRelevance: 10 },
  total: 70,
  feedback: {
    strengths: ["说出了布隆过滤器"],
    issues: ["遗漏空值缓存"],
    issueCategories: ["关键点遗漏"],
    answerChain: ["定义", "核心机制"],
    referenceAnswer: "缓存穿透指查询不存在的数据。"
  },
  ...overrides
});

// ---------------------------------------------------------------------------
// Accepted shapes
// ---------------------------------------------------------------------------

test("a resume ingestion event carries the fingerprint and evidence locations", () => {
  const envelopeResult = accept("resume-knowledge.resume-ingested", resumeIngested());
  assert.equal(envelopeResult.payload.event.resumeVersion, "resume-2026-08-29-a");
});

test("a claim confirmation and a claim rejection share one validated shape", () => {
  accept("resume-knowledge.claim-confirmed", claimDecision("resume-knowledge.claim-confirmed"));
  accept("resume-knowledge.claim-rejected", claimDecision("resume-knowledge.claim-rejected", {
    eventId: "30000000-0000-4000-8000-000000000002",
    note: "项目中没有使用 MQ"
  }));
});

test("a question bank event carries every documented question field", () => {
  accept("resume-knowledge.question-bank-created", questionBank());
});

test("a question bank may record the current mastery of an already scored question", () => {
  accept("resume-knowledge.question-bank-created", questionBank({
    questions: [bankQuestion({ masteryScore: 76, lastScoredLocalDate: "2026-08-28" })]
  }));
});

test("a daily plan event carries the five slot items", () => {
  accept("resume-knowledge.daily-plan-created", dailyPlan({
    items: [
      { questionKey: "q-a", slot: "lowest-mastery" },
      { questionKey: "q-b", slot: "lowest-mastery" },
      { questionKey: "q-c", slot: "untested-explicit" },
      { questionKey: "q-d", slot: "project-scenario" },
      { questionKey: "q-e", slot: "low-score-retest" }
    ]
  }));
});

test("an answer scored event carries the four dimension scores", () => {
  accept("resume-knowledge.answer-scored", answerScored());
});

// ---------------------------------------------------------------------------
// Required fields
// ---------------------------------------------------------------------------

test("resumeVersion is required on every resume knowledge event", () => {
  reject("resume-knowledge.resume-ingested", resumeIngested({ resumeVersion: undefined }));
  reject("resume-knowledge.claim-confirmed", claimDecision("resume-knowledge.claim-confirmed", { resumeVersion: "" }));
  reject("resume-knowledge.question-bank-created", questionBank({ resumeVersion: undefined }));
  reject("resume-knowledge.daily-plan-created", dailyPlan({ resumeVersion: undefined }));
  reject("resume-knowledge.answer-scored", answerScored({ resumeVersion: undefined }));
});

test("questionKey and localDate are required where the plan depends on them", () => {
  reject("resume-knowledge.answer-scored", answerScored({ questionKey: undefined }));
  reject("resume-knowledge.answer-scored", answerScored({ questionKey: "" }));
  reject("resume-knowledge.answer-scored", answerScored({ localDate: "2026/08/29" }));
  reject("resume-knowledge.daily-plan-created", dailyPlan({ localDate: "29-08-2026" }));
  reject("resume-knowledge.question-bank-created", questionBank({ questions: [bankQuestion({ questionKey: undefined })] }));
});

test("a question key may not contain path characters", () => {
  reject("resume-knowledge.answer-scored", answerScored({ questionKey: "../escape" }));
  reject("resume-knowledge.answer-scored", answerScored({ questionKey: "a/b" }));
});

test("unknown event fields are rejected instead of stored", () => {
  reject("resume-knowledge.answer-scored", answerScored({ unexpected: true }));
  reject("resume-knowledge.question-bank-created", questionBank({ questions: [bankQuestion({ unexpected: true })] }));
});

// ---------------------------------------------------------------------------
// Scoring rules
// ---------------------------------------------------------------------------

test("a dimension score may not exceed its own weight", () => {
  reject("resume-knowledge.answer-scored", answerScored({
    scores: { correctness: 41, completeness: 14, structure: 10, resumeRelevance: 5 },
    total: 70
  }));
});

test("a negative dimension score is rejected", () => {
  reject("resume-knowledge.answer-scored", answerScored({
    scores: { correctness: -1, completeness: 18, structure: 15, resumeRelevance: 10 },
    total: 42
  }));
});

test("the four dimensions must add up to the reported total", () => {
  reject("resume-knowledge.answer-scored", answerScored({ total: 90 }));
  reject("resume-knowledge.answer-scored", answerScored({ total: 69.9 }));
});

test("the total may not exceed the scale", () => {
  reject("resume-knowledge.answer-scored", answerScored({
    scores: { correctness: 40, completeness: 25, structure: 20, resumeRelevance: 15 },
    total: 101
  }));
});

test("an unknown scoring dimension is rejected", () => {
  reject("resume-knowledge.answer-scored", answerScored({
    scores: { correctness: 28, completeness: 17, structure: 15, resumeRelevance: 10, bonus: 5 },
    total: 75
  }));
  reject("resume-knowledge.answer-scored", answerScored({
    scores: { correctness: 28, completeness: 17, structure: 15 },
    total: 60
  }));
});

test("a perfect answer reaches exactly the scale", () => {
  accept("resume-knowledge.answer-scored", answerScored({
    scores: { correctness: 40, completeness: 25, structure: 20, resumeRelevance: 15 },
    total: 100
  }));
});

// ---------------------------------------------------------------------------
// Evidence and question bank rules
// ---------------------------------------------------------------------------

test("an unknown evidence level is rejected", () => {
  reject("resume-knowledge.resume-ingested", resumeIngested({
    claims: [{ claimId: "claim-redis", evidence: "guessed" }]
  }));
  reject("resume-knowledge.question-bank-created", questionBank({ questions: [bankQuestion({ evidence: "guessed" })] }));
});

test("an unsupported question may still be reported but never becomes a bank question", () => {
  // The bank itself only carries questions the resume supports; the exclusion
  // of `unsupported` entries is a reducer responsibility, see the model tests.
  accept("resume-knowledge.question-bank-created", questionBank({
    questions: [bankQuestion({ evidence: "explicit" })]
  }));
});

test("an unknown question type is rejected", () => {
  reject("resume-knowledge.question-bank-created", questionBank({
    questions: [bankQuestion({ type: "brain-teaser" })]
  }));
});

test("an unknown daily plan slot is rejected", () => {
  reject("resume-knowledge.daily-plan-created", dailyPlan({
    items: [{ questionKey: "q-a", slot: "random-filler" }]
  }));
});

test("a bank question with a malformed scoring date is rejected", () => {
  reject("resume-knowledge.question-bank-created", questionBank({
    questions: [bankQuestion({ masteryScore: 70, lastScoredLocalDate: "yesterday" })]
  }));
});

// ---------------------------------------------------------------------------
// Namespace and envelope
// ---------------------------------------------------------------------------

test("resume knowledge events are rejected outside their namespace", () => {
  assert.throws(() => validateEnvelope({
    schemaVersion: "1.2",
    namespace: "algorithm",
    eventType: "resume-knowledge.answer-scored",
    payload: { event: answerScored() },
    requestId: "req-1"
  }), /invalid_event_type/);
});

test("a resume knowledge payload without an event is rejected", () => {
  assert.throws(() => validateEnvelope({
    schemaVersion: "1.2",
    namespace: "resume-knowledge",
    eventType: "resume-knowledge.resume-ingested",
    payload: {},
    requestId: "req-1"
  }), /invalid_payload/);
});
