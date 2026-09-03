import { canonicalHash } from "./event-store.js";
import { rebuildGenericProfile } from "./generic-profile-model.js";
import { validateGenericProfileDomain, validateGenericProfileEvent } from "./generic-profile-contract.js";

const hasOnlyParent = (file, parentId) => Array.isArray(file?.parents) && file.parents.length === 1 && file.parents[0] === parentId;
const EVENT_NAME = /^event-[0-9a-f-]+\.json$/i;
const SNAPSHOT_NAME = /^profile-[0-9a-f-]+\.json$/i;

function stripHash(record) {
  const { contentHash, ...event } = record ?? {};
  return event;
}

function compareStable(a, b) {
  const time = Date.parse(a.observedAt) - Date.parse(b.observedAt);
  if (time !== 0) return time;
  if (a.eventKey < b.eventKey) return -1;
  if (a.eventKey > b.eventKey) return 1;
  return 0;
}

// Admission control for corrections: replay the persisted history to find
// which targets an earlier correction already deactivated.
function deactivatedKeys(records) {
  const events = records.map(({ event }) => event).sort(compareStable);
  const seen = new Set();
  const deactivated = new Set();
  for (const event of events) {
    if (event.action !== "observe") {
      if (seen.has(event.targetEventKey) && !deactivated.has(event.targetEventKey)) {
        deactivated.add(event.targetEventKey);
      }
    }
    seen.add(event.eventKey);
  }
  return deactivated;
}

