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

// V1 parity: the topic<->problem relation is identified by BOTH the topic and
// the problem. The same problem practised under two topics is two relations,
// so the row key carries both — writes and point lookups MUST use this single
// derivation (canonical array encoding, stable and reversible).
export function topicProblemRowKey(topic, problemId) {
  return canonicalJson([topic ?? "", problemId ?? ""]);
}

// The learning summary elects its head by V1's comparator — (observedAt, then
// eventId) — never by arrival order. `latest` is that sort key; `headEventId`
// and `currentTopic` are derived from it, and `lastReceivedEventId` records
// receipt order as a SEPARATE diagnostic field.
function latestKeyOf(summary) {
  if (!summary) return null;
  if (summary.latest) return summary.latest;
  // A summary written before the sort key existed: keep its head but never
  // let it outrank an event we can actually compare.
  return summary.headEventId
    ? { observedAt: null, eventId: summary.headEventId, topic: summary.currentTopic ?? null }
    : null;
}

function electedSummary({ previous, event, topic, outcome }) {
  const candidate = { observedAt: event.observedAt, eventId: event.eventId, topic };
  const winner = latestWins(latestKeyOf(previous), candidate);
  const identity = winner === candidate || !previous?.identity
    ? { userId: event.userId ?? null, username: event.username ?? null }
    : previous.identity;
  return {
    identity,
    headEventId: winner.eventId,
    currentTopic: winner.topic,
    latest: winner,
    lastReceivedEventId: event.eventId,
    counts: updateTopic(previous?.counts ?? null, { outcome })
  };
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
      reads.push({ as: "topicProblem", rowKind: "topic_problem", rowKey: topicProblemRowKey(topic, problemId), memberKey: topic });
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
      // learning counters and never moves the learning head — receipt order
      // is recorded in its own field.
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
          ? { ...head.summary, lastReceivedEventId: event.eventId }
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
          rowKind: "topic_problem", rowKey: topicProblemRowKey(topic, problemId), memberKey: topic, sortKey: topic, value: {}
        });
      }
    }

    return {
      rowChanges,
      summary: electedSummary({
        previous: head.summary,
        event: {
          eventId: event.eventId, observedAt: learning.observedAt,
          userId: event.userId, username: event.username
        },
        topic,
        outcome
      })
    };
  },

  // Paged rebuild fold. Accumulators ride in the continuation; events are
  // consumed in bounded groups so row changes never exceed the commit limit.
  buildPage({ events, continuation }) {
    const accumulators = continuation.topics ? continuation : {
      topics: {}, problems: {}, counts: { attempts: 0, negative: 0, positive: 0, neutral: 0 },
      stagedCount: 0, nextEventSeq: continuation.nextEventSeq, page: continuation.page ?? 1,
      latest: null, headIdentity: null, lastReceivedEventId: null
    };
    const rowChanges = [];
    let processed = 0;
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
            rowKind: "topic_problem", rowKey: topicProblemRowKey(topic, problemId), memberKey: topic, sortKey: topic, value: {}
          });
        }
        // The fold elects the head with V1's comparator, exactly like the
        // incremental path: page order is arrival order, never seniority.
        const candidate = { observedAt: learning.observedAt, eventId: event.eventId, topic };
        const winner = latestWins(accumulators.latest ?? null, candidate);
        accumulators.latest = winner;
        if (winner === candidate) {
          accumulators.headIdentity = { userId: event.userId ?? null, username: event.username ?? null };
        }
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
          // A plan row contributes no learning head; an already accumulated
          // summary survives it.
        }
      }
      accumulators.lastReceivedEventId = event.eventId;
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
    // The head is elected over everything consumed so far, so a page ending
    // on a daily plan can never wipe the built summary.
    const summary = accumulators.latest
      ? {
          identity: accumulators.headIdentity ?? { userId: null, username: null },
          headEventId: accumulators.latest.eventId,
          currentTopic: accumulators.latest.topic,
          latest: accumulators.latest,
          lastReceivedEventId: accumulators.lastReceivedEventId,
          counts: accumulators.counts
        }
      : null;
    return {
      rowChanges,
      summary,
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
