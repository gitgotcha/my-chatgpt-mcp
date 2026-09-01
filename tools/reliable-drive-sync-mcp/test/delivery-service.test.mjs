import assert from "node:assert/strict";
import test from "node:test";
import { DeliveryService } from "../delivery-service.mjs";
import { createWorker } from "../../../services/reliable-drive-sync-worker/src/index.js";
import { InMemoryJobRepository } from "../../../services/reliable-drive-sync-worker/src/job-repository.js";

const registration = (overrides = {}) => ({
  schemaVersion: "1.2",
  namespace: "system",
  eventType: "system.user-registered",
  identity: { username: "乔炳源" },
  payload: { displayName: "乔炳源" },
  requestId: "request-1",
  ...overrides
});

class MemoryOutbox {
  rows = new Map();
  identities = new Map();
  enqueue(value) { if (!this.rows.has(value.requestId)) this.rows.set(value.requestId, structuredClone(value)); }
  listPending() { return [...this.rows.values()].map((envelope) => ({ requestId: envelope.requestId, envelope })); }
  markSending() {}
  markPending() {}
  acknowledge(requestId, jobId) { return Boolean(jobId) && this.rows.delete(requestId); }
  findIdentity(username) { return this.identities.get(username.trim()) ?? null; }
  rememberIdentity(username, userId) {
    const identity = { username: username.trim(), userId };
    this.identities.set(identity.username, identity);
    return identity;
  }
}

test("a write is staged locally before /v1/jobs and cloud acceptance does not claim Drive completion", async () => {
  const outbox = new MemoryOutbox();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init, staged: outbox.rows.has("request-1") });
    if (url.includes("/v1/identity")) return Response.json({ error: "identity_not_found" }, { status: 404 });
    return Response.json({ jobId: "job-1", state: "dispatch_pending" }, { status: 202 });
  };
  const service = new DeliveryService({ outbox, workerUrl: "https://worker.example", token: "secret", fetchImpl });

  const result = await service.submit(registration());

  assert.equal(calls.at(-1).url, "https://worker.example/v1/jobs");
  assert.equal(calls.at(-1).staged, true);
  assert.equal(JSON.parse(calls.at(-1).init.body).identity.userId, result.identity.userId);
  assert.equal(Object.hasOwn(JSON.parse(calls.at(-1).init.body).identity, "verified"), false);
  assert.equal(result.identity.verified, true);
  assert.equal(result.accepted, true);
  assert.equal(result.deliveryState, "cloud_accepted");
  assert.deepEqual(result.persistence, {
    localOutbox: "acknowledged",
    cloudOutbox: "accepted",
    drive: "pending"
  });
  assert.equal(outbox.rows.size, 0);
});

test("the local delivery envelope is accepted by the real Worker ingress", async () => {
  const outbox = new MemoryOutbox();
  const repository = new InMemoryJobRepository(() => "job-real-ingress");
  const worker = createWorker({ MCP_BEARER_TOKEN: "secret" }, {
    repository,
    identityLookup: async () => null
  });
  const service = new DeliveryService({
    outbox,
    workerUrl: "https://worker.example",
    token: "secret",
    uuid: () => "11111111-1111-4111-8111-111111111111",
    fetchImpl: async (url, init = {}) => worker.fetch(new Request(url, init), {}, { waitUntil() {} })
  });

  const result = await service.submit(registration());

  assert.equal(result.deliveryState, "cloud_accepted");
  assert.equal((await repository.getJob("job-real-ingress")).state, "dispatch_pending");
  const stored = await repository.loadEnvelope("job-real-ingress");
  assert.equal(stored.identity.verified, undefined);
});

test("a transport failure leaves the event durable and reports pending", async () => {
  const outbox = new MemoryOutbox();
  const service = new DeliveryService({
    outbox,
    workerUrl: "https://worker.example",
    token: "secret",
    fetchImpl: async () => { throw new Error("offline"); }
  });

  const result = await service.submit(registration());

  assert.equal(result.accepted, false);
  assert.equal(result.deliveryState, "pending");
  assert.equal(result.persistence.localOutbox, "durable");
  assert.equal(outbox.rows.size, 1);
});

