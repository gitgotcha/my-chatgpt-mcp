// RDS V2 algorithm-domain projection rules (Rev 6 plan T07). The reducer is
// pure: it declares a bounded read plan (three point lookups) and computes
// row changes from those rows plus the head. Learning events accumulate
// counters and never replay history; consulted outcomes are neutral evidence
// and can never create a weakness on their own.
import { canonicalJson } from "../../../../../shared/rds2-protocol.mjs";

export const NEGATIVE_OUTCOMES = new Set(["incorrect", "stuck", "partial"]);
export const POSITIVE_OUTCOMES = new Set(["completed", "correct"]);

// Row kinds fixed for the algorithm projection. No weakness rows exist here:
// weaknesses are a read-time view over negative counters, never a stored
// artifact a `consulted` event could create.
export const ALGORITHM_ROW_KINDS = Object.freeze([
  "topic", "problem", "topic_problem", "evidence", "daily_plan"
]);

const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

// V1 parity: problems are identified by "source:title" — never renumbered.
export function problemIdOf(event) {
  const title = text(event?.problem?.title);
  if (!title) return null;
  const source = text(event?.problem?.source);
  return source ? `${source}:${title}` : title;
}

// V1 parity: latest is compared by (observedAt, eventId), so a late-arriving
// older result can never overwrite a newer one.
export function compareCandidates(left, right) {
  const at = String(left.observedAt ?? "").localeCompare(String(right.observedAt ?? ""));
  return at || String(left.eventId ?? "").localeCompare(String(right.eventId ?? ""));
}

export function latestWins(current, candidate) {
  if (!current) return candidate;
  return compareCandidates(candidate, current) > 0 ? candidate : current;
}

export function updateTopic(previous, event) {
  const next = { attempts: 0, negative: 0, positive: 0, neutral: 0, ...previous };
  next.attempts += 1;
  if (NEGATIVE_OUTCOMES.has(event.outcome)) next.negative += 1;
  else if (POSITIVE_OUTCOMES.has(event.outcome)) next.positive += 1;
  else next.neutral += 1;
  return next;
}

function learningOf(event) {
  if (event.eventType !== "algorithm.learning.completed") return null;
  return event.payload?.event ?? {};
}

function planOf(event) {
  if (event.eventType !== "algorithm.daily-plan-created") return null;
  return event.payload?.event ?? {};
}

