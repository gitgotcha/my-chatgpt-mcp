// Materialisation for the resume-knowledge domain.
//
// The Worker is the only writer. Every projection here follows the same
// discipline: resolve the canonical folder through the storage layout, create
// the file, read it back and verify both its single parent and its content.
// A failed projection never rewrites the event that produced it.
//
// Materialised paths (design spec section 5):
//   users/<userId>/resume-knowledge/sources/resume/snapshots/resume-<version>-<fingerprint>.json
//   users/<userId>/resume-knowledge/question-bank/snapshots/question-bank-<version>-<eventId>.json
//   users/<userId>/resume-knowledge/events/event-<eventId>.json
//   users/<userId>/resume-knowledge/profile/snapshots/snapshot-<UTC>-<headEventId>.json
//   users/<userId>/resume-knowledge/plans/daily/daily-plan-<localDate>-<planId>.json

import { firstScorePerDay, rebuildResumeKnowledgeProfile, scoringKey } from "./resume-knowledge-model.js";

const DOMAIN = "resume-knowledge";

const RESUME_SNAPSHOTS = ["sources", "resume", "snapshots"];
const QUESTION_BANK_SNAPSHOTS = ["question-bank", "snapshots"];
const PROFILE_SNAPSHOTS = ["profile", "snapshots"];
const DAILY_PLANS = ["plans", "daily"];

const ZERO_EVENT_ID = "00000000-0000-4000-8000-000000000000";
const QUESTION_BANK_FILE = /^question-bank-[0-9a-z._-]+\.json$/i;

const hasOnlyParent = (file, parentId) => Array.isArray(file?.parents) && file.parents.length === 1 && file.parents[0] === parentId;
const sameContent = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const safeTime = (value) => String(value).replace(/[:.]/g, "-");

