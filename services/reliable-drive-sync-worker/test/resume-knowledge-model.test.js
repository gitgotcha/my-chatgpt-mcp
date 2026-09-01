import assert from "node:assert/strict";
import test from "node:test";
import {
  SCORE_DIMENSIONS,
  firstScorePerDay,
  knowledgePointStats,
  normalizeQuestionBank,
  rebuildResumeKnowledgeProfile,
  scoringKey,
  updateMastery
} from "../src/resume-knowledge-model.js";

const USER_ID = "00000000-0000-4000-8000-000000000001";

const resumeSnapshot = (overrides = {}) => ({
  resumeVersion: "resume-2026-08-29-a",
  fingerprint: "sha256-abc123",
  claims: [
    { claimId: "claim-redis", evidence: "explicit" },
    { claimId: "claim-mysql", evidence: "explicit" },
    { claimId: "claim-mq", evidence: "strong-inference" },
    { claimId: "claim-k8s", evidence: "unsupported" }
  ],
  ...overrides
});

const question = (overrides = {}) => ({
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
  ...overrides
});

const answerScored = (overrides = {}) => ({
  schemaVersion: "1.2",
  eventId: "30000000-0000-4000-8000-000000000001",
  eventKey: `${USER_ID}:2026-08-29:redis-cache-penetration`,
  eventType: "resume-knowledge.answer-scored",
  userId: USER_ID,
  username: "张三",
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
    answerChain: ["定义", "核心机制", "关键流程"],
    referenceAnswer: "缓存穿透指查询不存在的数据……"
  },
  ...overrides
});

// ---------------------------------------------------------------------------
// Evidence rules
// ---------------------------------------------------------------------------

test("an explicit claim enters the question bank directly", () => {
  const result = normalizeQuestionBank({
    resumeSnapshot: resumeSnapshot(),
    claims: [],
    questions: [question()]
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.questions.map((item) => item.questionKey), ["redis-cache-penetration"]);
  assert.deepEqual(result.excluded, []);
});

test("a strong inference question is conditional when asked conditionally", () => {
  const result = normalizeQuestionBank({
    resumeSnapshot: resumeSnapshot(),
    claims: [],
    questions: [question({ questionKey: "mq-repeat-consume", evidence: "strong-inference", conditional: true })]
  });
  assert.deepEqual(result.questions.map((item) => item.questionKey), ["mq-repeat-consume"]);
});

test("a strong inference question is kept once the user confirmed the claim", () => {
  const result = normalizeQuestionBank({
    resumeSnapshot: resumeSnapshot(),
    claims: [{ claimId: "claim-mq", status: "confirmed" }],
    questions: [question({
      questionKey: "mq-repeat-consume",
      evidence: "strong-inference",
      resumeEvidenceRefs: ["claim-mq"],
      confirmed: true
    })]
  });
  assert.deepEqual(result.questions.map((item) => item.questionKey), ["mq-repeat-consume"]);
});

test("an unconfirmed strong inference question is excluded", () => {
  const result = normalizeQuestionBank({
    resumeSnapshot: resumeSnapshot(),
    claims: [],
    questions: [question({ questionKey: "mq-repeat-consume", evidence: "strong-inference" })]
  });
  assert.deepEqual(result.questions, []);
  assert.deepEqual(result.excluded, [
    { questionKey: "mq-repeat-consume", reason: "inference_needs_confirmation" }
  ]);
});

test("an unsupported question never enters the bank", () => {
  const result = normalizeQuestionBank({
    resumeSnapshot: resumeSnapshot(),
    claims: [],
    questions: [question({ questionKey: "k8s-operator", evidence: "unsupported" })]
  });
  assert.deepEqual(result.questions, []);
  assert.deepEqual(result.excluded, [{ questionKey: "k8s-operator", reason: "unsupported_evidence" }]);
});

test("a question backed by a rejected claim never enters the bank", () => {
  const result = normalizeQuestionBank({
    resumeSnapshot: resumeSnapshot(),
    claims: [{ claimId: "claim-mq", status: "rejected" }],
    questions: [question({
      questionKey: "mq-repeat-consume",
      evidence: "explicit",
      resumeEvidenceRefs: ["claim-mq"]
    })]
  });
  assert.deepEqual(result.questions, []);
  assert.deepEqual(result.excluded, [{ questionKey: "mq-repeat-consume", reason: "claim_rejected" }]);
});

test("a rejected claim overrides the resume evidence level", () => {
  const result = normalizeQuestionBank({
    resumeSnapshot: resumeSnapshot(),
    claims: [{ claimId: "claim-redis", status: "rejected" }],
    questions: [question({ evidence: "explicit", resumeEvidenceRefs: ["claim-redis"] })]
  });
  assert.deepEqual(result.excluded, [{ questionKey: "redis-cache-penetration", reason: "claim_rejected" }]);
});

test("there is no valid resume snapshot so the bank is refused", () => {
  assert.deepEqual(normalizeQuestionBank({ resumeSnapshot: null, questions: [question()] }), { status: "resume_required" });
  assert.deepEqual(normalizeQuestionBank({ resumeSnapshot: {}, questions: [question()] }), { status: "resume_required" });
  assert.deepEqual(
    normalizeQuestionBank({ resumeSnapshot: { fingerprint: "sha256-abc123" }, questions: [question()] }),
    { status: "resume_required" }
  );
});

test("question keys are deduplicated and the bank carries the resume version", () => {
  const result = normalizeQuestionBank({
    resumeSnapshot: resumeSnapshot(),
    questions: [
      question(),
      question({ prompt: "换一种说法再问一次缓存穿透" })
    ]
  });
  assert.equal(result.resumeVersion, "resume-2026-08-29-a");
  assert.equal(result.questions.length, 1);
  assert.equal(result.questions[0].resumeVersion, "resume-2026-08-29-a");
});

// ---------------------------------------------------------------------------
// Mastery
// ---------------------------------------------------------------------------

test("the first score becomes the mastery score", () => {
  assert.equal(updateMastery(undefined, 70), 70);
});

test("a later day blends the new score with the previous mastery", () => {
  assert.equal(updateMastery(50, 80), 68);
});

test("untested questions stay out of the average but count for coverage", () => {
  assert.deepEqual(knowledgePointStats([{ status: "tested", mastery: 80 }, { status: "untested" }]), {
    mastery: 80, tested: 1, total: 2, coverage: 0.5
  });
});

test("a knowledge point without any tested question has no mastery", () => {
  assert.deepEqual(knowledgePointStats([{ status: "untested" }]), {
    mastery: null, tested: 0, total: 1, coverage: 0
  });
});

test("the four scoring dimensions keep the documented weights", () => {
  assert.deepEqual(SCORE_DIMENSIONS, { correctness: 40, completeness: 25, structure: 20, resumeRelevance: 15 });
});

// ---------------------------------------------------------------------------
// One score per question per day
// ---------------------------------------------------------------------------

test("the scoring key combines user, local date and stable question key", () => {
  assert.equal(scoringKey(answerScored()), `${USER_ID}|2026-08-29|redis-cache-penetration`);
});

test("the same user, date and question keeps only the earliest score", () => {
  const events = [
    answerScored({ eventId: "30000000-0000-4000-8000-000000000002", scoredAt: "2026-08-29T05:00:00.000Z", total: 90 }),
    answerScored({ scoredAt: "2026-08-29T02:00:00.000Z", total: 70 })
  ];
  const kept = firstScorePerDay(events);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].total, 70);
});

