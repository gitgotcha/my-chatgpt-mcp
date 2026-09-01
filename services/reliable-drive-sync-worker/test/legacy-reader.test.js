import assert from "node:assert/strict";
import test from "node:test";
import { createLegacyReader, LEGACY_DOMAINS } from "../src/legacy-reader.js";

const USER_ID = "00000000-0000-4000-8000-000000000001";

function fakeDrive() {
  const folders = new Map([["root", { id: "root", name: "root", parents: [], mimeType: "application/vnd.google-apps.folder" }]]);
  const files = new Map();
  let number = 0;
  const children = (parentId, name) => [...folders.values()]
    .filter((folder) => folder.parents[0] === parentId && (!name || folder.name === name));
  return {
    rootFolderId: "root",
    folders,
    files,
    async findFolder(parentId, name) { return children(parentId, name)[0] ?? null; },
    async ensureFolder(parentId, name) {
      const found = children(parentId, name)[0];
      if (found) return found;
      const folder = { id: `folder-${++number}`, name, parents: [parentId], mimeType: "application/vnd.google-apps.folder" };
      folders.set(folder.id, folder);
      return folder;
    },
    async listJson(parentId) { return [...files.values()].filter((file) => file.parents[0] === parentId); },
    async createJson(parentId, name, value) {
      const file = { id: `file-${++number}`, name, parents: [parentId], mimeType: "application/json", value: structuredClone(value) };
      files.set(file.id, file);
      return structuredClone(file);
    },
    async readJson(id) { return structuredClone(files.get(id)); }
  };
}

async function seedLegacy(drive, domain, userId) {
  const root = await drive.ensureFolder("root", domain);
  const registry = await drive.ensureFolder(root.id, "user-registry");
  const users = await drive.ensureFolder(root.id, "users");
  const user = await drive.ensureFolder(users.id, userId);
  const events = await drive.ensureFolder(user.id, "events");
  const profile = await drive.ensureFolder(user.id, "profile");
  const snapshots = await drive.ensureFolder(profile.id, "snapshots");
  const record = { schemaVersion: "1.2", eventId: "10000000-0000-4000-8000-000000000001", eventKey: "legacy-1" };
  await drive.createJson(events.id, `event-${record.eventId}.json`, record);
  return { root, registry, users, user, events, snapshots, record };
}

test("the legacy reader exposes only read capabilities", () => {
  const reader = createLegacyReader({ drive: fakeDrive() });
  const methods = Object.values(reader).filter((value) => typeof value === "function").map((fn) => fn.name);
  for (const method of methods) {
    assert.doesNotMatch(method, /create|update|delete|write|move|ensure/i, `unexpected write capability: ${method}`);
  }
  assert.equal(reader.createJson, undefined);
  assert.equal(reader.updateJson, undefined);
  assert.equal(reader.deleteJson, undefined);
});

test("the legacy reader resolves the historical events folder", async () => {
  const drive = fakeDrive();
  await seedLegacy(drive, "interview", USER_ID);
  const reader = createLegacyReader({ drive });
  const folder = await reader.path({ domain: "interview", userId: USER_ID, segments: ["events"] });
  assert.equal(folder.name, "events");
  const files = await reader.listEvents("interview", USER_ID);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "event-10000000-0000-4000-8000-000000000001.json");
});

test("the legacy reader resolves historical snapshot folders", async () => {
  const drive = fakeDrive();
  await seedLegacy(drive, "algorithm", USER_ID);
  const reader = createLegacyReader({ drive });
  const folder = await reader.path({ domain: "algorithm", userId: USER_ID, segments: ["profile", "snapshots"] });
  assert.equal(folder.name, "snapshots");
});

test("the legacy reader resolves the historical registry", async () => {
  const drive = fakeDrive();
  await seedLegacy(drive, "algorithm", USER_ID);
  const reader = createLegacyReader({ drive });
  const registry = await reader.registry("algorithm");
  assert.equal(registry.name, "user-registry");
});

test("missing legacy folders resolve to null instead of being created", async () => {
  const drive = fakeDrive();
  const reader = createLegacyReader({ drive });
  assert.equal(await reader.path({ domain: "algorithm", userId: USER_ID, segments: ["events"] }), null);
  assert.equal(drive.folders.size, 1);
});

test("any create request is refused", async () => {
  const drive = fakeDrive();
  await seedLegacy(drive, "algorithm", USER_ID);
  const reader = createLegacyReader({ drive });
  await assert.rejects(
    () => reader.path({ domain: "algorithm", userId: USER_ID, segments: ["events"], create: true }),
    /legacy_read_only/
  );
});

test("unknown domains are refused", async () => {
  const reader = createLegacyReader({ drive: fakeDrive() });
  await assert.rejects(() => reader.path({ domain: "resume-knowledge", userId: USER_ID, segments: ["events"] }), /legacy_read_only/);
  await assert.rejects(() => reader.registry("resume-knowledge"), /legacy_read_only/);
});

test("unknown legacy paths are refused", async () => {
  const drive = fakeDrive();
  await seedLegacy(drive, "interview", USER_ID);
  const reader = createLegacyReader({ drive });
  for (const segments of [["events", ".."], ["profile"], ["sources", "resume", "snapshots"], ["plans", "daily"]]) {
    await assert.rejects(() => reader.path({ domain: "interview", userId: USER_ID, segments }), /legacy_read_only/);
  }
});

test("an invalid user id is refused", async () => {
  const reader = createLegacyReader({ drive: fakeDrive() });
  await assert.rejects(() => reader.path({ domain: "interview", userId: "../escape", segments: ["events"] }), /legacy_read_only/);
});

test("only the two historical domains are readable", () => {
  assert.deepEqual(LEGACY_DOMAINS, ["algorithm", "interview"]);
});

test("the legacy reader lists historical registrations", async () => {
  const drive = fakeDrive();
  const { registry } = await seedLegacy(drive, "algorithm", USER_ID);
  await drive.createJson(registry.id, `registration-${USER_ID}.json`, {
    schemaVersion: "1.2", status: "active", userId: USER_ID, username: "旧用户", createdAt: "2026-08-01T00:00:00.000Z"
  });
  const reader = createLegacyReader({ drive });
  const records = await reader.registrations("algorithm");
  assert.equal(records.length, 1);
  assert.equal(records[0].userId, USER_ID);
  assert.equal(records[0].username, "旧用户");
});

test("a registration is ignored when its name and payload disagree", async () => {
  const drive = fakeDrive();
  const { registry } = await seedLegacy(drive, "algorithm", USER_ID);
  await drive.createJson(registry.id, `registration-${USER_ID}.json`, {
    schemaVersion: "1.2",
    userId: "99999999-9999-4999-8999-999999999999",
    username: "另一个人"
  });
  // Files that are not registrations at all are skipped too.
  await drive.createJson(registry.id, "notes.json", { userId: USER_ID });
  const reader = createLegacyReader({ drive });
  assert.deepEqual(await reader.registrations("algorithm"), []);
});

test("registrations are read-only and refuse unknown domains", async () => {
  const drive = fakeDrive();
  await seedLegacy(drive, "interview", USER_ID);
  const reader = createLegacyReader({ drive });
  assert.deepEqual(await reader.registrations("interview"), []);
  await assert.rejects(() => reader.registrations("resume-knowledge"), /legacy_read_only/);
});
