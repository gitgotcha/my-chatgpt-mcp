import assert from "node:assert/strict";
import test from "node:test";
import worker, { handleRemoteRequest, handleRequest } from "../src/index.js";
import { validateEnvelope, ALLOWED_NAMESPACES } from "../src/protocol.js";

function env() {
  return {
    MCP_BEARER_TOKEN: "secret",
    MCP_URL_TOKEN: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG",
    GOOGLE_DRIVE_FOLDER_ID: "root"
  };
}

const REMOTE_TOKEN = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";

function remoteRequest(method, params, {
  token = REMOTE_TOKEN,
  httpMethod = "POST",
  id = 1,
  protocolVersion = "2025-03-26"
} = {}) {
  const init = {
    method: httpMethod,
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": protocolVersion
    }
  };
  if (httpMethod === "POST") {
    init.body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  }
  return new Request(`https://example.test/mcp/${token}`, init);
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

test("MCP exposes only submit_event", async () => {
  const response = await handleRequest(request("tools/list"), env());
  const payload = await response.json();
  assert.deepEqual(payload.result.tools.map((tool) => tool.name), ["submit_event"]);
  assert.equal(payload.result.tools[0].inputSchema.additionalProperties, false);
  assert.equal(payload.result.tools[0].inputSchema.properties.payload.type, "object");
  assert.deepEqual(payload.result.tools[0].inputSchema.properties.identity.required, ["username"]);
});

test("remote MCP initializes through its capability URL without bearer auth", async () => {
  const response = await worker.fetch(remoteRequest("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "chatgpt", version: "1" }
  }), env());
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.equal(payload.result.protocolVersion, "2025-03-26");
  assert.equal(payload.result.serverInfo.name, "reliable-drive-sync");
});

test("remote MCP exposes only submit_event", async () => {
  const response = await worker.fetch(remoteRequest("tools/list", {}), env());
  const payload = await response.json();
  assert.equal(response.headers.get("mcp-protocol-version"), "2025-03-26");
  assert.deepEqual(payload.result.tools.map((tool) => tool.name), ["submit_event"]);
  assert.deepEqual(payload.result.tools[0].inputSchema.properties.identity.required, ["username"]);
});

test("remote MCP hides the endpoint when the URL token is wrong or missing", async () => {
  const wrong = await worker.fetch(remoteRequest("tools/list", {}, { token: "wrong" }), env());
  const missing = await worker.fetch(remoteRequest("tools/list", {}), {
    MCP_BEARER_TOKEN: "secret",
    GOOGLE_DRIVE_FOLDER_ID: "root"
  });
  assert.equal(wrong.status, 404);
  assert.equal(missing.status, 404);
});

test("remote MCP rejects non-POST transport methods", async () => {
  const response = await worker.fetch(remoteRequest("tools/list", {}, { httpMethod: "GET" }), env());
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
});

test("remote MCP accepts notifications without returning JSON-RPC content", async () => {
  const response = await worker.fetch(remoteRequest("notifications/initialized", {}, { id: undefined }), env());
  assert.equal(response.status, 202);
  assert.equal(await response.text(), "");
});

test("remote MCP submit_event reuses the existing validated dispatcher", async () => {
  const drive = algorithmDrive();
  const response = await handleRemoteRequest(remoteRequest("tools/call", {
    name: "submit_event",
    arguments: {
      schemaVersion: "1.2",
      namespace: "system",
      eventType: "system.user-registered",
      identity: { username: "Ada" },
      payload: { displayName: "Ada" },
      requestId: "00000000-0000-4000-8000-000000000099"
    }
  }), env(), { drive });
  const payload = await response.json();
  const value = JSON.parse(payload.result.content[0].text);
  assert.equal(value.status, "ok");
  assert.equal(value.identity.username, "Ada");
});

test("MCP rejects an incorrect bearer token", async () => {
  const response = await handleRequest(request("tools/list", {}, "wrong"), env());
  assert.equal(response.status, 401);
});

test("MCP fails closed when the bearer secret is missing", async () => {
  const response = await handleRequest(request("tools/list", {}, "undefined"), {
    GOOGLE_DRIVE_FOLDER_ID: "root"
  });
  assert.equal(response.status, 401);
});

test("MCP rejects removed tools", async () => {
  const response = await handleRequest(request("tools/call", {
    name: "find_or_create_candidate",
    arguments: { displayName: "旧用户" }
  }), env());
  const payload = await response.json();
  assert.equal(payload.error.code, -32601);
});

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