export function createResumeKnowledgeStore({ eventStore, layout, drive, now = () => new Date().toISOString() }) {
  if (!eventStore?.appendEvent || !eventStore?.listVerifiedEvents) throw new Error("invalid_resume_knowledge_store");
  if (!layout?.ensureDomainPath || !layout?.findDomainPath) throw new Error("invalid_resume_knowledge_store");
  if (!drive?.createJson || !drive?.readJson || !drive?.listJson) throw new Error("invalid_resume_knowledge_store");

  /**
   * Create a projection, then read it back and verify its parent and content.
   * An existing file with identical content is reused so that a retry never
   * produces a second copy; a file with the same name but different content is
   * a conflict and stops the write.
   */
  async function materialize(identity, segments, name, value) {
    const folder = await layout.ensureDomainPath(identity.userId, DOMAIN, segments);
    const existing = (await drive.listJson(folder.id)).find((file) => file.name === name);
    if (existing) {
      const read = await drive.readJson(existing.id);
      if (!read || read.name !== name || !hasOnlyParent(read, folder.id)) throw new Error("projection_readback_failed");
      if (!sameContent(read.value, value)) throw new Error("projection_conflict");
      return { fileId: read.id, name: read.name, folderId: folder.id, reused: true };
    }
    const created = await drive.createJson(folder.id, name, value);
    const read = await drive.readJson(created.id);
    if (!read || read.id !== created.id || read.name !== name || !hasOnlyParent(read, folder.id)
      || !sameContent(read.value, value)) throw new Error("projection_readback_failed");
    return { fileId: read.id, name: read.name, folderId: folder.id, reused: false };
  }

  /**
   * The newest question bank snapshot. Later resume versions simply add newer
   * snapshots; they never overwrite the ones that older questions and plans
   * are still bound to.
   */
  async function latestQuestionBank(identity) {
    const folder = await layout.findDomainPath(identity.userId, DOMAIN, QUESTION_BANK_SNAPSHOTS);
    if (!folder) return null;
    const banks = [];
    for (const file of await drive.listJson(folder.id)) {
      if (!QUESTION_BANK_FILE.test(file.name)) continue;
      const read = await drive.readJson(file.id);
      if (!read || read.name !== file.name || !hasOnlyParent(read, folder.id)) continue;
      const value = read.value;
      if (!value || !Array.isArray(value.questions) || typeof value.resumeVersion !== "string") continue;
      banks.push({ file: read, value });
    }
    if (!banks.length) return null;
    banks.sort((left, right) => String(left.value.generatedAt ?? "").localeCompare(String(right.value.generatedAt ?? ""))
      || left.file.name.localeCompare(right.file.name));
    return banks.at(-1).value;
  }

  /**
   * A profile snapshot is a pure derivation of the events, so re-running the
   * reducer for a head event that already has a snapshot reuses it instead of
   * writing an unbounded number of identical files.
   */
  async function materializeSnapshot(identity, profile) {
    const folder = await layout.ensureDomainPath(identity.userId, DOMAIN, PROFILE_SNAPSHOTS);
    const headEventId = profile.headEventId ?? ZERO_EVENT_ID;
    const suffix = `-${headEventId}.json`;
    const existing = (await drive.listJson(folder.id)).find((file) => file.name.endsWith(suffix));
    if (existing) {
      const read = await drive.readJson(existing.id);
      if (!read || read.name !== existing.name || !hasOnlyParent(read, folder.id)) throw new Error("projection_readback_failed");
      return { fileId: read.id, name: read.name, folderId: folder.id, reused: true };
    }
    const name = `snapshot-${safeTime(profile.generatedAt)}-${headEventId}.json`;
    const created = await drive.createJson(folder.id, name, profile);
    const read = await drive.readJson(created.id);
    if (!read || read.id !== created.id || read.name !== name || !hasOnlyParent(read, folder.id)
      || !sameContent(read.value, profile)) throw new Error("projection_readback_failed");
    return { fileId: read.id, name: read.name, folderId: folder.id, reused: false };
  }

  async function ingestResume(identity, event) {
    const appended = await eventStore.appendEvent(identity, event);
    // Spec section 7: the original file is never stored, only the structured
    // claims, their evidence locations, the version and the fingerprint.
    const resumeSnapshot = {
      schemaVersion: "1.2",
      userId: event.userId,
      username: event.username,
      resumeVersion: event.resumeVersion,
      fingerprint: event.fingerprint,
      activatedAt: event.activatedAt,
      claims: event.claims,
      claimRelations: event.claimRelations,
      techTags: event.techTags,
      evidenceLocations: event.evidenceLocations,
      sourceEventId: event.eventId,
      sourceEventKey: event.eventKey
    };
    const projectionReceipt = await materialize(
      identity,
      RESUME_SNAPSHOTS,
      `resume-${event.resumeVersion}-${event.fingerprint}.json`,
      resumeSnapshot
    );
    return {
      status: "ok",
      event: appended.event,
      receipt: appended.receipt,
      data: { projectionReceipt, resumeSnapshot }
    };
  }

  // Spec section 6: a confirmed or rejected claim only records the decision.
  // It feeds the next question bank version through event replay; it never
  // rewrites the resume snapshot or an existing bank.
  async function recordClaimDecision(identity, event) {
    const appended = await eventStore.appendEvent(identity, event);
    return {
      status: "ok",
      event: appended.event,
      receipt: appended.receipt,
      data: {
        decision: event.eventType === "resume-knowledge.claim-rejected" ? "rejected" : "confirmed",
        claimId: event.claimId,
        resumeVersion: event.resumeVersion
      }
    };
  }

  async function saveQuestionBank(identity, event) {
    const appended = await eventStore.appendEvent(identity, event);
    const questionBank = {
      schemaVersion: "1.2",
      userId: event.userId,
      username: event.username,
      resumeVersion: event.resumeVersion,
      generatedAt: event.generatedAt,
      questions: event.questions,
      sourceEventId: event.eventId,
      sourceEventKey: event.eventKey
    };
    const projectionReceipt = await materialize(
      identity,
      QUESTION_BANK_SNAPSHOTS,
      `question-bank-${event.resumeVersion}-${event.eventId}.json`,
      questionBank
    );
    return {
      status: "ok",
      event: appended.event,
      receipt: appended.receipt,
      data: { projectionReceipt, questionBank }
    };
  }

  // Spec section 9: a day's plan is immutable once created, so a request for a
  // date that already has a plan returns the stored plan unchanged.
  async function getOrCreateDailyPlan(identity, event) {
    const questionBank = await latestQuestionBank(identity);
    if (!questionBank) {
      return { status: "resume_required", event, data: { reason: "question_bank_missing" } };
    }
    const folder = await layout.ensureDomainPath(identity.userId, DOMAIN, DAILY_PLANS);
    const prefix = `daily-plan-${event.localDate}-`;
    const existing = (await drive.listJson(folder.id))
      .filter((file) => file.name.startsWith(prefix))
      .sort((left, right) => left.name.localeCompare(right.name))[0];
    if (existing) {
      const read = await drive.readJson(existing.id);
      if (read && read.name === existing.name && hasOnlyParent(read, folder.id)) {
        return {
          status: "ok",
          event,
          receipt: { fileId: read.id, name: read.name, reused: true },
          data: { plan: read.value, projectionReceipt: { fileId: read.id, name: read.name, reused: true } }
        };
      }
    }
    const appended = await eventStore.appendEvent(identity, event);
    const plan = {
      schemaVersion: "1.2",
      userId: event.userId,
      username: event.username,
      resumeVersion: event.resumeVersion,
      localDate: event.localDate,
      planId: event.planId,
      timezone: event.timezone,
      generatedAt: event.generatedAt,
      items: event.items,
      sourceEventId: event.eventId,
      sourceEventKey: event.eventKey
    };
    const projectionReceipt = await materialize(identity, DAILY_PLANS, `${prefix}${event.planId}.json`, plan);
    return {
      status: "ok",
      event: appended.event,
      receipt: appended.receipt,
      data: { plan, projectionReceipt }
    };
  }

  // Spec sections 11 and 14: only the first valid score of a
  // `userId + localDate + questionKey` triple is persisted. A repeat on the
  // same local date is still answered in the conversation but must not create a
  // second event or snapshot.
  async function scoreAnswer(identity, event) {
    const questionBank = await latestQuestionBank(identity);
    if (!questionBank) {
      return { status: "resume_required", event, data: { reason: "question_bank_missing" } };
    }

    const verified = await eventStore.listVerifiedEvents(identity);
    // A replay of an event that is already durable is a projection retry, not a
    // new answer attempt, so it must never be blocked by the once-per-day rule.
    // Only a genuinely new event key can be a second attempt at the same day.
    const isReplay = verified.some((candidate) => candidate.eventKey === event.eventKey);
    const key = scoringKey(event);
    const alreadyScored = isReplay
      ? undefined
      : firstScorePerDay(verified).find((candidate) => scoringKey(candidate) === key);
    if (alreadyScored) {
      return {
        status: "already_scored_today",
        event: alreadyScored,
        receipt: {
          eventId: alreadyScored.eventId,
          eventKey: alreadyScored.eventKey,
          questionKey: alreadyScored.questionKey,
          localDate: alreadyScored.localDate
        },
        data: {
          questionKey: event.questionKey,
          localDate: event.localDate,
          scoredTotal: alreadyScored.total,
          scoredEventId: alreadyScored.eventId
        }
      };
    }

    let appended;
    try {
      appended = await eventStore.appendEvent(identity, event);
      if (!appended?.receipt?.fileId || appended.event?.eventKey !== event.eventKey) throw new Error("event_readback_failed");
    } catch (cause) {
      const failure = new Error("cloud_persistence_pending");
      failure.cause = cause;
      throw failure;
    }

    // The event is durable from here. A projection failure is reported as a
    // partial success so the caller can retry with the same idempotency key.
    try {
      const allVerified = await eventStore.listVerifiedEvents(identity);
      const profile = rebuildResumeKnowledgeProfile(allVerified, questionBank, { now });
      const projectionReceipt = await materializeSnapshot(identity, profile);
      return {
        status: "ok",
        event: appended.event,
        receipt: appended.receipt,
        data: { profile, projectionReceipt }
      };
    } catch (cause) {
      console.error("resume_knowledge_snapshot_failed", cause instanceof Error ? cause.message : String(cause));
      return {
        status: "profile_cache_pending",
        event: appended.event,
        receipt: appended.receipt,
        data: { profileRebuildRequired: true }
      };
    }
  }

  return { ingestResume, recordClaimDecision, saveQuestionBank, getOrCreateDailyPlan, scoreAnswer };
}
