const LEARNING_TYPE = "algorithm.learning.completed";

// Outcomes with mastery evidence. `consulted` is deliberately absent: asking
// for an explanation proves nothing about mastery and must never create a
// weakness on its own.
const NEGATIVE_OUTCOMES = new Set(["incorrect", "stuck", "partial"]);
const POSITIVE_OUTCOMES = new Set(["completed", "correct"]);

const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;

function compareEvents(left, right) {
  const at = String(left.observedAt ?? "").localeCompare(String(right.observedAt ?? ""));
  return at || String(left.eventId ?? "").localeCompare(String(right.eventId ?? ""));
}

function problemIdOf(event) {
  const title = text(event?.problem?.title);
  if (!title) return null;
  const source = text(event?.problem?.source);
  return source ? `${source}:${title}` : title;
}

/** Rebuild the append-only algorithm profile from verified learning events. */
export function rebuildAlgorithmProfile(events, { now = () => new Date().toISOString() } = {}) {
  const learning = (Array.isArray(events) ? events : [])
    .filter((event) => event?.schemaVersion === "1.2" && event.eventType === LEARNING_TYPE
      && text(event.eventId) && text(event.eventKey) && text(event.topic) && text(event.observedAt));

  const byKey = new Map();
  for (const event of [...learning].sort(compareEvents)) {
    if (!byKey.has(event.eventKey)) byKey.set(event.eventKey, event);
  }
  const ordered = [...byKey.values()].sort(compareEvents);

  const topicMastery = {};
  const latestByProblem = new Map();

  for (const event of ordered) {
    const topic = event.topic;
    const mastery = topicMastery[topic] ?? {
      attempts: 0, negative: 0, positive: 0, neutral: 0,
      lastOutcome: null, lastObservedAt: null, problemIds: [], eventKeys: []
    };
    mastery.attempts += 1;
    if (NEGATIVE_OUTCOMES.has(event.outcome)) mastery.negative += 1;
    else if (POSITIVE_OUTCOMES.has(event.outcome)) mastery.positive += 1;
    else mastery.neutral += 1;
    mastery.lastOutcome = event.outcome;
    mastery.lastObservedAt = event.observedAt;
    mastery.eventKeys.push(event.eventKey);

    const problemId = problemIdOf(event);
    if (problemId) {
      if (!mastery.problemIds.includes(problemId)) mastery.problemIds.push(problemId);
      latestByProblem.set(problemId, event);
    }
    topicMastery[topic] = mastery;
  }

  const weaknesses = Object.entries(topicMastery)
    .filter(([, mastery]) => mastery.negative > 0)
    .sort((left, right) => (right[1].negative - left[1].negative)
      || String(left[0]).localeCompare(String(right[0])))
    .map(([topic, mastery]) => ({
      topic,
      status: mastery.positive > 0 ? "improving" : "open",
      negative: mastery.negative,
      positive: mastery.positive,
      lastOutcome: mastery.lastOutcome,
      lastObservedAt: mastery.lastObservedAt,
      evidenceEventKeys: [...mastery.eventKeys]
    }));

  // A problem stays pending until its most recent verified outcome is positive.
  const pendingProblemIds = [...latestByProblem.entries()]
    .filter(([, event]) => !POSITIVE_OUTCOMES.has(event.outcome))
    .map(([problemId]) => problemId);

  const last = ordered.at(-1);
  return {
    schemaVersion: "1.2",
    userId: last?.userId ?? null,
    username: last?.username ?? null,
    generatedAt: now(),
    headEventId: last?.eventId ?? null,
    sourceEventKeys: ordered.map((event) => event.eventKey),
    currentTopic: last?.topic ?? null,
    topicMastery,
    weaknesses,
    pendingProblemIds
  };
}
