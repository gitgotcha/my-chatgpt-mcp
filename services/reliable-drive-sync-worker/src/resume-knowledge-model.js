// Reducers for the resume-knowledge domain.
//
// Everything here is a pure function over already verified events and the
// canonical question bank. The Worker is the only component allowed to
// materialise the results into Drive.

const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
const round2 = (value) => Math.round(value * 100) / 100;

export const SCHEMA_VERSION = "1.2";
export const ANSWER_SCORED = "resume-knowledge.answer-scored";

// Spec section 10. The four dimension keys are a mechanical transliteration of
// the Chinese names in the design; the weights are authoritative.
export const SCORE_DIMENSIONS = Object.freeze({
  correctness: 40, // 技术正确性
  completeness: 25, // 关键点完整性
  structure: 20, // 回答链路与层次
  resumeRelevance: 15 // 简历场景结合度
});
export const SCORE_DIMENSION_KEYS = Object.freeze(Object.keys(SCORE_DIMENSIONS));
export const SCORE_TOTAL = 100;

// Spec section 7. `rejected` is not a resume evidence level: it is the state a
// claim enters after the user denies it.
export const EXPLICIT_EVIDENCE = "explicit";
export const INFERRED_EVIDENCE = "strong-inference";
export const UNSUPPORTED_EVIDENCE = "unsupported";
export const REJECTED_EVIDENCE = "rejected";
export const EVIDENCE_LEVELS = new Set([EXPLICIT_EVIDENCE, INFERRED_EVIDENCE, UNSUPPORTED_EVIDENCE]);
// 简历知识证据段里也用短横线写法，这里同时接受两种形式。
const EVIDENCE_ALIASES = new Map([
  ["explicit", EXPLICIT_EVIDENCE],
  ["strong-inference", INFERRED_EVIDENCE],
  ["strong_inference", INFERRED_EVIDENCE],
  ["unsupported", UNSUPPORTED_EVIDENCE],
  ["rejected", REJECTED_EVIDENCE]
]);
export const QUESTION_TYPES = new Set(["scenario", "principle"]);

export const CLAIM_CONFIRMED = "confirmed";
export const CLAIM_REJECTED = "rejected";
// 决策记录用 `status` 表达用户对某条声明的确认或否认。
export const CLAIM_DECISION_STATUSES = new Set([CLAIM_CONFIRMED, CLAIM_REJECTED]);

