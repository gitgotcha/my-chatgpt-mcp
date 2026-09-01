import assert from "node:assert/strict";
import test from "node:test";
import { createGenericProfileStore } from "../src/generic-profile-store.js";
import { createStorageLayout } from "../src/storage-layout.js";
import { rebuildGenericProfile } from "../src/generic-profile-model.js";
import { canonicalHash } from "../src/event-store.js";

const identity = { userId: "00000000-0000-4000-8000-000000000001", username: "乔炳源" };
const DOMAIN = "english-learning";

function fakeDrive() {
  const folders = new Map([["root", { id: "root", name: "root", parents: [] }]]);
  const files = new Map();
  const createdJsonFiles = [];
  let number = 0;
  const childFolders = (parentId, name) => [...folders.values()].filter((folder) => folder.parents[0] === parentId && (!name || folder.name === name));
  return {
    rootFolderId: "root",
    folders,
    files,
    createdJsonFiles,
    async findFolder(parentId, name) { return childFolders(parentId, name)[0] ?? null; },
    async ensureFolder(parentId, name) {
      const found = childFolders(parentId, name)[0];
      if (found) return found;
      const folder = { id: `folder-${++number}`, name, parents: [parentId] };
      folders.set(folder.id, folder);
      return folder;
    },
    async listChildren(parentId, { name, foldersOnly } = {}) {
      const children = foldersOnly ? [...folders.values()] : [...folders.values(), ...files.values()];
      return children.filter((item) => item.parents[0] === parentId && (!name || item.name === name));
    },
    async listJson(parentId) {
      return [...files.values()].filter((file) => file.parents[0] === parentId).map((file) => structuredClone(file));
    },
    async createJson(parentId, name, value) {
      const file = { id: `file-${++number}`, name, parents: [parentId], mimeType: "application/json", value: structuredClone(value) };
      files.set(file.id, file);
      createdJsonFiles.push(file);
      return structuredClone(file);
    },
    async readJson(id) { return structuredClone(files.get(id)); }
  };
}

function userStoreStub() {
  return {
    verifyCalls: 0,
    async verify({ userId, displayName }) {
      this.verifyCalls += 1;
      if (userId !== identity.userId || displayName !== identity.username) throw new Error("identity_mismatch");
      return { status: "ok", identity: { userId, displayName, verified: true } };
    }
  };
}

function setup({ reduce = rebuildGenericProfile } = {}) {
  const drive = fakeDrive();
  const layout = createStorageLayout({ drive });
  const userStore = userStoreStub();
  const store = createGenericProfileStore({ userStore, layout, drive, reduce });
  return { drive, layout, userStore, store };
}

let counter = 0;

