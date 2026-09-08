// T12 interview projection primitives.
//
// Version selection and profile contribution semantics are delegated to the
// reviewed V1 model.  The V2 surface persists the selected review and each
// contribution as independently addressable rows; a compact continuation
// carries the review history needed by the pure Oracle for the current build.
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

function compareReview(left, right) {
  const version = (Number(left?.reviewVersion) || 0) - (Number(right?.reviewVersion) || 0);
  if (version !== 0) return version;
  const completed = String(left?.completedAt ?? "").localeCompare(String(right?.completedAt ?? ""));
  return completed || String(left?.eventId ?? "").localeCompare(String(right?.eventId ?? ""));
}

function selectedReviews(events) {
  const selected = new Map();
  for (const candidate of events) {
    const source = sourceEventOf(candidate);
    if (source?.eventType !== "interview.review.completed") continue;
    if (source.applyProfileChanges !== true) continue;
    const current = selected.get(source.sessionId);
    if (!current || compareReview(source, current) >= 0) selected.set(source.sessionId, source);
  }
  return selected;
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

  buildPage({ events = [], continuation = {} } = {}) {
    const history = Array.isArray(continuation.reviewEvents)
      ? structuredClone(continuation.reviewEvents) : [];
    const known = new Set(history.map((item) => item.eventKey));
    const rowChanges = [];
    let processed = 0;
    let nextEventSeq = continuation.nextEventSeq;
    for (const candidate of events) {
      const source = structuredClone(sourceEventOf(candidate));
      if (!source || typeof source !== "object") continue;
      if (source.eventKey && !known.has(source.eventKey)) {
        history.push(source);
        known.add(source.eventKey);
      }
      const eventSeq = Number(candidate?.eventSeq);
      if (Number.isSafeInteger(eventSeq)) nextEventSeq = eventSeq + 1;
      else if (Number.isSafeInteger(nextEventSeq)) nextEventSeq += 1;

      if (source.eventType === "interview.session.completed" && source.sessionId) {
        rowChanges.push({
          rowKind: "session", rowKey: source.sessionId, sortKey: String(source.completedAt ?? ""),
          value: source
        });
      } else if (source.eventType === "interview.review.completed" && source.sessionId) {
        const reviewKey = reviewKeyOf(source);
        rowChanges.push({
          rowKind: "review", rowKey: reviewKey, sortKey: String(source.completedAt ?? ""),
          value: source
        });
        const selected = selectedReviews(history).get(source.sessionId);
        if (selected?.eventKey === source.eventKey) {
          rowChanges.push({
            rowKind: "selected_review", rowKey: source.sessionId,
            sortKey: String(source.completedAt ?? ""),
            value: {
              sessionId: source.sessionId, reviewVersion: source.reviewVersion,
              eventId: source.eventId, eventKey: source.eventKey,
              applyProfileChanges: source.applyProfileChanges
            }
          });
          for (const [index, change] of (source.profileChanges ?? []).entries()) {
            rowChanges.push({
              rowKind: "contribution", rowKey: `${source.eventKey}:${index}`,
              memberKey: change.weaknessId ?? change.competencyId ?? change.id ?? null,
              sortKey: `${String(source.completedAt ?? "")}\u0000${index}`,
              value: { sessionId: source.sessionId, reviewVersion: source.reviewVersion,
                eventId: source.eventId, eventKey: source.eventKey, change }
            });
          }
        }
      }
      processed += 1;
      if (rowChanges.length > 16) break;
    }
    if (processed === 0 && events.length > 0) {
      const error = new Error("changes_too_large");
      error.code = "changes_too_large";
      throw error;
    }
    const summary = reduceInterviewProfile(history);
    return {
      rowChanges,
      summary,
      continuation: {
        nextEventSeq,
        page: (continuation.page ?? 1) + 1,
        reviewEvents: history
      }
    };
  }
});

export { sourceEventOf, reviewKeyOf };
