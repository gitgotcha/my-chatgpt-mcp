// T13 resume-knowledge projection primitives.
//
// The scoring, issue extraction and question-bank evidence rules are reused
// from the reviewed V1 model.  V2 adds the server-derived business key and a
// bounded read declaration; the paged staged fold is intentionally explicit
// about its remaining integration dependency.
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

  buildPage() {
    const error = new Error("resume_knowledge_staged_question_paginator_required");
    error.code = "resume_knowledge_staged_question_paginator_required";
    throw error;
  }
});

export { sourceEventOf, questionKeyOf };

