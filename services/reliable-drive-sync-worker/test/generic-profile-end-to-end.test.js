import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "./submit-event-adapter.js";
import { createGenericProfileStore } from "../src/generic-profile-store.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const USERNAME = "乔炳源";
const DOMAIN = "english-learning";

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
    async findFolder(parentId, name) { return childItems(parentId, name).find((item) => item.mimeType === "application/vnd.google-apps.folder") ?? null; },
    async ensureFolder(parentId, name) {
      const found = await this.findFolder(parentId, name);
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
      return structuredClone(file);
    },
    async readJson(id) { const file = files.get(id); return file ? structuredClone(file) : null; }
  };
}

function userStoreStub() {
  const known = { userId: USER_ID, displayName: USERNAME, nameKey: USERNAME, verified: true };
  const calls = { resolveOrCreate: 0, verify: 0, findByDisplayName: 0 };
  return {
    calls,
    async verify({ userId, displayName }) {
      calls.verify += 1;
      if (userId !== known.userId || displayName !== known.displayName) throw new Error("identity_mismatch");
      return { status: "ok", identity: { ...known } };
    },
    async findByDisplayName(displayName) {
      calls.findByDisplayName += 1;
      return displayName === known.displayName ? { ...known } : null;
    },
    async resolveOrCreate({ displayName }) {
      calls.resolveOrCreate += 1;
      if (displayName === known.displayName) return { status: "ok", identity: { ...known } };
      return { status: "ok", identity: { userId: "22222222-2222-4222-8222-222222222222", displayName, nameKey: displayName, verified: true } };
    }
  };
}

function env(enabled = true) {
  return {
    MCP_BEARER_TOKEN: "secret",
    GOOGLE_DRIVE_FOLDER_ID: "root",
    GENERIC_PROFILE_ENABLED: enabled ? "true" : "false"
  };
}