export const algorithmReducer = {
  // Bounded read plan: three point lookups on the active generation, however
  // long the history grows. No scans, no full-history aggregation.
  reads({ event }) {
    const learning = learningOf(event);
    if (!learning) return [];
    const topic = text(learning.topic);
    const problemId = problemIdOf(learning);
    const reads = [{ as: "topic", rowKind: "topic", rowKey: topic }];
    if (problemId) {
      reads.push({ as: "problem", rowKind: "problem", rowKey: problemId });
      reads.push({ as: "topicProblem", rowKind: "topic_problem", rowKey: problemId, memberKey: topic });
    }
    return reads;
  },

  plan({ event, head, rows = {} }) {
    const learning = learningOf(event);
    if (!learning) {
      const plan = planOf(event);
      if (!plan) {
        const error = new Error("unsupported_algorithm_event");
        error.code = "unsupported_algorithm_event";
        throw error;
      }
      // A daily plan is stored as an immutable row; it never changes the
      // learning counters.
      return {
        rowChanges: [{
          rowKind: "daily_plan",
          rowKey: plan.planId,
          memberKey: plan.localDate,
          sortKey: plan.localDate,
          value: {
            localDate: plan.localDate, planId: plan.planId, timezone: plan.timezone,
            generatedAt: plan.generatedAt, items: plan.items
          }
        }],
        summary: head.summary
          ? { ...head.summary, headEventId: event.eventId }
          : null
      };
    }

    const topic = text(learning.topic);
    const outcome = learning.outcome;
    const previousTopic = rows.topic?.value ?? null;
    const topicValue = {
      ...updateTopic(previousTopic, { outcome }),
      lastOutcome: outcome,
      lastObservedAt: learning.observedAt,
      lastEventId: event.eventId
    };
    // The stored counters are cumulative; lastOutcome/lastObservedAt only
    // move forward by the (observedAt, eventId) comparison.
    const previousLatest = previousTopic?.lastObservedAt
      ? { observedAt: previousTopic.lastObservedAt, eventId: previousTopic.lastEventId, outcome: previousTopic.lastOutcome }
      : null;
    const winningLatest = latestWins(previousLatest, {
      observedAt: learning.observedAt, eventId: event.eventId, outcome
    });
    topicValue.lastOutcome = winningLatest.outcome;
    topicValue.lastObservedAt = winningLatest.observedAt;
    topicValue.lastEventId = winningLatest.eventId;

    const problemId = problemIdOf(learning);
    const rowChanges = [{
      rowKind: "topic", rowKey: topic, sortKey: topic, value: topicValue
    }, {
      rowKind: "evidence",
      rowKey: event.eventKey,
      memberKey: topic,
      sortKey: String(event.eventSeq).padStart(20, "0"),
      value: {
        observedAt: learning.observedAt, outcome, topic, problemId,
        source: learning.source ?? null, confidence: learning.confidence ?? null
      }
    }];
    if (problemId) {
      const previousProblem = rows.problem?.value ?? null;
      rowChanges.push({
        rowKind: "problem",
        rowKey: problemId,
        sortKey: topic,
        value: {
          title: learning.problem?.title ?? null,
          source: learning.problem?.source ?? null,
          url: learning.problem?.url ?? null,
          latest: latestWins(previousProblem?.latest ?? null, {
            observedAt: learning.observedAt, eventId: event.eventId, outcome
          })
        }
      });
      if (!rows.topicProblem) {
        rowChanges.push({
          rowKind: "topic_problem", rowKey: problemId, memberKey: topic, sortKey: topic, value: {}
        });
      }
    }

    const previousCounts = head.summary?.counts ?? null;
    return {
      rowChanges,
      summary: {
        identity: { userId: event.userId, username: event.username },
        headEventId: event.eventId,
        currentTopic: topic,
        counts: updateTopic(previousCounts, { outcome })
      }
    };
  },

  // Paged rebuild fold. Accumulators ride in the continuation; events are
  // consumed in bounded groups so row changes never exceed the commit limit.
  buildPage({ events, continuation }) {
    const accumulators = continuation.topics ? continuation : {
      topics: {}, problems: {}, counts: { attempts: 0, negative: 0, positive: 0, neutral: 0 },
      stagedCount: 0, nextEventSeq: continuation.nextEventSeq, page: continuation.page ?? 1
    };
    const rowChanges = [];
    let processed = 0;
    let summaryOfLast = null;
    for (const event of events) {
      const learning = learningOf(event);
      if (learning) {
        const topic = text(learning.topic);
        const problemId = problemIdOf(learning);
        accumulators.topics[topic] = updateTopic(accumulators.topics[topic] ?? null, { outcome: learning.outcome });
        accumulators.counts = updateTopic(accumulators.counts, { outcome: learning.outcome });
        const topicValue = {
          ...accumulators.topics[topic],
          lastOutcome: learning.outcome,
          lastObservedAt: learning.observedAt,
          lastEventId: event.eventId
        };
        const previousLatest = accumulators.latestByTopic?.[topic] ?? null;
        const winning = latestWins(previousLatest, {
          observedAt: learning.observedAt, eventId: event.eventId, outcome: learning.outcome
        });
        accumulators.latestByTopic = accumulators.latestByTopic ?? {};
        accumulators.latestByTopic[topic] = winning;
        topicValue.lastOutcome = winning.outcome;
        topicValue.lastObservedAt = winning.observedAt;
        topicValue.lastEventId = winning.eventId;
        accumulators.topics[topic] = topicValue;
        if (problemId) {
          const previousProblem = accumulators.problems[problemId] ?? null;
          accumulators.problems[problemId] = {
            title: learning.problem?.title ?? null,
            source: learning.problem?.source ?? null,
            url: learning.problem?.url ?? null,
            latest: latestWins(previousProblem?.latest ?? null, {
              observedAt: learning.observedAt, eventId: event.eventId, outcome: learning.outcome
            })
          };
        }
        rowChanges.push({
          rowKind: "topic", rowKey: topic, sortKey: topic, value: accumulators.topics[topic]
        }, {
          rowKind: "evidence",
          rowKey: event.eventKey,
          memberKey: topic,
          sortKey: String(event.eventSeq).padStart(20, "0"),
          value: {
            observedAt: learning.observedAt, outcome: learning.outcome, topic, problemId,
            source: learning.source ?? null, confidence: learning.confidence ?? null
          }
        });
        if (problemId) {
          rowChanges.push({
            rowKind: "problem", rowKey: problemId, sortKey: topic, value: accumulators.problems[problemId]
          }, {
            rowKind: "topic_problem", rowKey: problemId, memberKey: topic, sortKey: topic, value: {}
          });
        }
        summaryOfLast = {
          identity: { userId: event.userId, username: event.username },
          headEventId: event.eventId,
          currentTopic: topic,
          counts: accumulators.counts
        };
      } else {
        const plan = planOf(event);
        if (plan) {
          rowChanges.push({
            rowKind: "daily_plan", rowKey: plan.planId, memberKey: plan.localDate,
            sortKey: plan.localDate,
            value: {
              localDate: plan.localDate, planId: plan.planId, timezone: plan.timezone,
              generatedAt: plan.generatedAt, items: plan.items
            }
          });
          summaryOfLast = null;
        }
      }
      processed += 1;
      // The commit bound is 20 row changes; leave the rest for the next page.
      if (rowChanges.length > 20 - 4) break;
    }
    if (processed === 0 && events.length > 0) {
      const error = new Error("changes_too_large");
      error.code = "changes_too_large";
      throw error;
    }
    const consumed = events.slice(0, processed);
    const nextEventSeq = consumed.length
      ? consumed[consumed.length - 1].eventSeq + 1
      : continuation.nextEventSeq;
    return {
      rowChanges,
      summary: summaryOfLast,
      continuation: {
        ...accumulators,
        nextEventSeq,
        stagedCount: accumulators.stagedCount + consumed.length,
        page: (continuation.page ?? 1) + 1
      }
    };
  }
};

export function canonicalTopicValue(topicValue) {
  return canonicalJson(topicValue);
}