test("the same question on another day may be scored again", () => {
  const events = [
    answerScored({ localDate: "2026-08-29", scoredAt: "2026-08-29T02:00:00.000Z", total: 70 }),
    answerScored({
      eventId: "30000000-0000-4000-8000-000000000002",
      localDate: "2026-08-30",
      scoredAt: "2026-08-30T02:00:00.000Z",
      total: 90
    })
  ];
  const kept = firstScorePerDay(events);
  assert.deepEqual(kept.map((event) => event.total), [70, 90]);
});

test("different questions on the same day are all kept", () => {
  const events = [
    answerScored({ questionKey: "q-a", total: 70 }),
    answerScored({ eventId: "30000000-0000-4000-8000-000000000002", questionKey: "q-b", total: 55 })
  ];
  assert.equal(firstScorePerDay(events).length, 2);
});

// ---------------------------------------------------------------------------
// Profile reducer
// ---------------------------------------------------------------------------

const bankWith = (questions) => ({
  resumeVersion: "resume-2026-08-29-a",
  questions: questions.map((item) => question(item))
});

test("the first score produces a mastery snapshot", () => {
  const profile = rebuildResumeKnowledgeProfile(
    [answerScored()],
    bankWith([{ questionKey: "redis-cache-penetration", knowledgePointId: "redis" }]),
    { now: () => "2026-08-29T02:00:01.000Z" }
  );
  assert.equal(profile.schemaVersion, "1.2");
  assert.equal(profile.resumeVersion, "resume-2026-08-29-a");
  assert.equal(profile.headEventId, "30000000-0000-4000-8000-000000000001");
  assert.deepEqual(profile.sourceEventKeys, [`${USER_ID}:2026-08-29:redis-cache-penetration`]);
  assert.equal(profile.questionMastery["redis-cache-penetration"].masteryScore, 70);
  assert.equal(profile.questionMastery["redis-cache-penetration"].lastScoredLocalDate, "2026-08-29");
  assert.deepEqual(profile.knowledgePoints.redis, {
    mastery: 70, tested: 1, total: 1, coverage: 1
  });
  assert.deepEqual(profile.coverage, { tested: 1, total: 1, ratio: 1 });
});