function request(method, params) {
  return new Request("https://example.test/mcp", {
    method: "POST",
    headers: { authorization: "Bearer secret", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
}

function submitCall(args) {
  return request("tools/call", { name: "submit_event", arguments: args });
}

async function dispatch(args, deps) {
  const response = await handleRequest(submitCall(args), env(true), deps);
  const body = await response.json();
  return body;
}

function capabilitiesArgs() {
  return { schemaVersion: "1.2", namespace: "system", eventType: "system.capabilities.read", requestId: "cap-1" };
}

function resolveArgs(displayName = USERNAME) {
  return { schemaVersion: "1.2", namespace: "system", eventType: "system.user.resolve", payload: { displayName }, requestId: "resolve-1" };
}

function profileReadArgs(domain = DOMAIN, identity = { username: USERNAME }) {
  return { schemaVersion: "1.2", namespace: "profile", eventType: "profile.snapshot.read", identity, payload: { domain }, requestId: "read-1" };
}

function evidenceArgs(domain = DOMAIN, identity = { username: USERNAME }) {
  return {
    schemaVersion: "1.2",
    namespace: "profile",
    eventType: "profile.evidence.recorded",
    identity,
    payload: {
      domain,
      event: {
        schemaVersion: "1.0",
        eventId: "30000000-0000-4000-8000-000000000001",
        eventKey: "english-learning:vocabulary:concurrency:2026-09-01:1",
        observedAt: "2026-09-01T10:00:00.000Z",
        sourceSkill: "english-learning",
        action: "observe",
        observations: [{
          dimensionKey: "vocabulary",
          subjectKey: "concurrency",
          outcome: "stuck",
          evidence: "用户无法解释 concurrency 的含义。",
          confidence: "high",
          sourceRef: "conversation:2026-09-01:turn-1"
        }]
      }
    },
    requestId: "evidence-1"
  };
}

test("capabilities read returns the contract before any infrastructure is constructed", async () => {
  const throwingDeps = {
    get drive() { throw new Error("drive_constructed"); },
    get layout() { throw new Error("layout_constructed"); },
    get userStore() { throw new Error("user_store_constructed") }
  };
  const body = await dispatch(capabilitiesArgs(), throwingDeps);
  assert.equal(body.error, undefined);
  const value = JSON.parse(body.result.content[0].text);
  assert.equal(value.status, "ok");
  assert.equal(value.data.genericProfile.enabled, true);
  assert.deepEqual(value.data.genericProfile.eventTypes, ["system.user.resolve", "profile.evidence.recorded", "profile.snapshot.read"]);
});

test("capabilities read reports disabled when the flag is off or missing", async () => {
  for (const envValue of [{ GENERIC_PROFILE_ENABLED: "false" }, {}]) {
    const response = await handleRequest(submitCall(capabilitiesArgs()), { MCP_BEARER_TOKEN: "secret", GOOGLE_DRIVE_FOLDER_ID: "root", ...envValue }, {});
    const body = await response.json();
    const value = JSON.parse(body.result.content[0].text);
    assert.equal(value.data.genericProfile.enabled, false);
    assert.deepEqual(value.data.genericProfile.eventTypes, []);
  }
});

test("disabled generic profile reads and writes return unsupported_capability while old events still work", async () => {
  const drive = fakeDrive();
  const userStore = userStoreStub();
  const layout = { ensureDomainPath: () => drive.ensureFolder, findDomainPath: () => null };
  const deps = { drive, userStore, layout, handlers: { "system.user-registered": async () => ({ status: "ok", data: { registered: true } }) } };
  const offEnv = { MCP_BEARER_TOKEN: "secret", GOOGLE_DRIVE_FOLDER_ID: "root", GENERIC_PROFILE_ENABLED: "false" };

  const readResponse = await handleRequest(submitCall(profileReadArgs()), offEnv, deps);
  const readBody = await readResponse.json();
  assert.equal(readBody.error.code, -32602);
  assert.match(readBody.error.message, /unsupported_capability/);

  const writeResponse = await handleRequest(submitCall(evidenceArgs()), offEnv, deps);
  const writeBody = await writeResponse.json();
  assert.equal(writeBody.error.code, -32602);
  assert.match(writeBody.error.message, /unsupported_capability/);

  const registration = await handleRequest(submitCall({
    schemaVersion: "1.2", namespace: "system", eventType: "system.user-registered",
    payload: { displayName: USERNAME }, requestId: "reg-1"
  }), offEnv, deps);
  const regBody = await registration.json();
  assert.equal(regBody.result ? JSON.parse(regBody.result.content[0].text).status : null, "ok");
});

test("system.user.resolve returns a normalized user and never calls resolveOrCreate", async () => {
  const userStore = userStoreStub();
  const body = await dispatch(resolveArgs(), { userStore });
  assert.equal(body.error, undefined);
  const value = JSON.parse(body.result.content[0].text);
  assert.equal(value.status, "ok");
  assert.equal(value.data.userId, USER_ID);
  assert.equal(value.data.username, USERNAME);
  assert.equal(userStore.calls.resolveOrCreate, 0);
  assert.equal(userStore.calls.findByDisplayName, 1);
});

test("an unknown resolve returns identity_not_found without registering", async () => {
  const userStore = userStoreStub();
  const body = await dispatch(resolveArgs("陌生人"), { userStore });
  assert.equal(body.error.code, -32602);
  assert.match(body.error.message, /identity_not_found/);
  assert.equal(userStore.calls.resolveOrCreate, 0);
});

test("profile read and write require an existing verified user and never auto-create", async () => {
  const drive = fakeDrive();
  const layout = (await import("../src/storage-layout.js")).createStorageLayout({ drive });
  const userStore = userStoreStub();
  const genericProfileStore = createGenericProfileStore({ userStore, layout, drive });
  const deps = { drive, userStore, layout, stores: new Map(), genericProfileStore };

  const readStranger = await handleRequest(submitCall(profileReadArgs(DOMAIN, { username: "陌生人" })), env(), deps);
  const readBody = await readStranger.json();
  assert.equal(readBody.error.code, -32602);
  assert.match(readBody.error.message, /identity_not_found/);

  const writeStranger = await handleRequest(submitCall(evidenceArgs(DOMAIN, { username: "陌生人" })), env(), deps);
  const writeBody = await writeStranger.json();
  assert.equal(writeBody.error.code, -32602);
  assert.match(writeBody.error.message, /identity_not_found/);
  assert.equal(userStore.calls.resolveOrCreate, 0);
});

test("the inner profile event receives bound identity and domain before storage", async () => {
  const drive = fakeDrive();
  const layout = (await import("../src/storage-layout.js")).createStorageLayout({ drive });
  const userStore = userStoreStub();
  let captured;
  const genericProfileStore = {
    async submitEvidence(identity, domain, event) {
      captured = { identity, domain, event: structuredClone(event) };
      return { status: "ok", event, receipt: { fileId: "file-1", eventId: event.eventId, eventKey: event.eventKey }, data: { profile: {}, snapshotReceipt: {} } };
    },
    async readProfile() { return { status: "ok", data: { domain: DOMAIN, profile: {}, projectionState: "rebuilt_in_memory" } }; }
  };
  const deps = { drive, userStore, layout, genericProfileStore };
  const body = await dispatch(evidenceArgs(), deps);
  assert.equal(body.error, undefined);
  assert.ok(captured, "handler was not reached");
  assert.equal(captured.identity.userId, USER_ID);
  assert.equal(captured.identity.username, USERNAME);
  assert.equal(captured.domain, DOMAIN);
  assert.equal(captured.event.userId, USER_ID);
  assert.equal(captured.event.username, USERNAME);
  assert.equal(captured.event.domain, DOMAIN);
});

test("a profile read returns the in-memory projection for a known user", async () => {
  const drive = fakeDrive();
  const layout = (await import("../src/storage-layout.js")).createStorageLayout({ drive });
  const userStore = userStoreStub();
  const genericProfileStore = createGenericProfileStore({ userStore, layout, drive });
  const deps = { drive, userStore, layout, genericProfileStore };
  const body = await dispatch(profileReadArgs(), deps);
  assert.equal(body.error, undefined);
  const value = JSON.parse(body.result.content[0].text);
  assert.equal(value.status, "ok");
  assert.equal(value.data.domain, DOMAIN);
  assert.equal(value.data.projectionState, "rebuilt_in_memory");
});

test("a profile write persists evidence and returns a snapshot receipt", async () => {
  const drive = fakeDrive();
  const layout = (await import("../src/storage-layout.js")).createStorageLayout({ drive });
  const userStore = userStoreStub();
  const genericProfileStore = createGenericProfileStore({ userStore, layout, drive });
  const deps = { drive, userStore, layout, genericProfileStore };
  const body = await dispatch(evidenceArgs(), deps);
  assert.equal(body.error, undefined);
  const value = JSON.parse(body.result.content[0].text);
  assert.equal(value.status, "ok");
  assert.equal(value.event.userId, USER_ID);
  assert.equal(value.event.domain, DOMAIN);
  assert.match(value.receipt.eventId, /^[0-9a-f-]{36}$/i);
  assert.ok(value.data.snapshotReceipt.headEventId);
});

test("store errors surface as non-retryable protocol errors", async () => {
  const drive = fakeDrive();
  const layout = (await import("../src/storage-layout.js")).createStorageLayout({ drive });
  const userStore = userStoreStub();
  const genericProfileStore = {
    async submitEvidence() { throw new Error("event_key_conflict"); },
    async readProfile() { throw new Error("target_event_not_found"); }
  };
  const deps = { drive, userStore, layout, genericProfileStore };
  const writeBody = await dispatch(evidenceArgs(), deps);
  assert.equal(writeBody.error.code, -32602);
  assert.match(writeBody.error.message, /event_key_conflict/);
});
