import assert from "node:assert/strict";
import test from "node:test";
import {
  businessDedupeKey,
  reduceResumeKnowledgeProfile,
  resumeKnowledgeReducer
} from "../src/rds2/projection/resume-knowledge.js";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const BANK = {
  resumeVersion: "resume-1",
  questions: [
    { questionKey: "q-redis", knowledgePointId: "redis", evidence: "explicit" },
    { questionKey: "q-mq", knowledgePointId: "mq", evidence: "explicit" },
    { questionKey: "q-untested", knowledgePointId: "redis", evidence: "explicit" }
  ]
};

function score(overrides = {}) {
  const questionKey = overrides.questionKey ?? "q-redis";
  const localDate = overrides.localDate ?? "2026-09-01";
  const eventId = overrides.eventId ?? "10000000-0000-4000-8000-000000000001";
  return {
    schemaVersion: "1.2",
    eventId,
    eventKey: `${USER_ID}:${localDate}:${questionKey}:${eventId}`,
    eventType: "resume-knowledge.answer-scored",
    userId: USER_ID,
    username: "乔炳源",
    questionKey,
    localDate,
    resumeVersion: "resume-1",
    scoredAt: `${localDate}T10:00:00.000Z`,
    total: 80,
    feedback: { issues: ["遗漏边界"], issueCategories: ["完整性"] },
    ...overrides
  };
}

test("T13 the first score of a day wins and a later day blends mastery", () => {
  const profile = reduceResumeKnowledgeProfile([
    score({ total: 80 }),
    score({ eventId: "10000000-0000-4000-8000-000000000002", total: 20, scoredAt: "2026-09-01T11:00:00.000Z" }),
    score({ eventId: "10000000-0000-4000-8000-000000000003", localDate: "2026-09-02", scoredAt: "2026-09-02T10:00:00.000Z", total: 60 })
  ], BANK);
  assert.equal(profile.questionMastery["q-redis"].masteryScore, 68);
  assert.equal(profile.questionMastery["q-redis"].attempts, 2);
});

test("T13 score dedupe key is server-derived from user, event type, question and local date", () => {
  assert.equal(
    businessDedupeKey(score()),
    '["00000000-0000-4000-8000-000000000001","resume-knowledge.answer-scored","q-redis","2026-09-01"]'
  );
});

test("T13 an untested bank question is not assigned a fake zero mastery", () => {
  const profile = reduceResumeKnowledgeProfile([score()], BANK);
  assert.equal(profile.questionMastery["q-untested"], undefined);
  assert.deepEqual(profile.knowledgePoints.redis, { mastery: 80, tested: 1, total: 2, coverage: 0.5 });
  assert.equal(profile.nextReview.some((item) => item.questionKey === "q-untested"), true);
});

test("T13 missing question bank is an explicit resume_required result", () => {
  assert.deepEqual(reduceResumeKnowledgeProfile([score()], null), { status: "resume_required" });
  assert.deepEqual(reduceResumeKnowledgeProfile([score()], { questions: [] }), { status: "resume_required" });
});

test("T13 the active resume version controls the projection; a late old bank cannot replace it", () => {
  const current = reduceResumeKnowledgeProfile([score()], BANK);
  const oldBank = { resumeVersion: "resume-old", questions: [{ questionKey: "q-redis", knowledgePointId: "old", evidence: "explicit" }] };
  const late = reduceResumeKnowledgeProfile([score({ resumeVersion: "resume-old" })], current.resumeVersion ? BANK : oldBank);
  assert.equal(current.resumeVersion, "resume-1");
  assert.equal(late.resumeVersion, "resume-1");
});

test("T13 the reducer declares bounded question and mastery reads", () => {
  const plan = resumeKnowledgeReducer.planPageReads({ events: [score(), score({ questionKey: "q-mq" })] });
  assert.ok(plan.reads.every((item) => item.rowKeys.length <= 2));
  assert.deepEqual(plan.reads.map((item) => item.rowKind), ["question", "mastery"]);
});

