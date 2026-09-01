import assert from "node:assert/strict";
import test from "node:test";
import { createAlgorithmStore } from "../src/algorithm-store.js";
import { createStorageLayout } from "../src/storage-layout.js";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const identity = { userId: USER_ID, username: "Ada" };

function fakeDrive() {
  const folders = new Map([["root", { id: "root", name: "root", parents: [] }]]);
  const files = new Map();
  const createdJsonFiles = [];
  let number = 0;
  const children = (parentId, name) => [...folders.values()]
    .filter((folder) => folder.parents[0] === parentId && (!name || folder.name === name));
  return {
    rootFolderId: "root",
    folders,
    files,
    createdJsonFiles,
    async findFolder(parentId, name) { return children(parentId, name)[0] ?? null; },
    async ensureFolder(parentId, name) {
      const found = children(parentId, name)[0];
      if (found) return found;
      const folder = { id: `folder-${++number}`, name, parents: [parentId] };
      folders.set(folder.id, folder);
      return folder;
    },
    async listJson(parentId) { return [...files.values()].filter((file) => file.parents[0] === parentId); },
    async createJson(parentId, name, value) {
      const file = { id: `file-${++number}`, name, parents: [parentId], mimeType: "application/json", value: structuredClone(value) };
      files.set(file.id, file);
      createdJsonFiles.push(file);
      return structuredClone(file);
    },
    async readJson(id) { return structuredClone(files.get(id)); }
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

function learningEvent(overrides = {}) {
  return {
    schemaVersion: "1.2",
    eventId: "10000000-0000-4000-8000-000000000001",
    eventKey: `${USER_ID}:qa:two-sum:2026-08-14T10:00:00.000Z`,
    eventType: "algorithm.learning.completed",
    userId: USER_ID,
    username: "Ada",
    observedAt: "2026-08-14T10:00:00.000Z",
    source: "qa",
    topic: "双指针",
    problem: { title: "两数之和", source: "Hot100", url: "" },
    evidence: "用户请求讲解两数之和。",
    outcome: "incorrect",
    tags: ["hash-map"],
    confidence: "medium",
    ...overrides
  };
}

function planEvent(overrides = {}) {
  return {
    schemaVersion: "1.2",
    eventId: "20000000-0000-4000-8000-000000000001",
    eventKey: `${USER_ID}:algorithm:daily-plan:2026-08-14`,
    eventType: "algorithm.daily-plan-created",
    userId: USER_ID,
    username: "Ada",
    localDate: "2026-08-14",
    planId: "plan-abc",
    timezone: "Asia/Shanghai",
    generatedAt: "2026-08-14T01:00:00.000Z",
    items: [{ itemId: "item-1", title: "两数之和", source: "Hot100", role: "weakness-review" }],
    ...overrides
  };
}

function setup(options = {}) {
  const drive = fakeDrive();
  const layout = createStorageLayout({ drive });
  const events = options.events ?? [];
  const eventStore = {
    appendEvent: async (_requestedIdentity, value) => {
      events.push(value);
      return { event: value, receipt: { fileId: "event-file", eventId: value.eventId, eventKey: value.eventKey } };
    },
    listVerifiedEvents: async () => structuredClone(events),
    ...options.eventStore
  };
  return {
    drive,
    layout,
    events,
    store: createAlgorithmStore({ eventStore, layout, drive, ...options.storeOptions })
  };
}

test("a learning event materializes the algorithm snapshot below the canonical root", async () => {
  const { drive, store } = setup();
  const result = await store.submitLearning(identity, learningEvent());
  assert.equal(result.status, "ok");

  const snapshots = drive.createdJsonFiles.filter((file) => file.name.startsWith("snapshot-"));
  assert.equal(snapshots.length, 1);
  assert.deepEqual(ancestryOf(drive, snapshots[0]), [
    "my-chatGPT-skills", "users", USER_ID, "algorithm", "profile", "snapshots", snapshots[0].name
  ]);
  assert.equal(result.data.profile.headEventId, "10000000-0000-4000-8000-000000000001");
  assert.deepEqual(result.data.profile.weaknesses.map((weakness) => weakness.topic), ["双指针"]);
});

test("a failing projection returns profile_cache_pending without duplicating the event", async () => {
  const { drive, events, store } = setup({
    storeOptions: { now: () => { throw new Error("clock unavailable"); } }
  });
  const result = await store.submitLearning(identity, learningEvent());
  assert.equal(result.status, "profile_cache_pending");
  assert.equal(result.data.profileRebuildRequired, true);
  assert.equal(events.length, 1);
  assert.deepEqual(drive.createdJsonFiles.filter((file) => file.name.startsWith("snapshot-")), []);
});

test("a daily plan is written below the canonical plans folder", async () => {
  const { drive, store } = setup();
  const result = await store.createDailyPlan(identity, planEvent());
  assert.equal(result.status, "ok");
  assert.equal(result.receipt.name, "daily-plan-2026-08-14-plan-abc.json");
  assert.deepEqual(ancestryOf(drive, drive.createdJsonFiles.at(-1)), [
    "my-chatGPT-skills", "users", USER_ID, "algorithm", "plans", "daily", "daily-plan-2026-08-14-plan-abc.json"
  ]);
});

test("the same date and plan key reuse the existing plan", async () => {
  const { drive, events, store } = setup();
  const first = await store.createDailyPlan(identity, planEvent());
  const filesAfterFirst = drive.createdJsonFiles.length;
  const second = await store.createDailyPlan(identity, planEvent());

  assert.equal(second.receipt.fileId, first.receipt.fileId);
  assert.equal(second.receipt.reused, true);
  assert.equal(drive.createdJsonFiles.length, filesAfterFirst);
  // The reuse path must not append another event.
  assert.equal(events.length, 1);
});

test("a different plan key on the same date creates another file", async () => {
  const { drive, store } = setup();
  await store.createDailyPlan(identity, planEvent());
  const second = await store.createDailyPlan(identity, planEvent({
    eventId: "20000000-0000-4000-8000-000000000002",
    eventKey: `${USER_ID}:algorithm:daily-plan:2026-08-14:b`,
    planId: "plan-def"
  }));
  assert.equal(second.receipt.name, "daily-plan-2026-08-14-plan-def.json");
  assert.equal(second.receipt.reused, false);
  assert.equal(drive.createdJsonFiles.filter((file) => file.name.startsWith("daily-plan-")).length, 2);
});

test("a plan readback mismatch is reported instead of silently accepted", async () => {
  const drive = fakeDrive();
  const layout = createStorageLayout({ drive });
  const eventStore = {
    appendEvent: async (_requestedIdentity, value) => ({ event: value, receipt: { fileId: "event-file", eventId: value.eventId, eventKey: value.eventKey } }),
    listVerifiedEvents: async () => []
  };
  // The read-back reports a different parent, so the write cannot be trusted.
  const brokenDrive = {
    ...drive,
    async readJson(id) {
      const file = await drive.readJson(id);
      return file ? { ...file, parents: ["unexpected-parent"] } : null;
    }
  };
  const store = createAlgorithmStore({ eventStore, layout, drive: brokenDrive });
  await assert.rejects(() => store.createDailyPlan(identity, planEvent()), /plan_readback_failed/);
});

test("an invalid store configuration is rejected", () => {
  assert.throws(() => createAlgorithmStore({}), /invalid_algorithm_store/);
});
