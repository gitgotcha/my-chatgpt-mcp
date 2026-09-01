import assert from "node:assert/strict";
import test from "node:test";
import { selectDailyQuestions } from "../src/daily-plan-selector.js";

const RESUME_VERSION = "resume-2026-08-29-a";

const entry = (overrides = {}) => ({
  questionKey: "q-1",
  knowledgePointId: "redis",
  resumeVersion: RESUME_VERSION,
  evidence: "explicit",
  type: "principle",
  prompt: "题面",
  answerChain: ["定义", "机制"],
  scoringPoints: ["要点"],
  referenceAnswer: "参考答案",
  resumeEvidenceRefs: ["claim-redis"],
  conditional: false,
  confirmed: false,
  ...overrides
});

const bankOf = (questions) => ({ resumeVersion: RESUME_VERSION, questions });

const profileOf = (questionMastery = {}, knowledgePoints = {}) => ({
  schemaVersion: "1.2",
  resumeVersion: RESUME_VERSION,
  questionMastery,
  knowledgePoints
});

const mastery = (masteryScore, lastScoredLocalDate) => ({ masteryScore, lastScoredLocalDate, attempts: 1 });

const slotsOf = (plan) => plan.questions.map((item) => item.slot);
const keysOf = (plan) => plan.questions.map((item) => item.questionKey);

test("the daily plan fills the five documented slots", () => {
  const plan = selectDailyQuestions({
    questionBank: bankOf([
      entry({ questionKey: "q-low-1", knowledgePointId: "redis" }),
      entry({ questionKey: "q-low-2", knowledgePointId: "mysql" }),
      entry({ questionKey: "q-low-3", knowledgePointId: "jvm" }),
      entry({ questionKey: "q-new-1", knowledgePointId: "redis" }),
      entry({ questionKey: "q-scn-1", knowledgePointId: "redis", type: "scenario", evidence: "strong-inference", conditional: true })
    ]),
    profile: profileOf({
      "q-low-1": mastery(30, "2026-08-20"),
      "q-low-2": mastery(40, "2026-08-21"),
      "q-low-3": mastery(50, "2026-08-22"),
      "q-scn-1": mastery(60, "2026-08-23")
    }),
    localDate: "2026-08-29"
  });

  assert.deepEqual(slotsOf(plan), [
    "lowest-mastery", "lowest-mastery", "untested-explicit", "project-scenario", "low-score-retest"
  ]);
  assert.deepEqual(keysOf(plan), ["q-low-1", "q-low-2", "q-new-1", "q-scn-1", "q-low-3"]);
});

test("untested questions use the new question slot instead of ranking as zero", () => {
  const plan = selectDailyQuestions({
    questionBank: bankOf([
      entry({ questionKey: "q-tested", knowledgePointId: "redis" }),
      entry({ questionKey: "q-untested", knowledgePointId: "redis" })
    ]),
    profile: profileOf({ "q-tested": mastery(90, "2026-08-28") }),
    localDate: "2026-08-29"
  });

  assert.deepEqual(keysOf(plan), ["q-tested", "q-untested"]);
  assert.deepEqual(slotsOf(plan), ["lowest-mastery", "untested-explicit"]);
  assert.deepEqual(plan.shortages, [
    { slot: "lowest-mastery", reason: "not_enough_tested_questions" },
    { slot: "project-scenario", reason: "no_scenario_question" },
    { slot: "low-score-retest", reason: "not_enough_tested_questions" }
  ]);
});

test("question keys are deduplicated across slots", () => {
  const plan = selectDailyQuestions({
    questionBank: bankOf([
      entry({ questionKey: "q-only-scenario", knowledgePointId: "redis", type: "scenario" })
    ]),
    profile: profileOf({ "q-only-scenario": mastery(20, "2026-08-20") }),
    localDate: "2026-08-29"
  });

  assert.deepEqual(keysOf(plan), ["q-only-scenario"]);
  assert.deepEqual(slotsOf(plan), ["lowest-mastery"]);
});

