import { SCORE_TOTAL } from "./resume-knowledge-model.js";

// Spec section 9: five slots per day. Unfilled slots stay empty on purpose --
// the plan must never fall back to generic questions without resume evidence.
export const DAILY_SLOT_PLAN = Object.freeze([
  { slot: "lowest-mastery", count: 2 },
  { slot: "untested-explicit", count: 1 },
  { slot: "project-scenario", count: 1 },
  { slot: "low-score-retest", count: 1 }
]);
export const DEFAULT_DAILY_LIMIT = 5;

const SHORTAGE_REASONS = new Map([
  ["lowest-mastery", "not_enough_tested_questions"],
  ["low-score-retest", "not_enough_tested_questions"],
  ["untested-explicit", "no_untested_explicit_question"],
  ["project-scenario", "no_scenario_question"]
]);

const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

// Spec section 9, weakness ordering:
//   low question mastery -> low knowledge point mastery
//   -> retested longer ago -> higher resume relevance.
function weaknessComparator(knowledgePointMastery) {
  const pointMastery = (question) => knowledgePointMastery?.[question.knowledgePointId]?.mastery ?? SCORE_TOTAL;
  return (left, right) => (left.masteryScore - right.masteryScore)
    || (pointMastery(left) - pointMastery(right))
    || String(left.lastScoredLocalDate ?? "").localeCompare(String(right.lastScoredLocalDate ?? ""))
    || (relevanceRank(left) - relevanceRank(right))
    || String(left.questionKey ?? "").localeCompare(String(right.questionKey ?? ""));
}

const relevanceRank = (question) => (question.evidence === "explicit" ? 0 : 1);

const byRelevance = (left, right) => (relevanceRank(left) - relevanceRank(right))
  || String(left.questionKey ?? "").localeCompare(String(right.questionKey ?? ""));

/**
 * Choose the questions of one daily plan.
 *
 * The selection is deterministic, so re-running it for a date that already has
 * a stored plan yields the identical result and the stored plan can be reused.
 * Untested questions never rank as zero: they only fill the dedicated new
 * question slot.
 */
export function selectDailyQuestions({ questionBank, profile, localDate, limit = DEFAULT_DAILY_LIMIT } = {}) {
  const bank = Array.isArray(questionBank?.questions) ? questionBank.questions : [];
  const plan = {
    localDate: text(localDate),
    resumeVersion: text(questionBank?.resumeVersion),
    questions: [],
    shortages: []
  };

  if (!bank.length) {
    plan.shortages.push({ slot: "question-bank", reason: "resume_required" });
    return plan;
  }

  const masteryByQuestion = profile?.questionMastery ?? {};
  const knowledgePointMastery = profile?.knowledgePoints ?? {};
  const isTested = (question) => Boolean(masteryByQuestion[text(question?.questionKey)]);

  const tested = bank
    .filter((question) => text(question?.questionKey) && isTested(question))
    .map((question) => {
      const questionKey = text(question.questionKey);
      const entry = masteryByQuestion[questionKey];
      return {
        questionKey,
        knowledgePointId: text(question.knowledgePointId),
        evidence: question.evidence,
        type: question.type,
        prompt: question.prompt,
        masteryScore: Number.isFinite(Number(entry?.masteryScore)) ? Number(entry.masteryScore) : SCORE_TOTAL,
        lastScoredLocalDate: entry?.lastScoredLocalDate ?? null
      };
    });
  const untested = bank.filter((question) => text(question?.questionKey) && !isTested(question));

  const picked = new Set();
  const byWeakness = weaknessComparator(knowledgePointMastery);

  const candidatesFor = (slot) => {
    const remaining = (list) => list.filter((question) => !picked.has(question.questionKey));
    if (slot === "lowest-mastery" || slot === "low-score-retest") return remaining(tested).sort(byWeakness);
    if (slot === "untested-explicit") {
      return remaining(untested).filter((question) => question.evidence === "explicit").sort(byRelevance);
    }
    if (slot === "project-scenario") {
      return remaining(bank).filter((question) => question.type === "scenario").sort(byRelevance);
    }
    return [];
  };

  for (const { slot, count } of DAILY_SLOT_PLAN) {
    for (let index = 0; index < count; index += 1) {
      if (plan.questions.length >= limit) return plan;
      const candidate = candidatesFor(slot)[0];
      if (!candidate) {
        plan.shortages.push({ slot, reason: SHORTAGE_REASONS.get(slot) });
        break;
      }
      picked.add(candidate.questionKey);
      plan.questions.push({
        questionKey: candidate.questionKey,
        slot,
        knowledgePointId: candidate.knowledgePointId ?? null,
        evidence: candidate.evidence ?? null,
        type: candidate.type ?? null,
        prompt: candidate.prompt ?? null
      });
    }
  }

  return plan;
}
