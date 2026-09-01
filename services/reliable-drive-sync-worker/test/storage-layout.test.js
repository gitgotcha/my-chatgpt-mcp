import assert from "node:assert/strict";
import test from "node:test";
import { createStorageLayout } from "../src/storage-layout.js";

const USER_ID = "00000000-0000-4000-8000-000000000001";

function fakeDrive() {
  const items = new Map([
    ["root", { id: "root", name: "root", parents: [], mimeType: "application/vnd.google-apps.folder" }]
  ]);
  let sequence = 0;
  const childItems = (parentId, name) => [...items.values()]
    .filter((item) => item.parents.length === 1 && item.parents[0] === parentId && (!name || item.name === name));
  const drive = {
    rootFolderId: "root",
    createdFolders: [],
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
      drive.createdFolders.push(folder);
      return folder;
    },
    async listChildren(parentId, { name, foldersOnly } = {}) {
      return childItems(parentId, name).filter((item) => !foldersOnly || item.mimeType === "application/vnd.google-apps.folder");
    },
    async listJson(parentId) {
      return childItems(parentId).filter((item) => item.mimeType === "application/json");
    },
    async createJson(parentId, name, value) {
      const file = { id: `file-${++sequence}`, name, parents: [parentId], mimeType: "application/json", value: structuredClone(value) };
      items.set(file.id, file);
      return structuredClone(file);
    },
    async readJson(id) {
      const item = items.get(id);
      return item ? structuredClone(item) : null;
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
    path(id) {
      return drive.ancestry(id).join("/");
    },
    findPath(fullPath) {
      return [...items.values()].find((item) => drive.path(item.id) === fullPath);
    }
  };
  return drive;
}

function setup(options = {}) {
  const drive = fakeDrive();
  return { drive, layout: createStorageLayout({ drive, ...options }) };
}

test("algorithm events use the canonical plugin root", async () => {
  const { drive, layout } = setup();
  const folder = await layout.ensureDomainPath(USER_ID, "algorithm", ["events"]);
  assert.deepEqual(drive.ancestry(folder.id), [
    "root", "my-chatGPT-skills", "users", USER_ID, "algorithm", "events"
  ]);
});

test("domain creation never creates a namespace registry", async () => {
  const { drive, layout } = setup();
  await layout.ensureDomainPath(USER_ID, "interview", ["events"]);
  assert.equal(drive.findPath("root/algorithm/user-registry"), undefined);
  assert.equal(drive.findPath("root/interview/user-registry"), undefined);
});

test("the global registry lives directly under the plugin root", async () => {
  const { drive, layout } = setup();
  const registry = await layout.ensureRegistry();
  assert.deepEqual(drive.ancestry(registry.id), ["root", "my-chatGPT-skills", "user-registry"]);
});

test("resume knowledge exposes every documented leaf directory", async () => {
  const { drive, layout } = setup();
  const leaves = [
    ["sources", "resume", "snapshots"],
    ["question-bank", "snapshots"],
    ["events"],
    ["profile", "snapshots"],
    ["plans", "daily"]
  ];
  for (const segments of leaves) {
    const folder = await layout.ensureDomainPath(USER_ID, "resume-knowledge", segments);
    assert.deepEqual(drive.ancestry(folder.id), [
      "root", "my-chatGPT-skills", "users", USER_ID, "resume-knowledge", ...segments
    ]);
  }
});

test("unknown domains are rejected", async () => {
  const { layout } = setup();
  await assert.rejects(() => layout.ensureDomainPath(USER_ID, "resume", ["events"]), /invalid_domain/);
  await assert.rejects(() => layout.findDomainPath(USER_ID, "resume", ["events"]), /invalid_domain/);
});

test("leaf directories outside the design are rejected", async () => {
  const { layout } = setup();
  await assert.rejects(() => layout.ensureDomainPath(USER_ID, "algorithm", ["practice"]), /invalid_path/);
  await assert.rejects(() => layout.ensureDomainPath(USER_ID, "algorithm", ["profile", "current"]), /invalid_path/);
  await assert.rejects(() => layout.ensureDomainPath(USER_ID, "algorithm", ["profile", "history"]), /invalid_path/);
  await assert.rejects(() => layout.ensureDomainPath(USER_ID, "interview", ["plans", "daily"]), /invalid_path/);
  await assert.rejects(() => layout.ensureDomainPath(USER_ID, "resume-knowledge", ["raw"]), /invalid_path/);
});

test("path separators and traversal segments are rejected", async () => {
  const { layout } = setup();
  await assert.rejects(() => layout.ensureDomainPath(USER_ID, "algorithm", ["..", "events"]), /invalid_path/);
  await assert.rejects(() => layout.ensureDomainPath(USER_ID, "algorithm", ["events", ".."]), /invalid_path/);
  await assert.rejects(() => layout.ensureDomainPath(USER_ID, "algorithm", ["."]), /invalid_path/);
  await assert.rejects(() => layout.ensureDomainPath(USER_ID, "algorithm", ["ev/ents"]), /invalid_path/);
  await assert.rejects(() => layout.ensureDomainPath(USER_ID, "algorithm", ["ev\\ents"]), /invalid_path/);
  await assert.rejects(() => layout.ensureDomainPath(USER_ID, "algorithm", []), /invalid_path/);
});

test("user ids carrying path separators are rejected", async () => {
  const { layout } = setup();
  await assert.rejects(() => layout.ensureUserRoot("../escape"), /invalid_user_id/);
  await assert.rejects(() => layout.ensureUserRoot("users/../x"), /invalid_user_id/);
  await assert.rejects(() => layout.ensureUserRoot(""), /invalid_user_id/);
});

test("find lookups return null before the canonical tree exists", async () => {
  const { layout } = setup();
  assert.equal(await layout.findBase(), null);
  assert.equal(await layout.findUserRoot(USER_ID), null);
  assert.equal(await layout.findDomainPath(USER_ID, "algorithm", ["events"]), null);
});

test("ensure and find agree without creating sibling directories", async () => {
  const { drive, layout } = setup();
  const created = await layout.ensureDomainPath(USER_ID, "algorithm", ["profile", "snapshots"]);
  const found = await layout.findDomainPath(USER_ID, "algorithm", ["profile", "snapshots"]);
  assert.equal(found.id, created.id);
  assert.equal(drive.createdFolders.filter((folder) => folder.name === "events").length, 0);
  assert.equal(drive.createdFolders.filter((folder) => folder.name === "users").length, 1);
});

test("a custom plugin root name is honoured", async () => {
  const drive = fakeDrive();
  const layout = createStorageLayout({ drive, pluginRootName: "custom-root" });
  const folder = await layout.ensureDomainPath(USER_ID, "interview", ["events"]);
  assert.deepEqual(drive.ancestry(folder.id), ["root", "custom-root", "users", USER_ID, "interview", "events"]);
});
