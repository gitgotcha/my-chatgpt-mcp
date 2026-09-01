import { rebuildInterviewProfile } from "./profile-model.js";

const SESSION_ID = /^(MOCK|REAL)-[^/\\]+$/;
const validSessionId = (value) => typeof value === "string" && SESSION_ID.test(value);
const validReviewVersion = (value) => Number.isInteger(value) && value > 0;
const hasOnlyParent = (file, parentId) => Array.isArray(file?.parents) && file.parents.length === 1 && file.parents[0] === parentId;

function eventVersionMatchesKey(event) {
  const match = /(?:^|[:_-])v(\d+)$/i.exec(event.eventKey);
  return Boolean(match) && Number(match[1]) === event.reviewVersion;
}

export function createInterviewStore({ eventStore, drive, layout, now = () => new Date().toISOString() }) {
  if (!eventStore?.appendEvent || !eventStore?.listVerifiedEvents) throw new Error("invalid_interview_store");

  async function events(identity) {
    return eventStore.listVerifiedEvents(identity);
  }

  async function listSessions(identity) {
    const verified = await events(identity);
    const reviews = new Set(verified.filter((event) => event.eventType === "interview.review.completed" && typeof event.sessionId === "string"
      && Number.isInteger(event.reviewVersion) && event.reviewVersion > 0).map((event) => event.sessionId));
    const sessionIds = new Set();
    return verified.filter((event) => event.eventType === "interview.session.completed" && validSessionId(event.sessionId) && !sessionIds.has(event.sessionId) && sessionIds.add(event.sessionId))
      .map((event) => ({ sessionId: event.sessionId, interviewType: event.interviewType, domain: event.domain, completedAt: event.completedAt, hasReview: reviews.has(event.sessionId) }));
  }

  async function loadSession(identity, sessionId) {
    if (!validSessionId(sessionId)) throw new Error("invalid_session_id");
    const verified = await events(identity);
    const session = verified.find((event) => event.eventType === "interview.session.completed" && event.sessionId === sessionId);
    if (!session) throw new Error("not_found");
    const reviews = verified.filter((event) => event.eventType === "interview.review.completed" && event.sessionId === sessionId
      && Number.isInteger(event.reviewVersion) && event.reviewVersion > 0)
      .sort((left, right) => left.reviewVersion - right.reviewVersion);
    return { session, reviews };
  }

  async function submitSession(identity, event) {
    if (!event || event.eventType !== "interview.session.completed") throw new Error("invalid_event_type");
    if (!validSessionId(event.sessionId)) throw new Error("invalid_session_id");
    return eventStore.appendEvent(identity, event);
  }

  async function createSnapshot(identity, snapshot) {
    if (!drive?.createJson || !drive.readJson) throw new Error("snapshot_store_unavailable");
    if (!layout?.ensureDomainPath) throw new Error("snapshot_store_unavailable");
    const snapshots = await layout.ensureDomainPath(identity.userId, "interview", ["profile", "snapshots"]);
    const safeTime = String(snapshot.generatedAt).replace(/[:.]/g, "-");
    const name = `snapshot-${safeTime}-${snapshot.headEventId ?? "00000000-0000-4000-8000-000000000000"}.json`;
    const created = await drive.createJson(snapshots.id, name, snapshot);
    const read = await drive.readJson(created.id);
    if (!read || read.id !== created.id || read.name !== name || !hasOnlyParent(read, snapshots.id)
      || JSON.stringify(read.value) !== JSON.stringify(snapshot)) throw new Error("snapshot_readback_failed");
    return { fileId: read.id, name: read.name };
  }

  async function submitReview(identity, event, options = {}) {
    if (!event || event.eventType !== "interview.review.completed") throw new Error("invalid_event_type");
    if (!validSessionId(event.sessionId)) throw new Error("invalid_session_id");
    if (!validReviewVersion(event.reviewVersion) || !eventVersionMatchesKey(event)) throw new Error("invalid_review_version");
    if (event.sourceSessionEventId !== undefined && typeof event.sourceSessionEventId !== "string") throw new Error("invalid_source_session");
    const verified = await events(identity);
    const source = verified.find((candidate) => candidate.eventType === "interview.session.completed"
      && candidate.sessionId === event.sessionId && candidate.eventId === event.sourceSessionEventId);
    if (!source) throw new Error("source_session_not_found");
    if (source.userId !== identity.userId || source.username !== identity.username) throw new Error("identity_mismatch");

    let receipt;
    let persistedEvent;
    try {
      const appended = await eventStore.appendEvent(identity, event);
      receipt = appended.receipt;
      persistedEvent = appended.event;
      if (!receipt?.fileId || appended.event?.eventKey !== event.eventKey) throw new Error("event_readback_failed");
    } catch (cause) {
      const failure = new Error("cloud_persistence_pending");
      failure.cause = cause;
      throw failure;
    }

    try {
      const allVerified = [...verified];
      if (!allVerified.some((candidate) => candidate.eventId === persistedEvent.eventId)) allVerified.push(persistedEvent);
      const profile = rebuildInterviewProfile(allVerified, { now });
      const snapshotReceipt = options.createSnapshot
        ? await options.createSnapshot(profile, { identity, event })
        : await createSnapshot(identity, profile);
      return { status: "ok", receipt, data: { profile, snapshotReceipt } };
    } catch (cause) {
      console.error("profile_snapshot_failed", cause instanceof Error ? cause.message : String(cause));
      return { status: "profile_cache_pending", receipt, data: { profileRebuildRequired: true } };
    }
  }

  return { submitSession, submitReview, listSessions, loadSession };
}
