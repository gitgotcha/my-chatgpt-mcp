import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deriveWorkerUrl, handleRequest } from "../stdio-bridge.mjs";

const bridgePath = fileURLToPath(new URL("../stdio-bridge.mjs", import.meta.url));

const CLEANUP = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 50
};

const initializeRequest = (id) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } }
});

const submitCall = (id, requestId) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: {
    name: "submit_event",
    arguments: {
      schemaVersion: "1.2",
      namespace: "system",
      eventType: "system.user-registered",
      identity: { username: "乔炳源" },
      payload: { displayName: "乔炳源" },
      requestId
    }
  }
});

function initializeBridgeWithEnvironment(environmentOverrides = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.RELIABLE_DRIVE_SYNC_WORKER_URL;
    delete env.RELIABLE_DRIVE_SYNC_INGRESS_URL;
    delete env.RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET;
    Object.assign(env, environmentOverrides);
    const child = spawn(process.execPath, [bridgePath], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`bridge initialization timed out; stderr=${stderr}`));
    }, 3000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const lineEnd = stdout.indexOf("\n");
      if (lineEnd === -1) return;
      clearTimeout(timeout);
      child.kill();
      resolve({ response: JSON.parse(stdout.slice(0, lineEnd)), stderr });
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (code) => {
      if (!stdout) {
        clearTimeout(timeout);
        reject(new Error(`bridge exited before initialization (code=${code}); stderr=${stderr}`));
      }
    });
    child.stdin.end(`${JSON.stringify(initializeRequest(99))}\n`);
  });
}

