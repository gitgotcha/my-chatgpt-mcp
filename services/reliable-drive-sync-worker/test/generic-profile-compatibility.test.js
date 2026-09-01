import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "./submit-event-adapter.js";

// Feature-flag compatibility matrix: representative old writes must produce
// identical Drive artifacts and dispatch results whether the generic profile
// flag is absent, "false" or "true", and must never touch the generic path.

function fakeDrive() {
  const folders = new Map([["root", { id: "root", name: "root", parents: [] }]]);
  const files = new Map();
  let sequence = 0;
  const childItems = (parentId, name) => [...folders.values(), ...files.values()]
    .filter((item) => item.parents?.length === 1 && item.parents[0] === parentId && (!name || item.name === name));
  return {
    rootFolderId: "root",
    folders,
    files,
    createdJsonFiles: [],
    async findFolder(parentId, name) { return childItems(parentId, name).find((item) => item.mimeType === "application/vnd.google-apps.folder") ?? null; },
    async ensureFolder(parentId, name) {
      const found = childItems(parentId, name).find((item) => item.mimeType === "application/vnd.google-apps.folder");
      if (found) return found;
      const folder = { id: `folder-${++sequence}`, name, parents: [parentId], mimeType: "application/vnd.google-apps.folder" };
      folders.set(folder.id, folder);
      return folder;
    },
    async listChildren(parentId, { name, foldersOnly } = {}) {
      return childItems(parentId, name).filter((item) => !foldersOnly || item.mimeType === "application/vnd.google-apps.folder");
    },
    async listJson(parentId) { return childItems(parentId).filter((item) => item.mimeType === "application/json"); },
    async createJson(parentId, name, value) {
      const file = { id: `file-${++sequence}`, name, parents: [parentId], mimeType: "application/json", value: structuredClone(value) };
      files.set(file.id, file);
      this.createdJsonFiles.push(file);
      return structuredClone(file);
    },
    async readJson(id) { const file = files.get(id); return file ? structuredClone(file) : null; }
  };
}

function userStoreStub(userId) {
  const identity = { userId, displayName: "验收用户", nameKey: "验收用户", verified: true };
  return {
    async verify({ userId, displayName }) {
      if (userId !== identity.userId || displayName !== identity.displayName) throw new Error("identity_mismatch");
      return { status: "ok", identity: { ...identity } };
    },
    async resolveOrCreate({ displayName }) {
      if (displayName !== identity.displayName) throw new Error("user_conflict");
      return { status: "ok", identity: { ...identity } };
    },
    async findByDisplayName(displayName) { return displayName === identity.displayName ? { ...identity } : null; }
  };
}

const FIXED_USER_ID = "11111111-1111-4111-8111-111111111111";

function envFor(flag) {
  const base = { MCP_BEARER_TOKEN: "secret", GOOGLE_DRIVE_FOLDER_ID: "root" };
  return flag === undefined ? base : { ...base, GENERIC_PROFILE_ENABLED: flag };
}

async function dispatch(drive, id, eventType, payload, { namespace, identity, flag }) {
  const arguments_ = {
    schemaVersion: "1.2",
    namespace,
    eventType,
    ...(identity ? { identity } : {}),
    payload,
    requestId: `99999999-9999-4999-8999-${String(id).padStart(12, "0")}`
  };
  const message = { jsonrpc: "2.0", id, method: "tools/call", params: { name: "submit_event", arguments: arguments_ } };
  const response = await handleRequest(new Request("https://example.test/mcp", {
    method: "POST",
    headers: { authorization: "Bearer secret", "content-type": "application/json" },
    body: JSON.stringify(message)
  }), envFor(flag), { drive, userStore: userStoreStub(FIXED_USER_ID) });
  const body = await response.json();
  assert.equal(body.error, undefined, JSON.stringify(body));
  return JSON.parse(body.result.content[0].text);
}

function normalize(value) {
  const text = JSON.stringify(value);
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g, "<ts>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z/g, "<snap-ts>");
}

async function runOldSuite(flag) {
  const drive = fakeDrive();
  const registered = await dispatch(drive, 1, "system.user-registered", { displayName: "验收用户" }, { namespace: "system", flag });
  const algorithmEvent = {
    schemaVersion: "1.2",
    eventId: "44444444-4444-4444-8444-444444444444",
    eventKey: `${FIXED_USER_ID}:algorithm-learning:two-sum:2026-08-14T10:00:00.000Z`,
    eventType: "algorithm.learning.completed",
    userId: FIXED_USER_ID,
    username: "验收用户",
    observedAt: "2026-08-14T10:00:00.000Z",
    source: "qa",
    topic: "two-sum",
    problem: { title: "Two Sum", source: "Hot100", url: "" },
    outcome: "consulted",
    evidence: "用户请求讲解两数之和。",
    tags: ["hash-map"],
    confidence: "medium"
  };
  const algorithm = await dispatch(drive, 2, "algorithm.learning.completed", { event: algorithmEvent }, { namespace: "algorithm", identity: { username: "验收用户" }, flag });
  const driveArtifact = drive.createdJsonFiles.map((file) => ({ name: file.name, value: file.value }));
  const genericFolders = [...drive.folders.values()].filter((folder) => !["root", "my-chatGPT-skills", "users", FIXED_USER_ID, "algorithm", "events", "profile", "snapshots", "plans", "daily"].includes(folder.name));
  return {
    registered,
    algorithm,
    driveArtifact: normalize(driveArtifact),
    genericFolders
  };
}

for (const [label, flag] of [["absent", undefined], ["false", "false"], ["true", "true"]]) {
  test(`old registration and algorithm writes are unaffected by the ${label} flag`, async () => {
    const result = await runOldSuite(flag);
    assert.equal(result.registered.status, "ok");
    assert.equal(result.registered.identity.userId, FIXED_USER_ID);
    assert.equal(result.algorithm.status, "ok");
    assert.equal(result.algorithm.data.profile.headEventId, "44444444-4444-4444-8444-444444444444");
    assert.deepEqual(result.genericFolders, [], "generic path must not be invoked by old events");
  });
}

test("old write results and Drive artifacts are byte-equivalent across the three flag values", async () => {
  const absent = await runOldSuite(undefined);
  const off = await runOldSuite("false");
  const on = await runOldSuite("true");
  assert.equal(normalize(absent.registered), normalize(off.registered));
  assert.equal(normalize(absent.registered), normalize(on.registered));
  assert.equal(normalize(absent.algorithm), normalize(off.algorithm));
  assert.equal(normalize(absent.algorithm), normalize(on.algorithm));
  assert.equal(absent.driveArtifact, off.driveArtifact);
  assert.equal(absent.driveArtifact, on.driveArtifact);
});