test("identity lookup failures are visible without exposing request details", async () => {
  const outbox = new MemoryOutbox();
  const service = new DeliveryService({
    outbox,
    workerUrl: "https://worker.example",
    token: "secret",
    fetchImpl: async () => { throw new Error("identity_dns_failed"); }
  });

  const result = await service.submit(registration({ requestId: "identity-failure" }));

  assert.equal(result.deliveryState, "pending");
  assert.equal(result.lastErrorCode, "identity_dns_failed");
});

test("a new user can submit when the optional identity lookup times out", async () => {
  const outbox = new MemoryOutbox();
  const service = new DeliveryService({
    outbox,
    workerUrl: "https://worker.example",
    token: "secret",
    timeoutMs: 5,
    uuid: () => "11111111-1111-4111-8111-111111111111",
    fetchImpl: async (url) => url.includes("/v1/identity")
      ? new Promise(() => {})
      : Response.json({ jobId: "job-after-lookup-timeout" }, { status: 202 })
  });

  const result = await service.submit(registration({ requestId: "lookup-timeout" }));

  assert.equal(result.deliveryState, "cloud_accepted");
  assert.equal(result.identity.userId, "11111111-1111-4111-8111-111111111111");
});

test("a hung network call respects the local deadline and leaves the event durable", async () => {
  const outbox = new MemoryOutbox();
  const service = new DeliveryService({
    outbox,
    workerUrl: "https://worker.example",
    token: "secret",
    timeoutMs: 5,
    fetchImpl: async () => new Promise(() => {})
  });

  const result = await Promise.race([
    service.submit(registration()),
    new Promise((_, reject) => setTimeout(() => reject(new Error("deadline_not_enforced")), 100))
  ]);

  assert.equal(result.deliveryState, "pending");
  assert.equal(outbox.rows.size, 1);
});

test("a cached identity permits offline queueing without inventing a second userId", async () => {
  const outbox = new MemoryOutbox();
  outbox.rememberIdentity("乔炳源", "11111111-1111-4111-8111-111111111111");
  const service = new DeliveryService({
    outbox,
    workerUrl: "https://worker.example",
    token: "secret",
    fetchImpl: async () => { throw new Error("offline"); }
  });

  const result = await service.submit(registration());
  const staged = outbox.rows.get("request-1");
  assert.equal(result.identity.userId, "11111111-1111-4111-8111-111111111111");
  assert.equal(staged.identity.userId, "11111111-1111-4111-8111-111111111111");
});

test("an explicit identity mismatch is permanent and never remains retryable", async () => {
  const outbox = new MemoryOutbox();
  outbox.blocked = new Set();
  outbox.markBlocked = (requestId) => outbox.blocked.add(requestId);
  const service = new DeliveryService({
    outbox,
    workerUrl: "https://worker.example",
    token: "secret",
    fetchImpl: async (url) => url.includes("/v1/identity")
      ? Response.json({ error: "identity_mismatch" }, { status: 409 })
      : Response.json({}, { status: 500 })
  });

  await assert.rejects(service.submit(registration({ identity: {
    username: "乔炳源", userId: "22222222-2222-4222-8222-222222222222"
  }})), /identity_mismatch/);
  assert.deepEqual([...outbox.blocked], ["request-1"]);
});

test("read-only events bypass the Outbox and use /v1/query", async () => {
  const outbox = new MemoryOutbox();
  outbox.rememberIdentity("乔炳源", "11111111-1111-4111-8111-111111111111");
  let request;
  const service = new DeliveryService({
    outbox,
    workerUrl: "https://worker.example",
    token: "secret",
    fetchImpl: async (url, init) => {
      request = { url, init };
      return Response.json({ status: "ok", data: { sessions: [] } });
    }
  });
  const result = await service.submit(registration({
    namespace: "interview",
    eventType: "interview.session.list",
    payload: {},
    requestId: "query-1"
  }));

  assert.equal(request.url, "https://worker.example/v1/query");
  assert.deepEqual(result, { status: "ok", data: { sessions: [] } });
  assert.equal(outbox.rows.size, 0);
});
