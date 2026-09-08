// T12 interview projection primitives.
//
// Version selection and profile contribution semantics are delegated to the
// reviewed V1 model.  The V2 surface only declares bounded row reads and
// exposes a stable reducer contract; full staged contribution pagination is a
// later integration step and is refused explicitly rather than guessed.
import { rebuildInterviewProfile } from "../../profile-model.js";

export const INTERVIEW_ROW_KINDS = Object.freeze([
  "session", "review", "selected_review", "contribution", "weakness"
]);

function stableCode(error) {
  if (error && typeof error === "object" && !error.code && typeof error.message === "string") {
    error.code = error.message;
  }
  return error;
}

export function reduceInterviewProfile(events, options = {}) {
  try {
    return rebuildInterviewProfile(events, options);
  } catch (error) {
    throw stableCode(error);
  }
}

function sourceEventOf(event) {
  return event?.payload?.event ?? event?.event ?? event;
}

function reviewKeyOf(event) {
  const source = sourceEventOf(event) ?? {};
  return `${source.sessionId ?? ""}:v${source.reviewVersion ?? ""}`;
}

export function planInterviewPageReads(events = []) {
  const sessions = [];
  const reviews = [];
  for (const candidate of events) {
    const source = sourceEventOf(candidate);
    if (!source || typeof source !== "object") continue;
    if (source.eventType === "interview.session.completed" && typeof source.sessionId === "string") {
      sessions.push(source.sessionId);
    } else if (source.eventType === "interview.review.completed" && typeof source.sessionId === "string") {
      reviews.push(reviewKeyOf(source));
    }
  }
  return {
    reads: [
      { rowKind: "session", rowKeys: [...new Set(sessions)] },
      { rowKind: "review", rowKeys: [...new Set(reviews)] }
    ].filter((read) => read.rowKeys.length > 0),
    consumedCount: events.length
  };
}

export const interviewReducer = Object.freeze({
  reads({ event }) {
    return planInterviewPageReads([event]).reads.flatMap((read) =>
      read.rowKeys.map((rowKey) => ({ as: `${read.rowKind}:${rowKey}`, rowKind: read.rowKind, rowKey })));
  },

  plan() {
    return { rebuild: true, reason: "interview_review_version_selection" };
  },

  planPageReads({ events }) {
    return planInterviewPageReads(events);
  },

  buildPage() {
    const error = new Error("interview_staged_contribution_paginator_required");
    error.code = "interview_staged_contribution_paginator_required";
    throw error;
  }
});

export { sourceEventOf, reviewKeyOf };

