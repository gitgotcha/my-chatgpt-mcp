import assert from "node:assert/strict";
import test from "node:test";
import { createStorageLayout } from "../src/storage-layout.js";
import { createUserStore, normalizeDisplayName } from "../src/user-store.js";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ID = "00000000-0000-4000-8000-000000000002";
const THIRD_ID = "00000000-0000-4000-8000-000000000003";
const CREATED_AT = "2026-08-29T00:00:00.000Z";

function fakeDrive() {
  const items = new Map([
    ["root", { id: "root", name: "root", parents: [], mimeType: "application/vnd.google-apps.folder" }]
  ]);
  let sequence = 0;
  let listings = [];
  const childItems = (parentId, name) => [...items.values()]
    .filter((item) => item.parents.length === 1 && item.parents[0] === parentId && (!name || item.name === name));
  const drive = {
    rootFolderId: "root",
    createdJsonFiles: [],
    async findFolder(parentId, name) {
      if (!name) throw new Error("folder name is required");
      return childItems(parentId, name).find((item) => item.mimeType === "application/vnd.google-apps.folder") ?? null;
    },
    async ensureFolder(parentId, name) {
      if (!parentId || !name || name.includes("/") || name.includes("\\")) throw new Error("invalid folder input");
      const existing = childItems(parentId, name).find((item) => item.mimeType === "application/vnd.google-apps.folder");
      if (existing) return existing;
      const folder = { id: `folder-${++sequence}`, name, parents: [parentId], mimeType: "application/vnd.google-apps.folder" };
      items.set(folder.id, folder);
      return folder;
    },
    async listChildren(parentId, { name, foldersOnly } = {}) {
      return childItems(parentId, name).filter((item) => !foldersOnly || item.mimeType === "application/vnd.google-apps.folder");
    },
    setJsonListings(value) { listings = value; },
    async listJson(parentId) {
      const listing = listings.shift();
      return listing ? listing.map((item) => structuredClone(item))
        : childItems(parentId).filter((item) => item.mimeType === "application/json");
    },
    async createJson(parentId, name, value) {
      const file = { id: `file-${++sequence}`, name, parents: [parentId], mimeType: "application/json", value: structuredClone(value) };
      items.set(file.id, file);
      drive.createdJsonFiles.push(file);
      return structuredClone(file);
    },
    async readJson(id) {
      const item = items.get(id);
      return item ? structuredClone(item) : null;
    },
    filesByPrefix(prefix) {
      return [...items.values()].filter((item) => item.mimeType === "application/json" && item.name.startsWith(prefix));
    },
    ancestry(id) {
      const chain = [];
      let current = items.get(id);
      while (current) {
        chain.unshift(current.name);
        current = current.parents.length ? items.get(current.parents[0]) : undefined;
      }
      return chain;
    },
    path(id) { return drive.ancestry(id).join("/"); }
  };
  return drive;
}

const idSequence = () => {
  const ids = [USER_ID, OTHER_ID, THIRD_ID];
  let index = 0;
  return () => ids[index++] ?? `00000000-0000-4000-8000-00000000000${index}`;
};

function setup({ uuid } = {}) {
  const drive = fakeDrive();
  const layout = createStorageLayout({ drive });
  const store = createUserStore({
    layout,
    drive,
    now: () => CREATED_AT,
    uuid: uuid ?? (() => USER_ID)
  });
  return { drive, layout, store };
}

const registrationRecord = (userId, displayName, createdAt = CREATED_AT) => ({
  schemaVersion: "1.2", userId, displayName, nameKey: displayName, status: "active", createdAt
});

test("normalizeDisplayName applies NFKC and trims outer whitespace", () => {
  assert.equal(normalizeDisplayName("  Ａda  "), "Ada");
  assert.equal(normalizeDisplayName("乔炳源"), "乔炳源");
  assert.equal(normalizeDisplayName("  乔炳源 "), "乔炳源");
  assert.equal(normalizeDisplayName("ＡＢＣ"), "ABC");
  assert.equal(normalizeDisplayName(""), "");
  assert.equal(normalizeDisplayName("   "), "");
  assert.equal(normalizeDisplayName(undefined), "");
  assert.equal(normalizeDisplayName(42), "");
});

test("the same display name resolves to one stable user id", async () => {
  const { store } = setup();
  const first = await store.resolveOrCreate({ displayName: "乔炳源" });
  const second = await store.resolveOrCreate({ displayName: " 乔炳源 " });
  assert.equal(first.userId, USER_ID);
  assert.equal(second.userId, first.userId);
});

test("different display names get isolated user ids", async () => {
  const { store } = setup({ uuid: idSequence() });
  const first = await store.resolveOrCreate({ displayName: "乔炳源" });
  const second = await store.resolveOrCreate({ displayName: "李四" });
  assert.equal(first.userId, USER_ID);
  assert.equal(second.userId, OTHER_ID);
  assert.notEqual(first.userId, second.userId);
});