// Runs the real bridge process and resolves once it has exited, so any SQLite
// file it opened is released before the test inspects or deletes it.
function runBridge(requests, environmentOverrides = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const key of [
      "RELIABLE_DRIVE_SYNC_WORKER_URL",
      "RELIABLE_DRIVE_SYNC_INGRESS_URL",
      "RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET",
      "RELIABLE_DRIVE_SYNC_OUTBOX_PATH"
    ]) delete env[key];
    Object.assign(env, environmentOverrides);
    const child = spawn(process.execPath, [bridgePath], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`bridge timed out; stderr=${stderr}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const lines = stdout.split("\n").filter(Boolean);
      if (lines.length >= requests.length && !settled) child.kill();
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const lines = stdout.split("\n").filter(Boolean);
      if (lines.length < requests.length) {
        reject(new Error(`bridge exited (code=${code}) after ${lines.length}/${requests.length} responses; stderr=${stderr}`));
        return;
      }
      resolve({ responses: lines.map((line) => JSON.parse(line)), stderr });
    });
    child.stdin.end(requests.map((request) => `${JSON.stringify(request)}\n`).join(""));
  });
}

test("derives Worker origin from the legacy ingress URL", () => {
  assert.equal(deriveWorkerUrl("https://reliable-drive-sync.qiaobingyuan886.workers.dev/v1/jobs"), "https://reliable-drive-sync.qiaobingyuan886.workers.dev");
});

test("tools/list exposes only submit_event", async () => {
  const response = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual(response.result.tools.map(({ name }) => name), ["submit_event"]);
  assert.equal(response.result.tools[0].inputSchema.additionalProperties, false);
  assert.deepEqual(response.result.tools[0].inputSchema.properties.identity.required, ["username"]);
  assert.equal(response.result.tools[0].inputSchema.properties.identity.properties.userId.type, "string");
});

test("the MCP server initializes before delivery configuration is available", async () => {
  const { response, stderr } = await initializeBridgeWithEnvironment();
  assert.equal(response.id, 99);
  assert.equal(response.result.serverInfo.name, "reliable-drive-sync");
  assert.equal(stderr, "");
});

test("an invalid Worker URL does not prevent MCP initialization", async () => {
  const { response, stderr } = await initializeBridgeWithEnvironment({
    RELIABLE_DRIVE_SYNC_INGRESS_URL: "[https://worker.example](https://worker.example)",
    RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET: "secret"
  });
  assert.equal(response.id, 99);
  assert.equal(stderr, "");
});

// The two cases above only prove the Outbox stays unloaded while configuration
// is unusable. This one proves it stays unloaded even with a usable config:
// `node:sqlite` warns on load, so any stderr at startup would be a regression.
test("a usable configuration still initializes without loading the local Outbox", async () => {
  const { responses, stderr } = await runBridge([initializeRequest(99)], {
    RELIABLE_DRIVE_SYNC_WORKER_URL: "https://127.0.0.1:1/v1/jobs",
    RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET: "secret"
  });
  assert.equal(responses[0].result.serverInfo.name, "reliable-drive-sync");
  assert.equal(stderr, "");
});

test("an invalid Worker URL fails only when submit_event is called", async () => {
  const response = await handleRequest({
    jsonrpc: "2.0",
    id: 101,
    method: "tools/call",
    params: { name: "submit_event", arguments: {} }
  }, { workerUrl: "[https://worker.example](https://worker.example)", token: "secret" });
  assert.equal(response.error.code, -32603);
  assert.match(response.error.message, /Worker URL is invalid/);
});

test("submit_event reports incomplete delivery configuration after initialization", async () => {
  const response = await handleRequest({
    jsonrpc: "2.0",
    id: 100,
    method: "tools/call",
    params: { name: "submit_event", arguments: {} }
  });
  assert.equal(response.error.code, -32603);
  assert.match(response.error.message, /configuration is incomplete/i);
});

// The bridge is a pass-through for one tool only. Removed candidate and
// namespace-identity tools must never become routable again.
test("every tool except submit_event is rejected", async () => {
  for (const name of ["list_candidates", "find_or_create_candidate", "submit_session", "submit_review"]) {
    const response = await handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: {} } });
    assert.equal(response.error.code, -32601, `${name} must not be routable`);
  }
});

test("submit_event returns the local/cloud Outbox receipt from the delivery service", async () => {
  let submitted;
  const service = {
    async submit(value) {
      submitted = value;
      return {
        status: "queued",
        accepted: true,
        deliveryState: "cloud_accepted",
        requestId: value.requestId,
        persistence: { localOutbox: "acknowledged", cloudOutbox: "accepted", drive: "pending" }
      };
    }
  };
  const payload = { displayName: "乔炳源" };
  const response = await handleRequest({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: {
      name: "submit_event",
      arguments: {
        schemaVersion: "1.2",
        namespace: "system",
        eventType: "system.user-registered",
        identity: { username: "乔炳源" },
        payload,
        requestId: "req-1"
      }
    }
  }, { service });
  const receipt = JSON.parse(response.result.content[0].text);
  assert.equal(receipt.deliveryState, "cloud_accepted");
  assert.equal(receipt.persistence.drive, "pending");
  assert.deepEqual(submitted.payload, payload);
});

test("submit_event hands a canonical business envelope to the local delivery service unchanged", async () => {
  let submitted;
  const service = { async submit(value) { submitted = value; return { deliveryState: "pending" }; } };
  const payload = {
    event: {
      schemaVersion: "1.2",
      eventId: "11111111-1111-4111-8111-111111111111",
      eventKey: "user:algorithm:two-sum:2026-08-14T10:00:00.000Z",
      eventType: "algorithm.learning.completed",
      userId: "11111111-2222-4333-8444-555555555555",
      username: "乔炳源",
      observedAt: "2026-08-14T10:00:00.000Z",
      source: "qa",
      topic: "two-sum",
      problem: { title: "Two Sum", source: "Hot100", url: "" },
      outcome: "solved"
    }
  };
  await handleRequest({
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: {
      name: "submit_event",
      arguments: {
        schemaVersion: "1.2",
        namespace: "algorithm",
        eventType: "algorithm.learning.completed",
        identity: { username: "乔炳源" },
        payload,
        requestId: "req-2"
      }
    }
  }, { service });
  assert.equal(submitted.namespace, "algorithm");
  assert.equal(submitted.eventType, "algorithm.learning.completed");
  assert.deepEqual(submitted.payload, payload);
});

test("notifications do not produce a response", async () => {
  assert.equal(await handleRequest({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
});

test("submit_event lazily loads the local Outbox and keeps concurrent calls durable", async (t) => {
  const { LocalOutbox } = await import("../local-outbox.mjs");
  const outbox = new LocalOutbox(":memory:");
  t.after(() => outbox.close());
  const options = { workerUrl: "https://127.0.0.1:1/v1/jobs", token: "secret", outbox };
  const responses = await Promise.all(
    ["req-a", "req-b"].map((requestId, index) => handleRequest(submitCall(index + 1, requestId), options))
  );
  assert.deepEqual(
    responses.map((response) => response.result.structuredContent.deliveryState),
    ["pending", "pending"]
  );
  assert.deepEqual(
    responses.map((response) => response.result.structuredContent.requestId).sort(),
    ["req-a", "req-b"]
  );
  assert.equal(outbox.listPending().length, 2);
});

test("a failed submit_event does not prevent a later successful one", async () => {
  const failing = { async submit() { throw new Error("ingress_transport_error"); } };
  const working = { async submit(value) { return { deliveryState: "cloud_accepted", requestId: value.requestId }; } };

  const failed = await handleRequest(submitCall(1, "req-a"), { service: failing });
  assert.equal(failed.error.code, -32603);
  assert.match(failed.error.message, /ingress_transport_error/);

  const retried = await handleRequest(submitCall(2, "req-b"), { service: working });
  assert.equal(retried.result.structuredContent.deliveryState, "cloud_accepted");
  assert.equal(retried.result.structuredContent.requestId, "req-b");
});

test("concurrent submit_event calls in the real bridge share one durable Outbox", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "reliable-drive-sync-bridge-"));
  const handles = [];
  t.after(async () => {
    for (const handle of handles.reverse()) handle.close();
    await rm(directory, CLEANUP);
  });
  const outboxPath = join(directory, "outbox.sqlite");

  const { responses, stderr } = await runBridge([
    initializeRequest(99),
    submitCall(1, "req-a"),
    submitCall(2, "req-b")
  ], {
    RELIABLE_DRIVE_SYNC_WORKER_URL: "https://127.0.0.1:1/v1/jobs",
    RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET: "secret",
    RELIABLE_DRIVE_SYNC_OUTBOX_PATH: outboxPath
  });

  assert.equal(responses[0].result.serverInfo.name, "reliable-drive-sync");
  assert.deepEqual(
    responses.slice(1).map((response) => response.result.structuredContent.deliveryState),
    ["pending", "pending"]
  );
  assert.deepEqual(
    responses.slice(1).map((response) => response.result.structuredContent.requestId).sort(),
    ["req-a", "req-b"]
  );
  // The Outbox is loaded lazily, so the experimental SQLite warning may only
  // appear once a submit_event call actually needs durable storage.
  assert.equal((stderr.match(/SQLite is an experimental feature/g) ?? []).length, 1);

  const { DatabaseSync } = await import("node:sqlite");
  const check = new DatabaseSync(outboxPath);
  handles.push(check);
  assert.equal(check.prepare("SELECT COUNT(*) AS total FROM local_outbox_events").get().total, 2);
});

test("the submit_event tool description advertises generic profile capability and read/write operations", async () => {
  const response = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const [tool] = response.result.tools;
  assert.equal(tool.name, "submit_event");
  assert.match(tool.description, /profile capabilit/);
  assert.match(tool.description, /read/i);
  assert.match(tool.description, /delivery/i);
});

test("calling a tool other than submit_event is rejected", async () => {
  const response = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_profile", arguments: {} } });
  assert.equal(response.error.code, -32601);
  assert.match(response.error.message, /Tool not implemented/);
});