function evidenceEvent(overrides = {}) {
  counter += 1;
  return {
    schemaVersion: "1.0",
    eventId: `20000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    eventKey: `english-learning:vocabulary:word-${counter}:2026-09-01:${counter}`,
    observedAt: `2026-09-01T10:${String(counter).padStart(2, "0")}:00.000Z`,
    sourceSkill: "english-learning",
    action: "observe",
    observations: [{
      dimensionKey: "vocabulary",
      subjectKey: `word-${counter}`,
      outcome: "stuck",
      evidence: `用户无法解释 word-${counter} 的含义。`,
      confidence: "high",
      sourceRef: `conversation:2026-09-01:turn-${counter}`
    }],
    ...overrides
  };
}

function ancestryOf(drive, file) {
  const names = [file.name];
  let parentId = file.parents[0];
  while (parentId && parentId !== "root") {
    const parent = drive.folders.get(parentId) ?? drive.files.get(parentId);
    if (!parent) break;
    names.unshift(parent.name);
    parentId = parent.parents?.[0];
  }
  return names;
}

test("submit stores the bound event and snapshot under the exact generic domain", async () => {
  const { drive, store } = setup();
  const event = evidenceEvent();
  const result = await store.submitEvidence(identity, DOMAIN, event);
  assert.equal(result.status, "ok");
  assert.equal(result.event.userId, identity.userId);
  assert.equal(result.event.username, identity.username);
  assert.equal(result.event.domain, DOMAIN);
  assert.match(result.event.contentHash, /^[0-9a-f]{64}$/);

  const eventFile = drive.createdJsonFiles.find((file) => file.name === `event-${event.eventId}.json`);
  assert.ok(eventFile);
  assert.deepEqual(ancestryOf(drive, eventFile), [
    "my-chatGPT-skills", "users", identity.userId, DOMAIN, "events", `event-${event.eventId}.json`
  ]);
  assert.equal(result.receipt.fileId, eventFile.id);
  assert.equal(result.receipt.eventId, event.eventId);
  assert.equal(result.receipt.eventKey, event.eventKey);

  const snapshotFile = drive.createdJsonFiles.find((file) => file.name === `profile-${event.eventId}.json`);
  assert.ok(snapshotFile);
  assert.deepEqual(ancestryOf(drive, snapshotFile), [
    "my-chatGPT-skills", "users", identity.userId, DOMAIN, "profile", "snapshots", `profile-${event.eventId}.json`
  ]);
  assert.equal(result.data.snapshotReceipt.fileId, snapshotFile.id);
  assert.equal(result.data.snapshotReceipt.headEventId, event.eventId);
  assert.equal(result.data.profile.headEventId, event.eventId);
  assert.equal(result.data.profile.openWeaknesses.length, 1);
  assert.ok(!("contentHash" in result.data.profile));
  assert.ok(!("fileId" in result.data.profile));
});

test("identity is verified before every read and write", async () => {
  const { drive, store } = setup();
  const stranger = { userId: "22222222-2222-4222-8222-222222222222", username: "别人" };
  await assert.rejects(() => store.submitEvidence(stranger, DOMAIN, evidenceEvent()), /identity_mismatch/);
  await assert.rejects(() => store.readProfile(stranger, DOMAIN), /identity_mismatch/);
  assert.equal(drive.createdJsonFiles.length, 0);
  assert.equal(drive.folders.size, 1);
});

test("identical retries reuse the earliest verified receipt", async () => {
  const { drive, store } = setup();
  const event = evidenceEvent();
  const first = await store.submitEvidence(identity, DOMAIN, event);
  const second = await store.submitEvidence(identity, DOMAIN, structuredClone(event));
  assert.equal(second.status, "ok");
  assert.equal(second.receipt.fileId, first.receipt.fileId);
  assert.equal(drive.createdJsonFiles.filter((file) => file.name.startsWith("event-")).length, 1);
});

test("the same eventKey with different content conflicts", async () => {
  const { store } = setup();
  const event = evidenceEvent();
  await store.submitEvidence(identity, DOMAIN, event);
  const altered = evidenceEvent();
  altered.eventKey = event.eventKey;
  altered.observations = [{ ...event.observations[0], evidence: "用户部分理解了该词。" }];
  await assert.rejects(() => store.submitEvidence(identity, DOMAIN, altered), /event_key_conflict/);
});

test("the same eventId with a different eventKey conflicts", async () => {
  const { store } = setup();
  const event = evidenceEvent();
  await store.submitEvidence(identity, DOMAIN, event);
  const clash = evidenceEvent({ eventId: event.eventId });
  await assert.rejects(() => store.submitEvidence(identity, DOMAIN, clash), /event_id_conflict/);
});

test("an unknown correction target is rejected before any file is created", async () => {
  const { drive, store } = setup();
  const correction = evidenceEvent({
    action: "invalidate",
    targetEventKey: "english-learning:vocabulary:missing:2026-09-01:9",
    observations: []
  });
  await assert.rejects(() => store.submitEvidence(identity, DOMAIN, correction), /target_event_not_found/);
  assert.equal(drive.createdJsonFiles.length, 0);
});

test("a correction must be strictly later than its target", async () => {
  const { drive, store } = setup();
  const target = evidenceEvent({ observedAt: "2026-09-01T10:30:00.000Z" });
  await store.submitEvidence(identity, DOMAIN, target);
  const filesBefore = drive.createdJsonFiles.length;
  const correction = evidenceEvent({
    observedAt: "2026-09-01T10:30:00.000Z",
    action: "invalidate",
    targetEventKey: target.eventKey,
    observations: []
  });
  await assert.rejects(() => store.submitEvidence(identity, DOMAIN, correction), /invalid_profile_event/);
  assert.equal(drive.createdJsonFiles.length, filesBefore);
});

test("a second correction on the same target is rejected before any file is created", async () => {
  const { drive, store } = setup();
  const target = evidenceEvent({ observedAt: "2026-09-01T10:05:00.000Z" });
  await store.submitEvidence(identity, DOMAIN, target);
  const first = evidenceEvent({
    observedAt: "2026-09-01T10:10:00.000Z",
    action: "supersede",
    targetEventKey: target.eventKey,
    observations: [{ ...target.observations[0], outcome: "correct" }]
  });
  await store.submitEvidence(identity, DOMAIN, first);
  const filesBefore = drive.createdJsonFiles.length;
  const second = evidenceEvent({
    observedAt: "2026-09-01T10:15:00.000Z",
    action: "invalidate",
    targetEventKey: target.eventKey,
    observations: []
  });
  await assert.rejects(() => store.submitEvidence(identity, DOMAIN, second), /target_event_inactive/);
  assert.equal(drive.createdJsonFiles.length, filesBefore);
});

test("tampered, foreign and malformed records are never trusted", async () => {
  const { drive, store } = setup();
  const event = evidenceEvent();
  await store.submitEvidence(identity, DOMAIN, event);

  const eventsFolder = drive.createdJsonFiles.find((file) => file.name === `event-${event.eventId}.json`).parents[0];

  // Wrong identity inside the record.
  const foreign = structuredClone(event);
  foreign.username = "别人";
  await drive.createJson(eventsFolder, `event-30000000-0000-4000-8000-000000000001.json`, foreign);

  // Tampered content hash.
  const tampered = structuredClone(event);
  tampered.eventId = "30000000-0000-4000-8000-000000000002";
  tampered.eventKey = "english-learning:vocabulary:word-99:2026-09-01:99";
  tampered.contentHash = "deadbeef";
  await drive.createJson(eventsFolder, `event-${tampered.eventId}.json`, tampered);

  // Malformed filename.
  await drive.createJson(eventsFolder, "notes.json", structuredClone(event));

  // Foreign parent: file listed under the folder but parented elsewhere.
  const adopted = structuredClone(event);
  adopted.eventId = "30000000-0000-4000-8000-000000000003";
  adopted.eventKey = "english-learning:vocabulary:word-98:2026-09-01:98";
  adopted.contentHash = await canonicalHash({ ...adopted, domain: DOMAIN, userId: identity.userId, username: identity.username });
  const planted = await drive.createJson(eventsFolder, `event-${adopted.eventId}.json`, adopted);
  drive.files.get(planted.id).parents = ["root"];

  const read = await store.readProfile(identity, DOMAIN);
  assert.deepEqual(read.data.profile.sourceEventKeys, [event.eventKey]);
});

test("a snapshot projection failure keeps the durable event receipt", async () => {
  const { drive, store } = setup({ reduce: () => { throw new Error("projection_boom"); } });
  const event = evidenceEvent();
  const result = await store.submitEvidence(identity, DOMAIN, event);
  assert.equal(result.status, "profile_cache_pending");
  assert.equal(result.receipt.eventId, event.eventId);
  assert.equal(result.receipt.fileId, drive.createdJsonFiles.find((file) => file.name === `event-${event.eventId}.json`).id);
  assert.deepEqual(result.data, { profileRebuildRequired: true });
  assert.equal(drive.createdJsonFiles.filter((file) => file.name.startsWith("profile-")).length, 0);
});

test("read chooses the snapshot whose source keys exactly cover the event set", async () => {
  const { drive, store } = setup();
  const first = evidenceEvent();
  await store.submitEvidence(identity, DOMAIN, first);
  const second = evidenceEvent();
  await store.submitEvidence(identity, DOMAIN, second);

  const read = await store.readProfile(identity, DOMAIN);
  assert.equal(read.status, "ok");
  assert.equal(read.data.domain, DOMAIN);
  assert.equal(read.data.projectionState, "snapshot");
  assert.equal(read.data.profile.headEventId, second.eventId);
  assert.deepEqual(read.data.profile.sourceEventKeys, [first.eventKey, second.eventKey].sort());

  // Remove the newest snapshot; the older one no longer covers the event set.
  const newest = drive.createdJsonFiles.find((file) => file.name === `profile-${second.eventId}.json`);
  drive.files.delete(newest.id);
  const filesBefore = drive.files.size;
  const rebuilt = await store.readProfile(identity, DOMAIN);
  assert.equal(rebuilt.data.projectionState, "rebuilt_in_memory");
  assert.equal(rebuilt.data.profile.headEventId, second.eventId);
  assert.equal(drive.files.size, filesBefore);
});

test("a fresher snapshot with stale coverage is never trusted", async () => {
  const { drive, store } = setup();
  const first = evidenceEvent();
  await store.submitEvidence(identity, DOMAIN, first);
  const second = evidenceEvent();
  await store.submitEvidence(identity, DOMAIN, second);

  // Delete the covering snapshot and plant a valid-looking one that only
  // covers the older event set but carries a newer generatedAt/headEventId.
  drive.files.delete(drive.createdJsonFiles.find((file) => file.name === `profile-${second.eventId}.json`).id);
  const snapshotsFolder = drive.createdJsonFiles.find((file) => file.name === `profile-${first.eventId}.json`).parents[0];
  const stale = structuredClone(drive.createdJsonFiles.find((file) => file.name === `profile-${first.eventId}.json`).value);
  stale.headEventId = "40000000-0000-4000-8000-000000000001";
  stale.generatedAt = "2026-12-31T23:59:59.999Z";
  const { contentHash, ...withoutHash } = stale;
  stale.contentHash = await canonicalHash(withoutHash);
  await drive.createJson(snapshotsFolder, `profile-${stale.headEventId}.json`, stale);

  const read = await store.readProfile(identity, DOMAIN);
  assert.equal(read.data.projectionState, "rebuilt_in_memory");
  assert.deepEqual(read.data.profile.sourceEventKeys, [first.eventKey, second.eventKey].sort());
});

test("reading without any events returns the empty in-memory profile", async () => {
  const { drive, store } = setup();
  const read = await store.readProfile(identity, DOMAIN);
  assert.equal(read.status, "ok");
  assert.equal(read.data.domain, DOMAIN);
  assert.equal(read.data.projectionState, "rebuilt_in_memory");
  assert.equal(read.data.profile.headEventId, null);
  assert.equal(read.data.profile.generatedAt, null);
  assert.deepEqual(read.data.profile.openWeaknesses, []);
  assert.equal(drive.createdJsonFiles.length, 0);
  assert.equal(drive.folders.size, 1);
});

test("caller events cannot claim another identity or domain", async () => {
  const { drive, store } = setup();
  const foreignIdentity = evidenceEvent({
    userId: "22222222-2222-4222-8222-222222222222",
    username: "别人",
    domain: DOMAIN
  });
  await assert.rejects(() => store.submitEvidence(identity, DOMAIN, foreignIdentity), /identity_mismatch/);
  const foreignDomain = evidenceEvent({ domain: "algorithm" });
  await assert.rejects(() => store.submitEvidence(identity, DOMAIN, foreignDomain), /invalid_profile_event/);
  assert.equal(drive.createdJsonFiles.length, 0);
});

test("an invalid domain is rejected", async () => {
  const { store } = setup();
  await assert.rejects(() => store.submitEvidence(identity, "algorithm", evidenceEvent()), /invalid_domain/);
  await assert.rejects(() => store.readProfile(identity, "algorithm"), /invalid_domain/);
});

test("specialized domain paths and legacy readers are never invoked", async () => {
  const drive = fakeDrive();
  const base = createStorageLayout({ drive });
  const layout = {
    ...base,
    ensureDomainPath() { throw new Error("specialized_path_invoked"); },
    findDomainPath() { throw new Error("specialized_path_invoked"); }
  };
  const store = createGenericProfileStore({ userStore: userStoreStub(), layout, drive });
  const event = evidenceEvent();
  const result = await store.submitEvidence(identity, DOMAIN, event);
  assert.equal(result.status, "ok");
  const read = await store.readProfile(identity, DOMAIN);
  assert.equal(read.data.projectionState, "snapshot");
});

test("a pre-bound event from dispatch is accepted and rebound", async () => {
  const { store } = setup();
  const event = evidenceEvent({
    userId: identity.userId,
    username: identity.username,
    domain: DOMAIN
  });
  const result = await store.submitEvidence(identity, DOMAIN, event);
  assert.equal(result.status, "ok");
  assert.equal(result.event.userId, identity.userId);
  assert.equal(result.event.domain, DOMAIN);
});