const MASTERY_WEIGHT_NEW = 0.6;
const MASTERY_WEIGHT_PREVIOUS = 0.4;
const RECENT_ISSUE_LIMIT = 5;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function evidenceOf(value) {
  const raw = text(value);
  return raw ? EVIDENCE_ALIASES.get(raw) ?? null : null;
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

function claimStatuses(claims) {
  // Only user decisions change how a claim may be used. The evidence level of
  // a claim is a property of the resume and stays untouched.
  const register = new Set();
  const rejected = new Set();
  for (const decision of Array.isArray(claims) ? claims : []) {
    const claimId = text(decision?.claimId);
    if (!claimId || !CLAIM_DECISION_STATUSES.has(decision?.status)) continue;
    if (decision.status === CLAIM_REJECTED) {
      rejected.add(claimId);
      register.delete(claimId); // 在简历知识证据段内注册拒绝
    } else {
      rejected.delete(claimId);
      register.add(claimId); // 在简历知识证据段内注册确认
    }
  }
  return { register, rejected };
}

/**
 * Filter candidate questions through the evidence policy of spec section 7.
 *
 * - `explicit`         -> usable directly.
 * - `strong-inference` -> usable only when asked conditionally or confirmed.
 * - `unsupported`      -> never enters the bank.
 * - rejected claim     -> never usable as a project fact again.
 */
export function normalizeQuestionBank({ resumeSnapshot, claims = [], questions = [] } = {}) {
  const resumeVersion = text(resumeSnapshot?.resumeVersion);
  if (!resumeVersion) return { status: "resume_required" };

  const { register, rejected } = claimStatuses(claims);
  const kept = new Map();
  const excluded = [];

  for (const item of Array.isArray(questions) ? questions : []) {
    const questionKey = text(item?.questionKey);
    if (!questionKey || kept.has(questionKey)) continue;

    const refs = Array.isArray(item?.resumeEvidenceRefs) ? item.resumeEvidenceRefs : [];
    const evidence = evidenceOf(item?.evidence);
    const claimRejected = evidence === REJECTED_EVIDENCE || refs.some((ref) => rejected.has(ref));
    const claimConfirmed = Boolean(item?.confirmed) || refs.some((ref) => register.has(ref));

    if (claimRejected) {
      excluded.push({ questionKey, reason: "claim_rejected" });
      continue;
    }
    if (evidence !== EXPLICIT_EVIDENCE && evidence !== INFERRED_EVIDENCE) {
      excluded.push({ questionKey, reason: "unsupported_evidence" });
      continue;
    }
    if (evidence === INFERRED_EVIDENCE && item?.conditional !== true && !claimConfirmed) {
      excluded.push({ questionKey, reason: "inference_needs_confirmation" });
      continue;
    }
    kept.set(questionKey, { ...item, questionKey, resumeVersion });
  }

  return { status: "ok", resumeVersion, questions: [...kept.values()], excluded };
}

// ---------------------------------------------------------------------------
// Mastery
// ---------------------------------------------------------------------------

/** First score becomes mastery; later days blend 0.6 * new + 0.4 * previous. */
export function updateMastery(previous, score) {
  const current = Number(score);
  if (!Number.isFinite(current)) return null;
  const prior = previous === undefined || previous === null ? null : Number(previous);
  if (prior === null || !Number.isFinite(prior)) return round2(current);
  return round2(MASTERY_WEIGHT_NEW * current + MASTERY_WEIGHT_PREVIOUS * prior);
}

/**
 * Untested questions keep `untested` status: they never enter the mastery
 * average but always count in the coverage denominator.
 */
export function knowledgePointStats(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const tested = list.filter((item) => item?.status === "tested" && Number.isFinite(Number(item.mastery)));
  const total = list.length;
  return {
    mastery: tested.length
      ? round2(tested.reduce((sum, item) => sum + Number(item.mastery), 0) / tested.length)
      : null,
    tested: tested.length,
    total,
    coverage: total ? tested.length / total : 0
  };
}

// ---------------------------------------------------------------------------
// One score per question per day
// ---------------------------------------------------------------------------

function isScoreableEvent(event) {
  return Boolean(event)
    && event.schemaVersion === SCHEMA_VERSION
    && event.eventType === ANSWER_SCORED
    && nonEmpty(event.eventId)
    && nonEmpty(event.eventKey)
    && nonEmpty(event.questionKey)
    && LOCAL_DATE.test(String(event.localDate ?? ""));
}

function compareScoring(left, right) {
  return String(left.scoredAt ?? "").localeCompare(String(right.scoredAt ?? ""))
    || String(left.eventId ?? "").localeCompare(String(right.eventId ?? ""));
}

/** The idempotency key of a score: user + local date + stable question key. */
export function scoringKey(event) {
  return [text(event?.userId) ?? "", text(event?.localDate) ?? "", text(event?.questionKey) ?? ""].join("|");
}

/**
 * Keep only the earliest valid score of every `userId + localDate + questionKey`
 * triple. The same question becomes scoreable again on the next local date.
 */
export function firstScorePerDay(events) {
  const ordered = (Array.isArray(events) ? events : []).filter(isScoreableEvent).sort(compareScoring);
  const byKey = new Map();
  for (const event of ordered) {
    const key = scoringKey(event);
    if (!byKey.has(key)) byKey.set(key, event);
  }
  return [...byKey.values()].sort(compareScoring);
}

// ---------------------------------------------------------------------------
// Profile reducer
// ---------------------------------------------------------------------------

function compareWeakness(knowledgePointMastery) {
  return (left, right) => (left.masteryScore - right.masteryScore)
    || ((knowledgePointMastery[left.knowledgePointId]?.mastery ?? SCORE_TOTAL)
      - (knowledgePointMastery[right.knowledgePointId]?.mastery ?? SCORE_TOTAL))
    || String(left.lastScoredLocalDate ?? "").localeCompare(String(right.lastScoredLocalDate ?? ""))
    || String(left.questionKey ?? "").localeCompare(String(right.questionKey ?? ""));
}

/**
 * Rebuild the resume-knowledge profile from verified events and the canonical
 * question bank. A missing question bank means the resume has not been
 * ingested yet, so the reducer reports `resume_required` instead of guessing.
 */
export function rebuildResumeKnowledgeProfile(events, questionBank, { now = () => new Date().toISOString() } = {}) {
  const bank = Array.isArray(questionBank?.questions) ? questionBank.questions : [];
  const bankByKey = new Map();
  for (const item of bank) {
    const questionKey = text(item?.questionKey);
    if (questionKey && !bankByKey.has(questionKey)) bankByKey.set(questionKey, item);
  }

  const scored = firstScorePerDay(events);
  const questionMastery = {};
  const sourceEventKeys = [];
  const recent = [];

  for (const event of scored) {
    const questionKey = text(event.questionKey);
    const total = Number(event.total);
    const score = Number.isFinite(total) ? total : 0;
    const previous = questionMastery[questionKey];
    questionMastery[questionKey] = {
      masteryScore: updateMastery(previous?.masteryScore, score),
      lastScoredLocalDate: event.localDate,
      attempts: (previous?.attempts ?? 0) + 1,
      lastTotal: score,
      lastEventId: event.eventId,
      knowledgePointId: text(bankByKey.get(questionKey)?.knowledgePointId) ?? null,
      inQuestionBank: bankByKey.has(questionKey)
    };
    sourceEventKeys.push(event.eventKey);
    recent.push({
      questionKey,
      localDate: event.localDate,
      total: score,
      issues: Array.isArray(event.feedback?.issues) ? event.feedback.issues.filter(nonEmpty) : [],
      issueCategories: Array.isArray(event.feedback?.issueCategories)
        ? event.feedback.issueCategories.filter(nonEmpty)
        : []
    });
  }

  const grouped = new Map();
  for (const item of bank) {
    const knowledgePointId = text(item?.knowledgePointId);
    const questionKey = text(item?.questionKey);
    if (!knowledgePointId || !questionKey) continue;
    if (!grouped.has(knowledgePointId)) grouped.set(knowledgePointId, []);
    grouped.get(knowledgePointId).push({
      status: questionMastery[questionKey] ? "tested" : "untested",
      mastery: questionMastery[questionKey]?.masteryScore ?? null
    });
  }

  const knowledgePoints = {};
  for (const [knowledgePointId, entries] of grouped) {
    const stats = knowledgePointStats(entries);
    knowledgePoints[knowledgePointId] = {
      mastery: stats.mastery,
      tested: stats.tested,
      total: stats.total,
      coverage: stats.coverage
    };
  }

  const testedInBank = [...bankByKey.keys()].filter((questionKey) => questionMastery[questionKey]).length;
  const bankSize = bankByKey.size;

  const weaknesses = Object.entries(questionMastery)
    .filter(([, entry]) => Number.isFinite(entry.masteryScore))
    .map(([questionKey, entry]) => ({
      questionKey,
      knowledgePointId: entry.knowledgePointId,
      masteryScore: entry.masteryScore,
      lastScoredLocalDate: entry.lastScoredLocalDate
    }))
    .sort(compareWeakness(knowledgePoints));

  const nextReview = [
    ...weaknesses.map((entry) => ({ questionKey: entry.questionKey, reason: "low_mastery" })),
    ...[...bankByKey.values()]
      .filter((item) => !questionMastery[text(item?.questionKey)] && evidenceOf(item?.evidence) === EXPLICIT_EVIDENCE)
      .map((item) => ({ questionKey: text(item.questionKey), reason: "untested" }))
  ].slice(0, 5);

  const last = scored.at(-1) ?? null;
  return {
    schemaVersion: SCHEMA_VERSION,
    userId: text(last?.userId),
    username: text(last?.username),
    generatedAt: now(),
    resumeVersion: text(questionBank?.resumeVersion),
    headEventId: text(last?.eventId),
    sourceEventKeys,
    questionMastery,
    knowledgePoints,
    coverage: {
      tested: testedInBank,
      total: bankSize,
      ratio: bankSize ? testedInBank / bankSize : 0
    },
    recentIssues: recent.slice(-RECENT_ISSUE_LIMIT),
    weaknesses,
    nextReview
  };
}
