import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "./submit-event-adapter.js";
import { validateEnvelope, inspectEnvelope, ALLOWED_NAMESPACES } from "../src/protocol.js";

function env() {
  return {
    MCP_BEARER_TOKEN: "secret",
    GOOGLE_DRIVE_FOLDER_ID: "root"
  };
}

function request(method, params, token = "secret") {
  return new Request("https://example.test/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
}

function algorithmDrive() {
  const folders = new Map();
  const files = new Map();
  let sequence = 0;
  const children = (parentId, name) => [...folders.values(), ...files.values()]
    .filter((item) => item.parents?.length === 1 && item.parents[0] === parentId && (!name || item.name === name));
  return {
    rootFolderId: "root",
    folders,
    createdJsonFiles: [],
    async findFolder(parentId, name) { return children(parentId, name).find((item) => item.mimeType === "application/vnd.google-apps.folder") ?? null; },
    async ensureFolder(parentId, name) {
      const found = await this.findFolder(parentId, name);
      if (found) return found;
      const folder = { id: `folder-${++sequence}`, name, parents: [parentId], mimeType: "application/vnd.google-apps.folder" };
      folders.set(folder.id, folder);
      return folder;
    },
    async listChildren(parentId, { name, foldersOnly } = {}) {
      return children(parentId, name).filter((item) => !foldersOnly || item.mimeType === "application/vnd.google-apps.folder");
    },
    async listJson(parentId) { return children(parentId).filter((item) => item.mimeType === "application/json"); },
    async createJson(parentId, name, value) {
      const file = { id: `file-${++sequence}`, name, parents: [parentId], mimeType: "application/json", value: structuredClone(value) };
      files.set(file.id, file);
      this.createdJsonFiles.push(file);
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

function learningEvent(userId, username, eventId = "10000000-0000-4000-8000-000000000001") {
  return {
    schemaVersion: "1.2",
    eventId,
    eventKey: `${userId}:algorithm-learning:two-sum:2026-08-14T10:00:00.000Z`,
    eventType: "algorithm.learning.completed",
    userId,
    username,
    observedAt: "2026-08-14T10:00:00.000Z",
    source: "qa",
    topic: "two-sum",
    problem: { title: "Two Sum", source: "Hot100", url: "" },
    outcome: "consulted",
    evidence: "用户请求讲解两数之和。",
    tags: ["hash-map"],
    confidence: "medium"
  };
}

async function submit(drive, args) {
  const response = await handleRequest(request("tools/call", {
    name: "submit_event",
    arguments: args
  }), env(), { drive });
  const body = await response.json();
  assert.equal(body.error, undefined, JSON.stringify(body));
  return JSON.parse(body.result.content[0].text);
}

test("submit_event rejects a path-like namespace", async () => {
  const response = await handleRequest(request("tools/call", {
    name: "submit_event",
    arguments: {
      schemaVersion: "1.2",
      namespace: "../interview",
      eventType: "system.user-registered",
      payload: { displayName: "Ada" },
      requestId: "00000000-0000-4000-8000-000000000001"
    }
  }), env());
  const payload = await response.json();
  assert.equal(payload.error.code, -32602);
  assert.match(payload.error.message, /invalid_namespace/);
});

test("submit_event rejects a migration request without an explicit mode", async () => {
  const response = await handleRequest(request("tools/call", {
    name: "submit_event",
    arguments: {
      schemaVersion: "1.2",
      namespace: "system",
      eventType: "system.legacy-migration-requested",
      payload: { displayName: "旧用户" },
      requestId: "00000000-0000-4000-8000-000000000001"
    }
  }), env());
  const payload = await response.json();
  assert.equal(payload.error.code, -32602);
  assert.match(payload.error.message, /invalid_payload/);
});

test("submit_event rejects a migration domain that never held legacy data", async () => {
  const response = await handleRequest(request("tools/call", {
    name: "submit_event",
    arguments: {
      schemaVersion: "1.2",
      namespace: "system",
      eventType: "system.legacy-migration-requested",
      payload: { displayName: "旧用户", mode: "dry-run", domains: ["resume-knowledge"] },
      requestId: "00000000-0000-4000-8000-000000000002"
    }
  }), env());
  const payload = await response.json();
  assert.equal(payload.error.code, -32602);
  assert.match(payload.error.message, /invalid_payload/);
});

test("submit_event rejects an execute migration that carries no approved plan hash", async () => {
  const response = await handleRequest(request("tools/call", {
    name: "submit_event",
    arguments: {
      schemaVersion: "1.2",
      namespace: "system",
      eventType: "system.legacy-migration-requested",
      payload: {
        displayName: "旧用户",
        mode: "execute",
        migrationId: "99999999-9999-4999-8999-000000000001"
      },
      requestId: "00000000-0000-4000-8000-000000000003"
    }
  }), env());
  const payload = await response.json();
  assert.equal(payload.error.code, -32602);
  assert.match(payload.error.message, /invalid_payload/);
});

test("submit_event rejects an incomplete session payload", async () => {
  const response = await handleRequest(request("tools/call", {
    name: "submit_event",
    arguments: {
      schemaVersion: "1.2",
      namespace: "interview",
      eventType: "interview.session.load",
      payload: {},
      requestId: "00000000-0000-4000-8000-000000000002"
    }
  }), env());
  const payload = await response.json();
  assert.equal(payload.error.code, -32602);
  assert.match(payload.error.message, /invalid_payload/);
});

test("protocol accepts the identity-bound payload needed to load an interview session", () => {
  assert.deepEqual(validateEnvelope({
    schemaVersion: "1.2",
    namespace: "interview",
    eventType: "interview.session.load",
    payload: { userId: "00000000-0000-4000-8000-000000000001", username: "Ada", sessionId: "MOCK-1" },
    requestId: "00000000-0000-4000-8000-000000000006"
  }).payload, { userId: "00000000-0000-4000-8000-000000000001", username: "Ada", sessionId: "MOCK-1" });
});

test("protocol rejects interview session events in another namespace", () => {
  assert.throws(() => validateEnvelope({
    schemaVersion: "1.2", namespace: "algorithm", eventType: "interview.session.list",
    payload: { userId: "00000000-0000-4000-8000-000000000001", username: "Ada" },
    requestId: "00000000-0000-4000-8000-000000000007"
  }), /invalid_event_type/);
});

test("protocol validates the concrete session event schema at the Worker boundary", () => {
  assert.throws(() => validateEnvelope({
    schemaVersion: "1.2", namespace: "interview", eventType: "interview.session.completed",
    payload: {
      userId: "00000000-0000-4000-8000-000000000001", username: "Ada",
      event: { schemaVersion: "1.2", eventType: "interview.review.completed" }
    },
    requestId: "00000000-0000-4000-8000-000000000009"
  }), /invalid_event/);
});

test("submit_event rejects unknown top-level envelope fields", async () => {
  const response = await handleRequest(request("tools/call", {
    name: "submit_event",
    arguments: {
      schemaVersion: "1.2",
      namespace: "system",
      eventType: "system.user-registered",
      payload: { displayName: "Ada" },
      requestId: "00000000-0000-4000-8000-000000000004",
      folderId: "drive-folder"
    }
  }), env());
  const payload = await response.json();
  assert.equal(payload.error.code, -32602);
  assert.match(payload.error.message, /invalid_envelope/);
});

for (const field of ["folderId", "path", "mimeType", "contentBase64", "markdown", "docx"]) {
  test(`submit_event rejects the ${field} payload control field`, async () => {
    const response = await handleRequest(request("tools/call", {
      name: "submit_event",
      arguments: {
        schemaVersion: "1.2",
        namespace: "system",
        eventType: "system.user-registered",
        payload: { displayName: "Ada", [field]: "untrusted-content" },
        requestId: "00000000-0000-4000-8000-000000000005"
      }
    }), env());
    const payload = await response.json();
    assert.equal(payload.error.code, -32602);
    assert.match(payload.error.message, /invalid_payload/);
  });
}

test("submit_event dispatches the validated envelope to its event handler", async () => {
  const response = await handleRequest(request("tools/call", {
    name: "submit_event",
    arguments: {
      schemaVersion: "1.2",
      namespace: "system",
      eventType: "system.user-registered",
      identity: { username: "Ada" },
      payload: { displayName: "Ada" },
      requestId: "00000000-0000-4000-8000-000000000003"
    }
  }), env(), {
    drive: algorithmDrive(),
    handlers: {
      "system.user-registered": async (_env, envelope) => ({ received: envelope })
    }
  });
  const payload = await response.json();
  const { received, identity } = JSON.parse(payload.result.content[0].text);
  assert.equal(received.namespace, "system");
  assert.equal(received.eventType, "system.user-registered");
  assert.equal(received.requestId, "00000000-0000-4000-8000-000000000003");
  assert.equal(received.payload.displayName, "Ada");
  assert.match(identity.userId, /^[0-9a-f-]{36}$/i);
  assert.equal(identity.username, "Ada");
  assert.equal(received.identity.userId, identity.userId);
  assert.equal(received.payload.userId, identity.userId);
  assert.equal(received.payload.username, "Ada");
});

test("algorithm learning events use the canonical algorithm events folder", async () => {
  const drive = algorithmDrive();
  const identity = { userId: "00000000-0000-4000-8000-000000000001", username: "算法用户" };
  const event = {
    schemaVersion: "1.2",
    eventId: "10000000-0000-4000-8000-000000000001",
    eventKey: `${identity.userId}:algorithm-learning:two-sum:2026-08-14T10:00:00.000Z`,
    eventType: "algorithm.learning.completed",
    userId: identity.userId,
    username: identity.username,
    observedAt: "2026-08-14T10:00:00.000Z",
    source: "qa",
    topic: "two-sum",
    problem: { title: "Two Sum", source: "Hot100", url: "" },
    outcome: "consulted",
    evidence: "用户请求讲解两数之和。",
    tags: ["hash-map"],
    confidence: "medium"
  };
  const response = await handleRequest(request("tools/call", {
    name: "submit_event",
    arguments: {
      schemaVersion: "1.2",
      namespace: "algorithm",
      eventType: "algorithm.learning.completed",
      identity,
      payload: { event },
      requestId: "00000000-0000-4000-8000-000000000008"
    }
  }), env(), { drive });
  const payload = await response.json();
  assert.equal(payload.result.content[0].type, "text");
  const result = JSON.parse(payload.result.content[0].text);
  assert.equal(result.status, "ok");
  assert.match(result.receipt.fileId, /^file-/);
  const algorithmEventsFile = drive.createdJsonFiles.find((file) => file.name === `event-${event.eventId}.json`);
  assert.ok(algorithmEventsFile);
  assert.deepEqual(ancestryOf(drive, algorithmEventsFile), [
    "my-chatGPT-skills", "users", identity.userId, "algorithm", "events", `event-${event.eventId}.json`
  ]);
  assert.equal(result.event.eventType, "algorithm.learning.completed");

  // No namespace-scoped registry or users folder may be created any more.
  const namespaceScoped = [...drive.folders.values()]
    .filter((folder) => folder.parents?.length === 1 && folder.parents[0] === "root"
      && ["algorithm", "interview"].includes(folder.name));
  assert.deepEqual(namespaceScoped, []);
});

test("protocol accepts the system and resume-knowledge namespaces", () => {
  assert.ok(ALLOWED_NAMESPACES.has("system"));
  assert.ok(ALLOWED_NAMESPACES.has("resume-knowledge"));
  assert.throws(() => validateEnvelope({
    schemaVersion: "1.2",
    namespace: "resume-knowledge",
    eventType: "resume-knowledge.question-bank-created",
    payload: {},
    requestId: "00000000-0000-4000-8000-00000000000a"
  }), /invalid_payload/);
});

test("protocol supports explicit registration through the system namespace", () => {
  const envelope = validateEnvelope({
    schemaVersion: "1.2",
    namespace: "system",
    eventType: "system.user-registered",
    payload: { displayName: "乔炳源" },
    requestId: "register-1"
  });
  assert.equal(envelope.payload.displayName, "乔炳源");
});

test("registration is idempotent and shares one userId across domains", async () => {
  const drive = algorithmDrive();
  const registered = await submit(drive, {
    schemaVersion: "1.2",
    namespace: "system",
    eventType: "system.user-registered",
    payload: { displayName: " 乔炳源 " },
    requestId: "00000000-0000-4000-8000-00000000000b"
  });
  assert.equal(registered.identity.username, "乔炳源");
  const userId = registered.identity.userId;

  const repeated = await submit(drive, {
    schemaVersion: "1.2",
    namespace: "system",
    eventType: "system.user-registered",
    payload: { displayName: "乔炳源" },
    requestId: "00000000-0000-4000-8000-00000000000c"
  });
  assert.equal(repeated.identity.userId, userId);

  const algorithmResult = await submit(drive, {
    schemaVersion: "1.2",
    namespace: "algorithm",
    eventType: "algorithm.learning.completed",
    identity: { username: "乔炳源" },
    payload: { event: learningEvent(userId, "乔炳源") },
    requestId: "00000000-0000-4000-8000-00000000000d"
  });
  assert.equal(algorithmResult.identity.userId, userId);
  assert.equal(algorithmResult.identity.username, "乔炳源");
});

test("an unknown display name is registered by the first business event", async () => {
  const drive = algorithmDrive();
  const result = await submit(drive, {
    schemaVersion: "1.2",
    namespace: "algorithm",
    eventType: "algorithm.learning.completed",
    identity: { username: " 新用户 " },
    payload: { event: learningEvent("00000000-0000-4000-8000-000000000009", "新用户") },
    requestId: "00000000-0000-4000-8000-00000000000e"
  });
  assert.match(result.identity.userId, /^[0-9a-f-]{36}$/i);
  assert.equal(result.identity.username, "新用户");
  assert.equal(result.event.userId, result.identity.userId);
  assert.equal(result.event.username, "新用户");
});

test("a display name that contradicts the supplied userId is rejected", async () => {
  const drive = algorithmDrive();
  await submit(drive, {
    schemaVersion: "1.2",
    namespace: "system",
    eventType: "system.user-registered",
    payload: { displayName: "乔炳源" },
    requestId: "00000000-0000-4000-8000-00000000000f"
  });
  const response = await handleRequest(request("tools/call", {
    name: "submit_event",
    arguments: {
      schemaVersion: "1.2",
      namespace: "system",
      eventType: "system.user-registered",
      payload: { displayName: "乔炳源", userId: "11111111-1111-4111-8111-111111111111" },
      requestId: "00000000-0000-4000-8000-000000000010"
    }
  }), env(), { drive });
  const body = await response.json();
  assert.equal(body.error.code, -32602);
  assert.match(body.error.message, /identity_mismatch/);
});

test("a missing display name is rejected before any write", async () => {
  const drive = algorithmDrive();
  const response = await handleRequest(request("tools/call", {
    name: "submit_event",
    arguments: {
      schemaVersion: "1.2",
      namespace: "system",
      eventType: "system.user-registered",
      payload: { displayName: "   " },
      requestId: "00000000-0000-4000-8000-000000000011"
    }
  }), env(), { drive });
  const body = await response.json();
  assert.equal(body.error.code, -32602);
  assert.match(body.error.message, /invalid_display_name|invalid_payload/);
  assert.equal(drive.createdJsonFiles.length, 0);
});

// ---------------------------------------------------------------------------
// Generic profile protocol surface
// ---------------------------------------------------------------------------

const PROFILE_USER_ID = "11111111-1111-4111-8111-111111111111";

function profileEvidenceEvent(overrides = {}) {
  return {
    schemaVersion: "1.0",
    eventId: "11111111-1111-4111-8111-111111111111",
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
      sourceRef: "conversation:2026-09-01:turn-18"
    }],
    ...overrides
  };
}

const GENERIC_EVENT_ENVELOPES = [
  ["system.capabilities.read", {
    schemaVersion: "1.2", namespace: "system", eventType: "system.capabilities.read",
    requestId: "capabilities-1"
  }],
  ["system.user.resolve", {
    schemaVersion: "1.2", namespace: "system", eventType: "system.user.resolve",
    payload: { displayName: "乔炳源" },
    requestId: "resolve-1"
  }],
  ["profile.evidence.recorded", {
    schemaVersion: "1.2", namespace: "profile", eventType: "profile.evidence.recorded",
    payload: { domain: "english-learning", event: profileEvidenceEvent() },
    requestId: "evidence-1"
  }],
  ["profile.snapshot.read", {
    schemaVersion: "1.2", namespace: "profile", eventType: "profile.snapshot.read",
    payload: { domain: "english-learning" },
    requestId: "read-1"
  }],
  ["system.user-registered", {
    schemaVersion: "1.2", namespace: "system", eventType: "system.user-registered",
    payload: { displayName: "乔炳源" },
    requestId: "register-2"
  }]
];

for (const [label, envelope] of GENERIC_EVENT_ENVELOPES) {
  test(`protocol accepts the logical event ${label}`, () => {
    const validated = validateEnvelope(envelope);
    assert.equal(validated.eventType, label);
    assert.deepEqual(validated.payload, envelope.payload);
  });
}

test("protocol exposes the profile namespace alongside the specialized ones", () => {
  assert.ok(ALLOWED_NAMESPACES.has("profile"));
  assert.ok(ALLOWED_NAMESPACES.has("system"));
  assert.ok(ALLOWED_NAMESPACES.has("algorithm"));
  assert.ok(ALLOWED_NAMESPACES.has("interview"));
  assert.ok(ALLOWED_NAMESPACES.has("resume-knowledge"));
});

test("profile events outside the profile namespace are rejected", () => {
  assert.throws(() => validateEnvelope({
    schemaVersion: "1.2", namespace: "system", eventType: "profile.snapshot.read",
    payload: { domain: "english-learning" },
    requestId: "mismatch-1"
  }), /invalid_event_type/);
  assert.throws(() => validateEnvelope({
    schemaVersion: "1.2", namespace: "profile", eventType: "system.user-registered",
    payload: { displayName: "乔炳源" },
    requestId: "mismatch-2"
  }), /invalid_event_type/);
});

test("profile read events require a domain payload and reject extra payload fields", () => {
  assert.throws(() => validateEnvelope({
    schemaVersion: "1.2", namespace: "profile", eventType: "profile.snapshot.read",
    payload: {},
    requestId: "read-2"
  }), /invalid_payload/);
  assert.throws(() => validateEnvelope({
    schemaVersion: "1.2", namespace: "profile", eventType: "profile.snapshot.read",
    payload: { domain: "english-learning", path: "../escape" },
    requestId: "read-3"
  }), /invalid_payload/);
});

test("system.user.resolve requires a non-empty displayName and nothing else", () => {
  assert.throws(() => validateEnvelope({
    schemaVersion: "1.2", namespace: "system", eventType: "system.user.resolve",
    payload: { displayName: "  " },
    requestId: "resolve-2"
  }), /invalid_payload/);
  assert.throws(() => validateEnvelope({
    schemaVersion: "1.2", namespace: "system", eventType: "system.user.resolve",
    payload: { displayName: "乔炳源", userId: PROFILE_USER_ID },
    requestId: "resolve-3"
  }), /invalid_payload/);
});

test("system.capabilities.read tolerates an empty payload but no payload fields", () => {
  validateEnvelope({
    schemaVersion: "1.2", namespace: "system", eventType: "system.capabilities.read",
    payload: {},
    requestId: "capabilities-2"
  });
  assert.throws(() => validateEnvelope({
    schemaVersion: "1.2", namespace: "system", eventType: "system.capabilities.read",
    payload: { domain: "english-learning" },
    requestId: "capabilities-3"
  }), /invalid_payload/);
});

for (const domain of ["algorithm", "interview", "resume-knowledge", "system", "profile", "English-Learning", "../interview", "english%2flearning", "a", "a".repeat(65), "english_learning"]) {
  test(`protocol rejects the invalid profile domain ${JSON.stringify(domain)}`, () => {
    assert.throws(() => validateEnvelope({
      schemaVersion: "1.2", namespace: "profile", eventType: "profile.snapshot.read",
      payload: { domain },
      requestId: "domain-1"
    }), /invalid_domain/);
    assert.throws(() => validateEnvelope({
      schemaVersion: "1.2", namespace: "profile", eventType: "profile.evidence.recorded",
      payload: { domain, event: profileEvidenceEvent() },
      requestId: "domain-2"
    }), /invalid_domain/);
  });
}

test("profile.evidence.recorded requires both domain and the inner event", () => {
  assert.throws(() => validateEnvelope({
    schemaVersion: "1.2", namespace: "profile", eventType: "profile.evidence.recorded",
    payload: { event: profileEvidenceEvent() },
    requestId: "evidence-2"
  }), /invalid_payload/);
  assert.throws(() => validateEnvelope({
    schemaVersion: "1.2", namespace: "profile", eventType: "profile.evidence.recorded",
    payload: { domain: "english-learning" },
    requestId: "evidence-3"
  }), /invalid_payload/);
});

test("the inner profile event is validated at the protocol boundary", () => {
  assert.throws(() => validateEnvelope({
    schemaVersion: "1.2", namespace: "profile", eventType: "profile.evidence.recorded",
    payload: { domain: "english-learning", event: profileEvidenceEvent({ action: "explode" }) },
    requestId: "inner-1"
  }), /invalid_profile_event/);
  assert.throws(() => validateEnvelope({
    schemaVersion: "1.2", namespace: "profile", eventType: "profile.evidence.recorded",
    payload: { domain: "english-learning", event: profileEvidenceEvent({ eventId: "not-a-uuid" }) },
    requestId: "inner-2"
  }), /invalid_profile_event/);
  assert.throws(() => validateEnvelope({
    schemaVersion: "1.2", namespace: "profile", eventType: "profile.evidence.recorded",
    payload: { domain: "english-learning", event: profileEvidenceEvent({ observedAt: "2026-09-01 10:00:00" }) },
    requestId: "inner-3"
  }), /invalid_profile_event/);
});

test("caller-supplied identity inside the inner profile event is rejected at the boundary", () => {
  assert.throws(() => validateEnvelope({
    schemaVersion: "1.2", namespace: "profile", eventType: "profile.evidence.recorded",
    payload: {
      domain: "english-learning",
      event: profileEvidenceEvent({ userId: PROFILE_USER_ID, username: "乔炳源", domain: "english-learning" })
    },
    requestId: "inner-4"
  }), /invalid_profile_event/);
});

test("unknown fields on the inner profile event are rejected", () => {
  assert.throws(() => validateEnvelope({
    schemaVersion: "1.2", namespace: "profile", eventType: "profile.evidence.recorded",
    payload: { domain: "english-learning", event: profileEvidenceEvent({ extra: true }) },
    requestId: "inner-5"
  }), /invalid_profile_event/);
  assert.throws(() => validateEnvelope({
    schemaVersion: "1.2", namespace: "profile", eventType: "profile.evidence.recorded",
    payload: {
      domain: "english-learning",
      event: profileEvidenceEvent({
        observations: [{
          dimensionKey: "vocabulary",
          subjectKey: "concurrency",
          outcome: "stuck",
          evidence: "用户无法解释 concurrency 的含义。",
          confidence: "high",
          sourceRef: "conversation:2026-09-01:turn-18",
          fileId: "drive-file-id"
        }]
      })
    },
    requestId: "inner-6"
  }), /invalid_profile_event/);
});

for (const [label, event] of [
  ["observe with a targetEventKey", profileEvidenceEvent({ targetEventKey: "english-learning:vocabulary:concurrency:2026-09-01:1" })],
  ["observe without observations", profileEvidenceEvent({ observations: [] })],
  ["supersede without observations", profileEvidenceEvent({ action: "supersede", targetEventKey: "english-learning:vocabulary:concurrency:2026-09-01:1", observations: [] })],
  ["supersede without a target", profileEvidenceEvent({ action: "supersede", targetEventKey: "  " })],
  ["invalidate with observations", profileEvidenceEvent({ action: "invalidate", targetEventKey: "english-learning:vocabulary:concurrency:2026-09-01:1" })]
]) {
  test(`protocol rejects the invalid profile action shape: ${label}`, () => {
    assert.throws(() => validateEnvelope({
      schemaVersion: "1.2", namespace: "profile", eventType: "profile.evidence.recorded",
      payload: { domain: "english-learning", event },
      requestId: "action-1"
    }), /invalid_profile_event/);
  });
}

test("every allowed profile outcome and confidence passes the boundary", () => {
  for (const outcome of ["observed", "consulted", "stuck", "incorrect", "partial", "completed", "correct", "passed", "failed"]) {
    for (const confidence of ["high", "medium", "low"]) {
      validateEnvelope({
        schemaVersion: "1.2", namespace: "profile", eventType: "profile.evidence.recorded",
        payload: {
          domain: "english-learning",
          event: profileEvidenceEvent({
            observations: [{
              dimensionKey: "vocabulary",
              subjectKey: "concurrency",
              outcome,
              evidence: "用户无法解释 concurrency 的含义。",
              confidence,
              sourceRef: "conversation:2026-09-01:turn-18"
            }]
          })
        },
        requestId: `outcome-${outcome}-${confidence}`
      });
    }
  }
});

test("old valid envelopes survive inspectEnvelope cloning byte-for-byte", () => {
  const algorithmEnvelope = {
    schemaVersion: "1.2",
    namespace: "algorithm",
    eventType: "algorithm.learning.completed",
    identity: { username: "算法用户" },
    payload: { event: learningEvent("00000000-0000-4000-8000-000000000001", "算法用户") },
    requestId: "clone-1"
  };
  assert.deepEqual(inspectEnvelope(algorithmEnvelope), algorithmEnvelope);
  const interviewEnvelope = {
    schemaVersion: "1.2",
    namespace: "interview",
    eventType: "interview.session.load",
    payload: { userId: "00000000-0000-4000-8000-000000000001", username: "Ada", sessionId: "MOCK-1" },
    requestId: "clone-2"
  };
  assert.deepEqual(inspectEnvelope(interviewEnvelope), interviewEnvelope);
  const registrationEnvelope = {
    schemaVersion: "1.2",
    namespace: "system",
    eventType: "system.user-registered",
    payload: { displayName: "乔炳源" },
    requestId: "clone-3"
  };
  assert.deepEqual(inspectEnvelope(registrationEnvelope), registrationEnvelope);
});
