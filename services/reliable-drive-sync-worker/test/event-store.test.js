import assert from "node:assert/strict";
import test from "node:test";
import { canonicalHash, createEventStore } from "../src/event-store.js";
import { createStorageLayout } from "../src/storage-layout.js";
import { createLegacyReader } from "../src/legacy-reader.js";

const identity = { userId: "00000000-0000-4000-8000-000000000001", username: "Ada" };
const event = {
  schemaVersion: "1.2",
  eventId: "10000000-0000-4000-8000-000000000001",
  eventKey: "session-MOCK-1-completed",
  eventType: "interview.session.completed",
  userId: identity.userId,
  username: identity.username,
  sessionId: "MOCK-1",
  interviewType: "mock",
  domain: "algorithms",
  completedAt: "2026-08-14T10:00:00.000Z"
};

function fakeDrive() {
  const folders = new Map([["root", { id: "root", name: "root", parents: [] }]]);
  const files = new Map();
  const createdJsonFiles = [];
  let listings = [];
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
    setJsonListings(value) { listings = value; },
    async listJson(parentId) {
      const listing = listings.shift();
      return listing ? listing.map((id) => structuredClone(files.get(id))) : [...files.values()].filter((file) => file.parents[0] === parentId);
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
    async verify({ userId, displayName }) {
      if (userId !== identity.userId || displayName !== identity.username) throw new Error("identity_mismatch");
      return { status: "ok", identity: { userId, displayName, nameKey: displayName, verified: true } };
    }
  };
}

function setup({ domain = "interview", legacy = true } = {}) {
  const drive = fakeDrive();
  const layout = createStorageLayout({ drive });
  const legacyReader = legacy ? createLegacyReader({ drive }) : undefined;
  return {
    drive,
    layout,
    legacyReader,
    store: createEventStore({ domain, userStore: userStoreStub(), layout, drive, legacyReader })
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

async function seedLegacy(drive, domain, userId, record) {
  const root = await drive.ensureFolder("root", domain);
  const users = await drive.ensureFolder(root.id, "users");
  const user = await drive.ensureFolder(users.id, userId);
  const events = await drive.ensureFolder(user.id, "events");
  await drive.createJson(events.id, `event-${record.eventId}.json`, record);
  return events;
}

test("same event key and content reuses the earliest verified event", async () => {
  const { drive, store } = setup();
  const first = await store.appendEvent(identity, event);
  const second = await store.appendEvent(identity, structuredClone(event));
  assert.equal(second.receipt.fileId, first.receipt.fileId);
  assert.equal(drive.createdJsonFiles.length, 1);
});

test("same event key with different content is rejected", async () => {
  const { store } = setup();
  await store.appendEvent(identity, event);
  await assert.rejects(() => store.appendEvent(identity, { ...event, domain: "distributed-systems" }), /event_key_conflict/);
});

test("append stores a verified hash under an event-id filename", async () => {
  const { drive, store } = setup();
  const result = await store.appendEvent(identity, event);
  assert.equal(drive.createdJsonFiles[0].name, `event-${event.eventId}.json`);
  assert.match(result.event.contentHash, /^[0-9a-f]{64}$/);
});

test("canonical hash treats event fields named like Drive metadata as content", async () => {
  assert.notEqual(await canonicalHash(event), await canonicalHash({ ...event, name: "user-supplied-name" }));
});

test("duplicate retry returns the previously verified file instead of another same-name file", async () => {
  const { drive, store } = setup();
  const first = await store.appendEvent(identity, event);
  const duplicate = await drive.createJson(drive.createdJsonFiles[0].parents[0], `event-${event.eventId}.json`, first.event);
  drive.setJsonListings([[first.receipt.fileId, duplicate.id], [duplicate.id, first.receipt.fileId]]);
  const retried = await store.appendEvent(identity, structuredClone(event));
  assert.equal(retried.receipt.fileId, first.receipt.fileId);
});

test("events are stored below the canonical plugin root", async () => {
  const { drive, store } = setup();
  await store.appendEvent(identity, event);
  const file = drive.createdJsonFiles[0];
  assert.deepEqual(ancestryOf(drive, file), [
    "my-chatGPT-skills", "users", identity.userId, "interview", "events", `event-${event.eventId}.json`
  ]);
});

test("algorithm events use the canonical algorithm events folder", async () => {
  const { drive, store } = setup({ domain: "algorithm" });
  await store.appendEvent(identity, event);
  assert.deepEqual(ancestryOf(drive, drive.createdJsonFiles[0]), [
    "my-chatGPT-skills", "users", identity.userId, "algorithm", "events", `event-${event.eventId}.json`
  ]);
});

test("canonical writes never create legacy namespace folders or files", async () => {
  const drive = fakeDrive();
  const folderCalls = [];
  const createCalls = [];
  const ensureFolder = drive.ensureFolder.bind(drive);
  const createJson = drive.createJson.bind(drive);
  drive.ensureFolder = (parentId, name) => {
    folderCalls.push([parentId, name]);
    return ensureFolder(parentId, name);
  };
  drive.createJson = (parentId, name, value) => {
    createCalls.push([parentId, name]);
    return createJson(parentId, name, value);
  };
  const store = createEventStore({
    domain: "interview",
    userStore: userStoreStub(),
    layout: createStorageLayout({ drive }),
    drive,
    legacyReader: createLegacyReader({ drive })
  });
  await store.appendEvent(identity, event);
  const legacyRoots = ["algorithm", "interview"];
  assert.deepEqual(folderCalls.filter(([parentId, name]) => parentId === "root" && legacyRoots.includes(name)), []);
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0][1], `event-${event.eventId}.json`);
});

test("listVerifiedEvents falls back to the legacy namespace events folder", async () => {
  const { drive, store } = setup();
  const legacy = structuredClone(event);
  legacy.eventId = "10000000-0000-4000-8000-00000000000f";
  legacy.eventKey = "legacy-session-MOCK-1";
  legacy.contentHash = await canonicalHash(legacy);
  await seedLegacy(drive, "interview", identity.userId, legacy);

  const events = await store.listVerifiedEvents(identity);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventId, legacy.eventId);
});

test("canonical events take precedence over the legacy folder", async () => {
  const { drive, store } = setup();
  const legacy = structuredClone(event);
  legacy.eventId = "10000000-0000-4000-8000-00000000000f";
  legacy.eventKey = "legacy-session-MOCK-1";
  legacy.contentHash = await canonicalHash(legacy);
  await seedLegacy(drive, "interview", identity.userId, legacy);

  await store.appendEvent(identity, event);

  const events = await store.listVerifiedEvents(identity);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventId, event.eventId);
});

test("legacy events are ignored when no legacy reader is supplied", async () => {
  const { drive, store } = setup({ legacy: false });
  const legacy = structuredClone(event);
  legacy.eventId = "10000000-0000-4000-8000-00000000000f";
  legacy.eventKey = "legacy-session-MOCK-1";
  legacy.contentHash = await canonicalHash(legacy);
  await seedLegacy(drive, "interview", identity.userId, legacy);

  assert.deepEqual(await store.listVerifiedEvents(identity), []);
});

test("an unknown domain is rejected", () => {
  const drive = fakeDrive();
  assert.throws(() => createEventStore({
    domain: "unknown",
    userStore: userStoreStub(),
    layout: createStorageLayout({ drive }),
    drive
  }), /invalid_domain/);
});
