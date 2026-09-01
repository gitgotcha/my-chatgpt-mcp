import assert from "node:assert/strict";
import test from "node:test";
import { deriveWorkerUrl, handleRequest } from "../stdio-bridge.mjs";

test("derives Worker origin from the legacy ingress URL", () => {
  assert.equal(deriveWorkerUrl("https://reliable-drive-sync.qiaobingyuan886.workers.dev/v1/jobs"), "https://reliable-drive-sync.qiaobingyuan886.workers.dev");
});

test("tools/list exposes only submit_event", async () => {
  const response = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual(response.result.tools.map(({ name }) => name), ["submit_event"]);
  assert.equal(response.result.tools[0].inputSchema.additionalProperties, false);
});

// The bridge is a pass-through for one tool only. Removed candidate and
// namespace-identity tools must never become routable again.
test("every tool except submit_event is rejected", async () => {
  for (const name of ["list_candidates", "find_or_create_candidate", "submit_session", "submit_review"]) {
    const response = await handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: {} } });
    assert.equal(response.error.code, -32601, `${name} must not be routable`);
  }
});

test("submit_event forwards a registration envelope with bearer authentication", async () => {
  let request;
  const fetchImpl = async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "ok" }] } }), { status: 200 });
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
  }, { workerUrl: "https://worker.example", token: "secret", fetchImpl });
  assert.equal(response.result.content[0].text, "ok");
  assert.equal(request.url, "https://worker.example");
  assert.equal(request.init.headers.authorization, "Bearer secret");
  assert.deepEqual(JSON.parse(request.init.body).params.arguments.payload, payload);
});

test("submit_event forwards a canonical business event unchanged", async () => {
  let request;
  const fetchImpl = async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 4, result: { content: [{ type: "text", text: "ok" }] } }), { status: 200 });
  };
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
  }, { workerUrl: "https://worker.example", token: "secret", fetchImpl });
  const forwarded = JSON.parse(request.init.body).params.arguments;
  assert.equal(forwarded.namespace, "algorithm");
  assert.equal(forwarded.eventType, "algorithm.learning.completed");
  assert.deepEqual(forwarded.payload, payload);
});

test("notifications do not produce a response", async () => {
  assert.equal(await handleRequest({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
});