export function createGenericProfileStore({
  userStore,
  layout,
  drive,
  reduce = rebuildGenericProfile,
  hash = canonicalHash
} = {}) {
  if (!userStore?.verify) throw new Error("invalid_generic_profile_store");
  if (!layout?.ensureGenericProfilePath || !layout?.findGenericProfilePath) throw new Error("invalid_generic_profile_store");
  if (!drive?.rootFolderId) throw new Error("invalid_generic_profile_store");

  async function verify(identity) {
    if (!identity?.userId || typeof identity.username !== "string" || !identity.username) {
      throw new Error("identity_mismatch");
    }
    const result = await userStore.verify({ userId: identity.userId, displayName: identity.username });
    if (result?.status !== "ok" || result.identity?.userId !== identity.userId
      || result.identity?.displayName !== identity.username) {
      throw new Error("identity_mismatch");
    }
    return { userId: result.identity.userId, username: result.identity.displayName };
  }

  async function validEventFile(file, folderId, identity, domain) {
    if (!file || !hasOnlyParent(file, folderId) || !EVENT_NAME.test(file.name)) return null;
    const read = await drive.readJson(file.id);
    const record = read?.value;
    if (!read || !hasOnlyParent(read, folderId) || read.name !== file.name || !record) return null;
    const { contentHash, ...event } = record;
    try {
      validateGenericProfileEvent(event, { boundIdentity: identity, domain });
    } catch {
      return null;
    }
    if (read.name !== `event-${event.eventId}.json`) return null;
    if (typeof contentHash !== "string" || contentHash !== await hash(record)) return null;
    return { event: structuredClone(record), file: read };
  }

  async function verifiedEventRecords(identity, domain) {
    const verifiedIdentity = await verify(identity);
    const folder = await layout.findGenericProfilePath(verifiedIdentity.userId, domain, ["events"]);
    if (!folder) return [];
    const files = await drive.listJson(folder.id);
    const records = await Promise.all(files.map((file) => validEventFile(file, folder.id, verifiedIdentity, domain)));
    return records.filter(Boolean);
  }

  function bindAndValidate(event, verifiedIdentity, domain) {
    if (event.userId !== undefined && event.userId !== verifiedIdentity.userId) throw new Error("identity_mismatch");
    if (event.username !== undefined && event.username !== verifiedIdentity.username) throw new Error("identity_mismatch");
    if (event.domain !== undefined && event.domain !== domain) throw new Error("invalid_profile_event");
    const callerEvent = structuredClone(event);
    delete callerEvent.userId;
    delete callerEvent.username;
    delete callerEvent.domain;
    delete callerEvent.contentHash;
    validateGenericProfileEvent(callerEvent);
    const storedEvent = {
      ...callerEvent,
      userId: verifiedIdentity.userId,
      username: verifiedIdentity.username,
      domain
    };
    validateGenericProfileEvent(storedEvent, { boundIdentity: verifiedIdentity, domain });
    return storedEvent;
  }

  function validateCorrection(existingRecords, storedEvent) {
    if (storedEvent.action === "observe") return;
    if (storedEvent.targetEventKey === storedEvent.eventKey) throw new Error("invalid_profile_event");
    const target = existingRecords.find(({ event }) => event.eventKey === storedEvent.targetEventKey);
    if (!target) throw new Error("target_event_not_found");
    if (!(Date.parse(storedEvent.observedAt) > Date.parse(target.event.observedAt))) {
      throw new Error("invalid_profile_event");
    }
    if (target.event.action === "invalidate") throw new Error("target_event_inactive");
    if (deactivatedKeys(existingRecords).has(storedEvent.targetEventKey)) {
      throw new Error("target_event_inactive");
    }
  }

  async function saveSnapshot(verifiedIdentity, domain, profile) {
    if (!profile.headEventId) return null;
    const folder = await layout.ensureGenericProfilePath(verifiedIdentity.userId, domain, ["profile", "snapshots"]);
    const name = `profile-${profile.headEventId}.json`;
    const record = { ...structuredClone(profile), contentHash: await hash(profile) };
    const created = await drive.createJson(folder.id, name, record);
    const read = await drive.readJson(created.id);
    if (!read || read.id !== created.id || read.name !== name || !hasOnlyParent(read, folder.id)
      || JSON.stringify(read.value) !== JSON.stringify(record)) {
      throw new Error("snapshot_readback_failed");
    }
    return { fileId: read.id, headEventId: profile.headEventId };
  }

  async function submitEvidence(identity, domain, event) {
    const safeDomain = validateGenericProfileDomain(domain);
    const verifiedIdentity = await verify(identity);
    const storedEvent = bindAndValidate(event, verifiedIdentity, safeDomain);
    storedEvent.contentHash = await hash(storedEvent);

    const existing = await verifiedEventRecords(verifiedIdentity, safeDomain);
    const duplicate = existing.find(({ event: candidate }) => candidate.eventKey === storedEvent.eventKey);
    if (duplicate) {
      if (duplicate.event.contentHash !== storedEvent.contentHash) throw new Error("event_key_conflict");
    } else {
      validateCorrection(existing, storedEvent);
    }

    let receipt;
    let allEvents;
    let resultEvent;
    if (duplicate) {
      receipt = { fileId: duplicate.file.id, eventId: duplicate.event.eventId, eventKey: duplicate.event.eventKey };
      resultEvent = duplicate.event;
      allEvents = existing.map(({ event }) => stripHash(event));
    } else {
      const folder = await layout.ensureGenericProfilePath(verifiedIdentity.userId, safeDomain, ["events"]);
      if ((await drive.listJson(folder.id)).some((file) => file.name === `event-${storedEvent.eventId}.json`)) {
        throw new Error("event_id_conflict");
      }
      const created = await drive.createJson(folder.id, `event-${storedEvent.eventId}.json`, storedEvent);
      const checked = await validEventFile(created, folder.id, verifiedIdentity, safeDomain);
      if (!checked || checked.event.eventId !== storedEvent.eventId
        || checked.event.eventKey !== storedEvent.eventKey
        || checked.event.contentHash !== storedEvent.contentHash) {
        throw new Error("event_readback_failed");
      }
      receipt = { fileId: checked.file.id, eventId: storedEvent.eventId, eventKey: storedEvent.eventKey };
      resultEvent = checked.event;
      allEvents = [...existing.map(({ event }) => stripHash(event)), stripHash(storedEvent)];
    }

    try {
      const profile = reduce(allEvents, { identity: verifiedIdentity, domain: safeDomain });
      const snapshotReceipt = await saveSnapshot(verifiedIdentity, safeDomain, profile);
      return {
        status: "ok",
        event: resultEvent,
        receipt,
        data: { profile, snapshotReceipt }
      };
    } catch (cause) {
      console.error("generic_profile_snapshot_failed", cause instanceof Error ? cause.message : String(cause));
      return {
        status: "profile_cache_pending",
        event: resultEvent,
        receipt,
        data: { profileRebuildRequired: true }
      };
    }
  }

  async function validSnapshotFile(file, folderId, identity, domain) {
    if (!file || !hasOnlyParent(file, folderId) || !SNAPSHOT_NAME.test(file.name)) return null;
    const read = await drive.readJson(file.id);
    const record = read?.value;
    if (!read || !hasOnlyParent(read, folderId) || read.name !== file.name || !record) return null;
    if (record.schemaVersion !== "1.0" || record.userId !== identity.userId
      || record.username !== identity.username || record.domain !== domain
      || !Array.isArray(record.sourceEventKeys) || typeof record.headEventId !== "string") return null;
    if (read.name !== `profile-${record.headEventId}.json`) return null;
    const { contentHash } = record;
    if (typeof contentHash !== "string" || contentHash !== await hash(record)) return null;
    return { record: structuredClone(record), file: read };
  }

  async function readProfile(identity, domain) {
    const safeDomain = validateGenericProfileDomain(domain);
    const verifiedIdentity = await verify(identity);
    const existing = await verifiedEventRecords(verifiedIdentity, safeDomain);
    const stripped = existing.map(({ event }) => stripHash(event));

    const folder = await layout.findGenericProfilePath(verifiedIdentity.userId, safeDomain, ["profile", "snapshots"]);
    if (folder) {
      const files = await drive.listJson(folder.id);
      const candidates = [];
      for (const file of files) {
        const validated = await validSnapshotFile(file, folder.id, verifiedIdentity, safeDomain);
        if (validated) candidates.push(validated);
      }
      const eventKeys = stripped.map((event) => event.eventKey).sort();
      const matching = candidates.filter(({ record }) =>
        Array.isArray(record.sourceEventKeys)
        && record.sourceEventKeys.length === eventKeys.length
        && [...record.sourceEventKeys].sort().every((key, index) => key === eventKeys[index]));
      if (matching.length > 0) {
        // Complete source coverage first, then generatedAt, then filename;
        // a fresh filename alone is never trusted.
        matching.sort((a, b) => {
          if (a.record.generatedAt !== b.record.generatedAt) {
            return a.record.generatedAt < b.record.generatedAt ? 1 : -1;
          }
          return a.file.name < b.file.name ? 1 : -1;
        });
        const chosen = matching[0];
        const profile = stripHash(chosen.record);
        return { status: "ok", data: { domain: safeDomain, profile, projectionState: "snapshot" } };
      }
    }

    const profile = reduce(stripped, { identity: verifiedIdentity, domain: safeDomain });
    return { status: "ok", data: { domain: safeDomain, profile, projectionState: "rebuilt_in_memory" } };
  }

  return { submitEvidence, readProfile };
}
