const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

const DOMAINS = new Set(["algorithm", "interview", "resume-knowledge"]);

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function contentForHash(event) {
  const clone = structuredClone(event);
  delete clone.contentHash;
  return clone;
}

export async function canonicalHash(event) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(canonicalJson(contentForHash(event))));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const hasOnlyParent = (file, parentId) => Array.isArray(file?.parents) && file.parents.length === 1 && file.parents[0] === parentId;
const validId = (value) => typeof value === "string" && UUID.test(value);

export function createEventStore({ domain = "interview", userStore, layout, drive, legacyReader, canonicalHash: hash = canonicalHash }) {
  if (!userStore?.verify) throw new Error("invalid_event_store");
  if (!layout?.ensureDomainPath || !layout?.findDomainPath) throw new Error("invalid_event_store");
  if (!drive?.rootFolderId) throw new Error("invalid_event_store");
  if (!DOMAINS.has(domain)) throw new Error("invalid_domain");

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

  const ensureEventsFolder = (userId) => layout.ensureDomainPath(userId, domain, ["events"]);
  const findEventsFolder = (userId) => layout.findDomainPath(userId, domain, ["events"]);

  async function validEvent(file, parentId, identity) {
    if (!file || !hasOnlyParent(file, parentId) || !/^event-[0-9a-f-]+\.json$/i.test(file.name)) return null;
    const read = await drive.readJson(file.id);
    const event = read?.value;
    if (!hasOnlyParent(read, parentId) || read.name !== file.name || !event || event.schemaVersion !== "1.2"
      || !validId(event.eventId) || read.name !== `event-${event.eventId}.json` || typeof event.eventKey !== "string" || !event.eventKey
      || typeof event.eventType !== "string" || !event.eventType || event.userId !== identity.userId || event.username !== identity.username
      || typeof event.contentHash !== "string" || event.contentHash !== await hash(event)) return null;
    return { event: structuredClone(event), file: read };
  }

  async function recordsIn(identity, folderId) {
    const files = await drive.listJson(folderId);
    const records = await Promise.all(files.map((file) => validEvent(file, folderId, identity)));
    return records.filter(Boolean);
  }

  // Canonical path wins. The legacy namespace directories are consulted only
  // when the canonical events folder does not exist yet.
  async function verifiedEventRecords(identity) {
    const verifiedIdentity = await verify(identity);
    const folder = await findEventsFolder(verifiedIdentity.userId);
    if (folder) return recordsIn(verifiedIdentity, folder.id);
    if (!legacyReader) return [];
    // Only the pre-normalization namespaces have a legacy directory to fall
    // back to. A domain added after the migration has no history to read, so
    // asking the legacy adapter about it would only raise a false conflict.
    if (Array.isArray(legacyReader.domains) && !legacyReader.domains.includes(domain)) return [];
    const legacyFolder = await legacyReader.path({ domain, userId: verifiedIdentity.userId, segments: ["events"] });
    return legacyFolder ? recordsIn(verifiedIdentity, legacyFolder.id) : [];
  }

  async function listVerifiedEvents(identity) {
    return (await verifiedEventRecords(identity)).map(({ event }) => event);
  }

  function validateInput(identity, event) {
    if (!event || event.schemaVersion !== "1.2" || !validId(event.eventId) || typeof event.eventKey !== "string" || !event.eventKey
      || typeof event.eventType !== "string" || !event.eventType || event.userId !== identity.userId || event.username !== identity.username) throw new Error("invalid_event");
  }

  async function appendEvent(identity, input) {
    const verifiedIdentity = await verify(identity);
    validateInput(verifiedIdentity, input);
    const event = structuredClone(input);
    event.contentHash = await hash(event);
    const existing = await verifiedEventRecords(verifiedIdentity);
    const duplicate = existing.find(({ event: candidate }) => candidate.eventKey === event.eventKey);
    if (duplicate) {
      if (duplicate.event.contentHash !== event.contentHash) throw new Error("event_key_conflict");
      return { event: duplicate.event, receipt: { fileId: duplicate.file.id, eventId: duplicate.event.eventId, eventKey: duplicate.event.eventKey } };
    }
    const folder = await ensureEventsFolder(verifiedIdentity.userId);
    if ((await drive.listJson(folder.id)).some((file) => file.name === `event-${event.eventId}.json`)) throw new Error("event_id_conflict");
    const created = await drive.createJson(folder.id, `event-${event.eventId}.json`, event);
    const checked = await validEvent(created, folder.id, verifiedIdentity);
    if (!checked || checked.event.eventId !== event.eventId || checked.event.eventKey !== event.eventKey || checked.event.contentHash !== event.contentHash) throw new Error("event_readback_failed");
    return { event: checked.event, receipt: { fileId: checked.file.id, eventId: event.eventId, eventKey: event.eventKey } };
  }

  return { appendEvent, listVerifiedEvents };
}