test("a missing user is registered with identity and registration files", async () => {
  const { drive, store } = setup();
  const result = await store.resolveOrCreate({ displayName: "乔炳源" });
  assert.equal(result.status, "ok");
  assert.equal(result.displayName, "乔炳源");

  const identities = drive.filesByPrefix("identity.json");
  const registrations = drive.filesByPrefix("registration-");
  assert.equal(identities.length, 1);
  assert.equal(registrations.length, 1);
  assert.equal(drive.path(identities[0].id), `root/my-chatGPT-skills/users/${USER_ID}/identity.json`);
  assert.equal(drive.path(registrations[0].id), `root/my-chatGPT-skills/user-registry/registration-${USER_ID}.json`);
  assert.equal(identities[0].value.displayName, "乔炳源");
  assert.equal(registrations[0].value.displayName, "乔炳源");
});

test("repeated registration does not duplicate registry files", async () => {
  const { drive, store } = setup();
  await store.resolveOrCreate({ displayName: "乔炳源" });
  await store.resolveOrCreate({ displayName: "乔炳源" });
  assert.equal(drive.filesByPrefix("registration-").length, 1);
  assert.equal(drive.filesByPrefix("identity.json").length, 1);
});

test("listRegistrations returns every active registration", async () => {
  const { store } = setup({ uuid: idSequence() });
  await store.resolveOrCreate({ displayName: "乔炳源" });
  await store.resolveOrCreate({ displayName: "李四" });
  const registrations = await store.listRegistrations();
  assert.deepEqual(registrations.map((record) => record.displayName), ["乔炳源", "李四"]);
});

test("a blank display name is rejected", async () => {
  const { store } = setup();
  await assert.rejects(() => store.resolveOrCreate({ displayName: "" }), /invalid_display_name/);
  await assert.rejects(() => store.resolveOrCreate({ displayName: "   " }), /invalid_display_name/);
  await assert.rejects(() => store.resolveOrCreate({}), /invalid_display_name/);
});

test("duplicate registration files for one display name stop resolution", async () => {
  const { drive, layout, store } = setup({ uuid: idSequence() });
  const registry = await layout.ensureRegistry();
  await drive.createJson(registry.id, `registration-${USER_ID}.json`, registrationRecord(USER_ID, "乔炳源", "2026-08-29T00:00:00.000Z"));
  await drive.createJson(registry.id, `registration-${OTHER_ID}.json`, registrationRecord(OTHER_ID, "乔炳源", "2026-08-29T00:01:00.000Z"));
  await assert.rejects(() => store.resolveOrCreate({ displayName: "乔炳源" }), /user_conflict/);
  await assert.rejects(() => store.verify({ userId: USER_ID, displayName: "乔炳源" }), /user_conflict/);
});

test("registration files with an unexpected parent are rejected", async () => {
  const { drive, layout, store } = setup();
  const registry = await layout.ensureRegistry();
  const stray = await drive.createJson("unexpected-parent", `registration-${OTHER_ID}.json`, registrationRecord(OTHER_ID, "乔炳源"));
  drive.setJsonListings([[stray], [stray]]);
  assert.deepEqual(await store.listRegistrations(), []);
  await assert.rejects(() => store.verify({ userId: OTHER_ID, displayName: "乔炳源" }), /identity_mismatch/);
});

test("registration files whose filename disagrees with the payload are rejected", async () => {
  const { drive, layout, store } = setup();
  const registry = await layout.ensureRegistry();
  await drive.createJson(registry.id, `registration-${OTHER_ID}.json`, registrationRecord(USER_ID, "乔炳源"));
  assert.deepEqual(await store.listRegistrations(), []);
});

test("the registration file is the last visible commit point", async () => {
  const { drive, store } = setup();
  const createJson = drive.createJson;
  drive.createJson = async (parentId, name, value) => {
    if (name.startsWith("registration-")) throw new Error("drive_write_failed");
    return createJson.call(drive, parentId, name, value);
  };
  await assert.rejects(() => store.resolveOrCreate({ displayName: "乔炳源" }), /drive_write_failed/);
  assert.equal(drive.filesByPrefix("identity.json").length, 1);
  assert.equal(drive.filesByPrefix("registration-").length, 0);
});

test("verify accepts a registered identity and rejects mismatches", async () => {
  const { store } = setup();
  await store.resolveOrCreate({ displayName: "乔炳源" });
  const verified = await store.verify({ userId: USER_ID, displayName: " 乔炳源 " });
  assert.equal(verified.status, "ok");
  assert.equal(verified.identity.userId, USER_ID);
  assert.equal(verified.identity.displayName, "乔炳源");
  await assert.rejects(() => store.verify({ userId: USER_ID, displayName: "李四" }), /identity_mismatch/);
  await assert.rejects(() => store.verify({ userId: OTHER_ID, displayName: "乔炳源" }), /identity_mismatch/);
  await assert.rejects(() => store.verify({ userId: USER_ID, displayName: "" }), /invalid_display_name/);
});

test("an explicit preferred user id is reused when it is still free", async () => {
  const { drive, store } = setup({ uuid: idSequence() });
  const result = await store.resolveOrCreate({ displayName: "乔炳源", preferredUserId: THIRD_ID });
  assert.equal(result.userId, THIRD_ID);
  assert.equal(drive.filesByPrefix(`registration-${THIRD_ID}.json`).length, 1);
});

test("an explicit preferred user id already bound to another name is refused", async () => {
  const { store } = setup({ uuid: idSequence() });
  await store.resolveOrCreate({ displayName: "乔炳源", preferredUserId: USER_ID });
  await assert.rejects(() => store.resolveOrCreate({ displayName: "李四", preferredUserId: USER_ID }), /user_conflict/);
});