test("a second day moves the mastery towards the new score", () => {
  const profile = rebuildResumeKnowledgeProfile(
    [
      answerScored({ localDate: "2026-08-29", scoredAt: "2026-08-29T02:00:00.000Z", total: 70 }),
      answerScored({
        eventId: "30000000-0000-4000-8000-000000000002",
        eventKey: `${USER_ID}:2026-08-30:redis-cache-penetration`,
        localDate: "2026-08-30",
        scoredAt: "2026-08-30T02:00:00.000Z",
        total: 80
      })
    ],
    bankWith([{ questionKey: "redis-cache-penetration", knowledgePointId: "redis" }]),
    { now: () => "2026-08-30T02:00:01.000Z" }
  );
  // 0.6 * 80 + 0.4 * 70
  assert.equal(profile.questionMastery["redis-cache-penetration"].masteryScore, 76);
  assert.equal(profile.headEventId, "30000000-0000-4000-8000-000000000002");
});

test("a duplicate same-day score never reaches the reducer", () => {
  const profile = rebuildResumeKnowledgeProfile(
    [
      answerScored({ total: 70 }),
      answerScored({ eventId: "30000000-0000-4000-8000-000000000002", scoredAt: "2026-08-29T09:00:00.000Z", total: 100 })
    ],
    bankWith([{ questionKey: "redis-cache-penetration", knowledgePointId: "redis" }]),
    { now: () => "2026-08-29T09:00:01.000Z" }
  );
  assert.equal(profile.questionMastery["redis-cache-penetration"].masteryScore, 70);
  assert.equal(profile.questionMastery["redis-cache-penetration"].attempts, 1);
});

test("untested questions lower coverage without lowering mastery", () => {
  const profile = rebuildResumeKnowledgeProfile(
    [answerScored({ questionKey: "q-a", total: 80 })],
    bankWith([
      { questionKey: "q-a", knowledgePointId: "redis" },
      { questionKey: "q-b", knowledgePointId: "redis" },
      { questionKey: "q-c", knowledgePointId: "mysql" }
    ]),
    { now: () => "2026-08-29T02:00:01.000Z" }
  );
  assert.deepEqual(profile.knowledgePoints.redis, { mastery: 80, tested: 1, total: 2, coverage: 0.5 });
  assert.deepEqual(profile.knowledgePoints.mysql, { mastery: null, tested: 0, total: 1, coverage: 0 });
  assert.deepEqual(profile.coverage, { tested: 1, total: 3, ratio: 1 / 3 });
});

test("weaknesses are ordered by the lowest mastery first", () => {
  const profile = rebuildResumeKnowledgeProfile(
    [
      answerScored({ questionKey: "q-a", eventKey: `${USER_ID}:2026-08-29:q-a`, total: 80 }),
      answerScored({
        eventId: "30000000-0000-4000-8000-000000000002",
        eventKey: `${USER_ID}:2026-08-29:q-b`,
        questionKey: "q-b",
        total: 45
      }),
      answerScored({
        eventId: "30000000-0000-4000-8000-000000000003",
        eventKey: `${USER_ID}:2026-08-29:q-c`,
        questionKey: "q-c",
        total: 60
      })
    ],
    bankWith([
      { questionKey: "q-a", knowledgePointId: "redis" },
      { questionKey: "q-b", knowledgePointId: "mysql" },
      { questionKey: "q-c", knowledgePointId: "jvm" }
    ]),
    { now: () => "2026-08-29T02:00:01.000Z" }
  );
  assert.deepEqual(profile.weaknesses.map((item) => item.questionKey), ["q-b", "q-c", "q-a"]);
});

test("recent issues keep the reported problems of the latest answers", () => {
  const profile = rebuildResumeKnowledgeProfile(
    [answerScored()],
    bankWith([{ questionKey: "redis-cache-penetration", knowledgePointId: "redis" }]),
    { now: () => "2026-08-29T02:00:01.000Z" }
  );
  assert.deepEqual(profile.recentIssues, [{
    questionKey: "redis-cache-penetration",
    localDate: "2026-08-29",
    total: 70,
    issues: ["遗漏空值缓存"],
    issueCategories: ["关键点遗漏"]
  }]);
});

test("an event without a known question is still reduced but flagged as unknown", () => {
  const profile = rebuildResumeKnowledgeProfile(
    [answerScored({ questionKey: "q-missing" })],
    bankWith([{ questionKey: "redis-cache-penetration", knowledgePointId: "redis" }]),
    { now: () => "2026-08-29T02:00:01.000Z" }
  );
  assert.equal(profile.questionMastery["q-missing"].masteryScore, 70);
  assert.deepEqual(profile.knowledgePoints, {
    redis: { mastery: null, tested: 0, total: 1, coverage: 0 }
  });
  assert.deepEqual(profile.coverage, { tested: 0, total: 1, ratio: 0 });
});

test("events of another type are ignored by the reducer", () => {
  const profile = rebuildResumeKnowledgeProfile(
    [{ ...answerScored(), eventType: "resume-knowledge.question-bank-created" }],
    bankWith([{ questionKey: "redis-cache-penetration", knowledgePointId: "redis" }]),
    { now: () => "2026-08-29T02:00:01.000Z" }
  );
  assert.equal(profile.headEventId, null);
  assert.deepEqual(profile.questionMastery, {});
});