test("the retest slot prefers the question left untested the longest", () => {
  const plan = selectDailyQuestions({
    questionBank: bankOf([
      entry({ questionKey: "q-low-1", knowledgePointId: "redis" }),
      entry({ questionKey: "q-low-2", knowledgePointId: "mysql" }),
      entry({ questionKey: "q-old", knowledgePointId: "jvm" }),
      entry({ questionKey: "q-recent", knowledgePointId: "jvm" })
    ]),
    profile: profileOf({
      "q-low-1": mastery(30, "2026-08-20"),
      "q-low-2": mastery(40, "2026-08-21"),
      "q-old": mastery(55, "2026-08-01"),
      "q-recent": mastery(55, "2026-08-27")
    }),
    localDate: "2026-08-29"
  });

  assert.deepEqual(keysOf(plan), ["q-low-1", "q-low-2", "q-old"]);
  assert.equal(plan.questions.at(-1).slot, "low-score-retest");
});

test("a weaker knowledge point wins the tie between equal question mastery", () => {
  const plan = selectDailyQuestions({
    questionBank: bankOf([
      entry({ questionKey: "q-a", knowledgePointId: "redis" }),
      entry({ questionKey: "q-b", knowledgePointId: "jvm" })
    ]),
    profile: profileOf(
      {
        "q-a": mastery(50, "2026-08-20"),
        "q-b": mastery(50, "2026-08-20")
      },
      { redis: { mastery: 70 }, jvm: { mastery: 40 } }
    ),
    localDate: "2026-08-29"
  });

  assert.deepEqual(keysOf(plan), ["q-b", "q-a"]);
});

test("insufficient evidence returns fewer questions instead of generic filler", () => {
  const plan = selectDailyQuestions({
    questionBank: bankOf([entry({ questionKey: "q-single", knowledgePointId: "redis" })]),
    profile: profileOf({ "q-single": mastery(50, "2026-08-20") }),
    localDate: "2026-08-29"
  });

  assert.deepEqual(keysOf(plan), ["q-single"]);
  assert.equal(plan.questions.length < 5, true);
  assert.deepEqual(plan.shortages.map((item) => item.reason), [
    "not_enough_tested_questions",
    "no_untested_explicit_question",
    "no_scenario_question",
    "not_enough_tested_questions"
  ]);
});

test("there is no usable question bank so no question is selected", () => {
  const plan = selectDailyQuestions({ questionBank: null, profile: profileOf(), localDate: "2026-08-29" });
  assert.deepEqual(plan.questions, []);
  assert.deepEqual(plan.shortages, [{ slot: "question-bank", reason: "resume_required" }]);
});

test("the same inputs always select the same plan so a stored plan can be reused", () => {
  const input = {
    questionBank: bankOf([
      entry({ questionKey: "q-a", knowledgePointId: "redis" }),
      entry({ questionKey: "q-b", knowledgePointId: "redis", type: "scenario" }),
      entry({ questionKey: "q-c", knowledgePointId: "mysql" }),
      entry({ questionKey: "q-d", knowledgePointId: "jvm" }),
      entry({ questionKey: "q-e", knowledgePointId: "mq", evidence: "strong-inference", conditional: true })
    ]),
    profile: profileOf({
      "q-a": mastery(50, "2026-08-20"),
      "q-b": mastery(50, "2026-08-20"),
      "q-c": mastery(60, "2026-08-22"),
      "q-d": mastery(70, "2026-08-23")
    }),
    localDate: "2026-08-29"
  };
  assert.deepEqual(selectDailyQuestions(input), selectDailyQuestions(input));
});

test("an explicit limit narrows the plan without inventing questions", () => {
  const plan = selectDailyQuestions({
    questionBank: bankOf([
      entry({ questionKey: "q-a", knowledgePointId: "redis" }),
      entry({ questionKey: "q-b", knowledgePointId: "mysql" }),
      entry({ questionKey: "q-c", knowledgePointId: "jvm" })
    ]),
    profile: profileOf({
      "q-a": mastery(30, "2026-08-20"),
      "q-b": mastery(40, "2026-08-21"),
      "q-c": mastery(50, "2026-08-22")
    }),
    localDate: "2026-08-29",
    limit: 2
  });
  assert.deepEqual(keysOf(plan), ["q-a", "q-b"]);
});

test("the plan carries the resume version it was selected from", () => {
  const plan = selectDailyQuestions({
    questionBank: bankOf([entry({ questionKey: "q-a" })]),
    profile: profileOf({ "q-a": mastery(50, "2026-08-20") }),
    localDate: "2026-08-29"
  });
  assert.equal(plan.localDate, "2026-08-29");
  assert.equal(plan.resumeVersion, RESUME_VERSION);
});
