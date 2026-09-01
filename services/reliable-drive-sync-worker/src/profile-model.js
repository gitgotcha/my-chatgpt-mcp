const REVIEW_TYPE = "interview.review.completed";

const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const list = (value) => Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()) : [];

function statusOf(change) {
  const values = [change.status, change.result, change.outcome, change.action].filter(Boolean)
    .map((value) => String(value).toLowerCase());
  if (values.some((value) => ["failed", "failure", "fail", "incorrect", "wrong", "open"].includes(value))) return "open";
  if (values.some((value) => ["passed", "pass", "success", "correct", "improving", "close", "closed", "resolved"].includes(value))) return "pass";
  return null;
}

function compareEvents(left, right) {
  const at = String(left.completedAt ?? "").localeCompare(String(right.completedAt ?? ""));
  return at || String(left.eventId ?? "").localeCompare(String(right.eventId ?? ""));
}

function changeEvidence(change, event) {
  return [...new Set([
    ...list(change.evidenceRefs),
    ...list(change.evidenceRef ? [change.evidenceRef] : []),
    ...list(event.evidenceRefs)
  ])];
}

/** Rebuild the interview profile from verified, immutable review events only. */
export function rebuildInterviewProfile(events, { now = () => new Date().toISOString() } = {}) {
  const reviewEvents = (Array.isArray(events) ? events : [])
    .filter((event) => event?.schemaVersion === "1.2" && event.eventType === REVIEW_TYPE
      && text(event.eventId) && text(event.eventKey) && text(event.sessionId)
      && text(event.userId) && text(event.username));
  const candidates = reviewEvents
    .filter((event) => event.applyProfileChanges === true && Array.isArray(event.profileChanges))
    .sort(compareEvents);

  // A correction is a new immutable version, not an additional copy of the old review.
  const latestBySession = new Map();
  for (const event of candidates) {
    const current = latestBySession.get(event.sessionId);
    if (!current || (Number(event.reviewVersion) || 0) >= (Number(current.reviewVersion) || 0)) latestBySession.set(event.sessionId, event);
  }
  const approved = [...latestBySession.values()].sort(compareEvents);
  // Identity metadata comes from any verified review, including a review that
  // intentionally opted out of profile application. Otherwise a valid
  // profile_cache snapshot would lose its user binding when apply=false.
  const first = approved[0] ?? candidates[0] ?? reviewEvents[0] ?? {};
  const domainProfiles = {};
  const generalCompetencies = {};

  for (const event of approved) {
    for (const change of event.profileChanges) {
      if (!change || typeof change !== "object") continue;
      const weaknessId = text(change.weaknessId)
        || (text(change.kind)?.toLowerCase() === "weakness" ? text(change.id) : null)
        || (text(change.id)?.match(/^W[-_]/i) ? text(change.id) : null);
      const domain = text(change.domain) || text(change.domainId) || "general";
      const status = statusOf(change);
      const evidenceRefs = changeEvidence(change, event);
      const confidence = text(change.evidenceConfidence) || text(event.evidenceConfidence);
      const sessionId = event.sessionId;
      const variantId = text(change.variantId) || text(change.variant) || text(change.questionId);

      if (!weaknessId) {
        const competencyId = text(change.competencyId) || text(change.id) || text(change.name);
        if (!competencyId) continue;
        const current = generalCompetencies[competencyId] ?? { status: "observed", evidenceRefs: [], confidence: null };
        if (status) current.status = status === "open" ? "needs_work" : "demonstrated";
        current.evidenceRefs = [...new Set([...current.evidenceRefs, ...evidenceRefs])];
        current.confidence = confidence || current.confidence;
        if (change.level !== undefined) current.level = change.level;
        generalCompetencies[competencyId] = current;
        continue;
      }

      const profile = domainProfiles[domain] ?? { weaknesses: {} };
      const weakness = profile.weaknesses[weaknessId] ?? {
        status: "open", passingSessionIds: [], passingVariantIds: [], evidenceRefs: [], confidence: null
      };
      if (status === "open") weakness.status = "open";
      if (status === "pass") {
        if (!weakness.passingSessionIds.includes(sessionId)) weakness.passingSessionIds.push(sessionId);
        if (variantId && !weakness.passingVariantIds.includes(variantId)) weakness.passingVariantIds.push(variantId);
        weakness.status = weakness.passingSessionIds.length >= 2 && weakness.passingVariantIds.length >= 2 ? "closed" : "improving";
      }
      weakness.evidenceRefs = [...new Set([...weakness.evidenceRefs, ...evidenceRefs])];
      weakness.confidence = confidence || weakness.confidence;
      if (change.title !== undefined) weakness.title = change.title;
      profile.weaknesses[weaknessId] = weakness;
      domainProfiles[domain] = profile;
    }
  }

  return {
    schemaVersion: "1.2",
    userId: first.userId,
    username: first.username,
    generatedAt: now(),
    headEventId: approved.at(-1)?.eventId ?? null,
    sourceEventKeys: approved.map((event) => event.eventKey),
    domainProfiles,
    generalCompetencies
  };
}
