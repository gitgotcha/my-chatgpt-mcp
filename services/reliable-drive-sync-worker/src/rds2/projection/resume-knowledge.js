// T13 resume-knowledge projection primitives.
//
// The scoring, issue extraction and question-bank evidence rules are reused
// from the reviewed V1 model. V2 persists bank/question/first-score/mastery
// rows while the pure Oracle computes the public summary for each page.
import { canonicalJson } from "../../../../../shared/rds2-protocol.mjs";
import { rebuildResumeKnowledgeProfile } from "../../resume-knowledge-model.js";

export const RESUME_KNOWLEDGE_ROW_KINDS = Object.freeze([
  "resume", "claim", "bank", "question", "first_score", "mastery"
]);

function stableCode(error) {
  if (error && typeof error === "object" && !error.code && typeof error.message === "string") {
    error.code = error.message;
  }
  return error;
}

export function businessDedupeKey(event) {
  return canonicalJson([
    event?.userId ?? "",
    event?.eventType ?? "resume-knowledge.answer-scored",
    event?.questionKey ?? "",
    event?.localDate ?? ""
  ]);
}

export function reduceResumeKnowledgeProfile(events, questionBank, options = {}) {
  if (!questionBank || typeof questionBank.resumeVersion !== "string"
    || !questionBank.resumeVersion.trim() || !Array.isArray(questionBank.questions)
    || questionBank.questions.length === 0) {
    return { status: "resume_required" };
  }
  try {
    return rebuildResumeKnowledgeProfile(events, questionBank, options);
  } catch (error) {
    throw stableCode(error);
  }
}

function sourceEventOf(event) {
  return event?.payload?.event ?? event?.event ?? event;
}

function questionKeyOf(event) {
  return sourceEventOf(event)?.questionKey ?? null;
}

export function planResumeKnowledgePageReads(events = []) {
  const questionKeys = [];
  for (const candidate of events) {
    const key = questionKeyOf(candidate);
    if (typeof key === "string" && key.trim()) questionKeys.push(key);
  }
  const keys = [...new Set(questionKeys)];
  return {
    reads: keys.length
      ? [
          { rowKind: "question", rowKeys: keys },
          { rowKind: "mastery", rowKeys: keys }
        ]
      : [],
    consumedCount: events.length
  };
}

export const resumeKnowledgeReducer = Object.freeze({
  reads({ event }) {
    return planResumeKnowledgePageReads([event]).reads.flatMap((read) =>
      read.rowKeys.map((rowKey) => ({ as: `${read.rowKind}:${rowKey}`, rowKind: read.rowKind, rowKey })));
  },

  plan() {
    return { rebuild: true, reason: "resume_first_score_and_mastery" };
  },

  planPageReads({ events }) {
    return planResumeKnowledgePageReads(events);
  },

  buildPage({ events = [], continuation = {} } = {}) {
    const scoreEvents = Array.isArray(continuation.scoreEvents)
      ? structuredClone(continuation.scoreEvents) : [];
    const seen = new Set(scoreEvents.map((item) => item.eventKey));
    let questionBank = continuation.questionBank ? structuredClone(continuation.questionBank) : null;
    const rowChanges = [];
    let processed = 0;
    let nextEventSeq = continuation.nextEventSeq;
    for (const candidate of events) {
      const source = structuredClone(sourceEventOf(candidate));
      if (!source || typeof source !== "object") continue;
      const eventSeq = Number(candidate?.eventSeq);
      if (Number.isSafeInteger(eventSeq)) nextEventSeq = eventSeq + 1;
      else if (Number.isSafeInteger(nextEventSeq)) nextEventSeq += 1;

      if (source.eventType === "resume-knowledge.question-bank-created") {
        const currentVersion = String(questionBank?.resumeVersion ?? "");
        if (!questionBank || String(source.resumeVersion ?? "") >= currentVersion) {
          questionBank = {
            resumeVersion: source.resumeVersion,
            questions: structuredClone(source.questions ?? [])
          };
        }
        rowChanges.push({
          rowKind: "bank", rowKey: source.resumeVersion,
          sortKey: String(source.generatedAt ?? ""), value: questionBank
        });
        for (const question of source.questions ?? []) {
          if (!question?.questionKey) continue;
          rowChanges.push({
            rowKind: "question", rowKey: question.questionKey,
            memberKey: question.knowledgePointId ?? null,
            sortKey: question.questionKey, value: { ...question, resumeVersion: source.resumeVersion }
          });
        }
      }
      if (source.eventType === "resume-knowledge.answer-scored" && source.eventKey && !seen.has(source.eventKey)) {
        scoreEvents.push(source);
        seen.add(source.eventKey);
        const key = businessDedupeKey(source);
        rowChanges.push({
          rowKind: "first_score", rowKey: key,
          memberKey: source.questionKey, sortKey: `${source.localDate}\u0000${source.scoredAt ?? ""}`,
          value: { ...source, businessDedupeKey: key }
        });
      }
      processed += 1;
      if (rowChanges.length > 14) break;
    }
    if (processed === 0 && events.length > 0) {
      const error = new Error("changes_too_large");
      error.code = "changes_too_large";
      throw error;
    }
    const summary = reduceResumeKnowledgeProfile(scoreEvents, questionBank);
    if (summary.status !== "resume_required") {
      for (const [questionKey, mastery] of Object.entries(summary.questionMastery ?? {})) {
        rowChanges.push({
          rowKind: "mastery", rowKey: questionKey, memberKey: mastery.knowledgePointId,
          sortKey: questionKey, value: mastery
        });
      }
    }
    return {
      rowChanges,
      summary,
      continuation: {
        nextEventSeq: processed > 0 ? nextEventSeq : continuation.nextEventSeq,
        page: (continuation.page ?? 1) + 1,
        questionBank,
        scoreEvents
      }
    };
  }
});

export { sourceEventOf, questionKeyOf };
