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

// ---------------------------------------------------------------------------
// Generic profile read routing and explicit identity writes
// ---------------------------------------------------------------------------

const PROFILE_USER_ID = "11111111-1111-4111-8111-111111111111";

function profileEvidence(overrides = {}) {
  return {
    schemaVersion: "1.2",
    namespace: "profile",
    eventType: "profile.evidence.recorded",
    identity: { username: "乔炳源", userId: PROFILE_USER_ID },
    payload: {
      domain: "english-learning",
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
    requestId: "profile-1",
    ...overrides
  };
}

function identityFetch(statusCode, body) {
  return async (url) => {
    if (url.includes("/v1/identity")) return Response.json(body, { status: statusCode });
    return Response.json({ jobId: "job-profile", state: "dispatch_pending" }, { status: 202 });
  };
}

for (const [label, envelope] of [
  ["capabilities.read", { schemaVersion: "1.2", namespace: "system", eventType: "system.capabilities.read", requestId: "cap-1" }],
  ["user.resolve", { schemaVersion: "1.2", namespace: "system", eventType: "system.user.resolve", payload: { displayName: "乔炳源" }, requestId: "resolve-1" }],
  ["profile.snapshot.read", { schemaVersion: "1.2", namespace: "profile", eventType: "profile.snapshot.read", identity: { username: "乔炳源", userId: PROFILE_USER_ID }, payload: { domain: "english-learning" }, requestId: "read-1" }]
]) {
  test(`the generic read ${label} flows to /v1/query without enqueueing`, async () => {
    const outbox = new MemoryOutbox();
    let request;
    const service = new DeliveryService({
      outbox,
      workerUrl: "https://worker.example",
      token: "secret",
      fetchImpl: async (url, init) => {
        request = { url, init };
        return Response.json({ status: "ok", data: { marker: label } });
      }
    });
    const result = await service.submit(envelope);
    assert.equal(request.url, "https://worker.example/v1/query");
    assert.deepEqual(result, { status: "ok", data: { marker: label } });
    assert.equal(outbox.rows.size, 0);
  });
}

test("capability read works without identity or displayName", async () => {
  const outbox = new MemoryOutbox();
  const service = new DeliveryService({
    outbox,
    workerUrl: "https://worker.example",
    token: "secret",
    fetchImpl: async () => Response.json({ status: "ok", data: { genericProfile: { enabled: true } } })
  });
  const result = await service.submit({ schemaVersion: "1.2", namespace: "system", eventType: "system.capabilities.read", requestId: "cap-alone" });
  assert.equal(result.status, "ok");
  assert.equal(outbox.rows.size, 0);
});

test("a profile write enters the durable Outbox and reports cloud_accepted with bound identity", async () => {
  const outbox = new MemoryOutbox();
  let jobsBody;
  const service = new DeliveryService({
    outbox,
    workerUrl: "https://worker.example",
    token: "secret",
    fetchImpl: async (url, init) => {
      if (url.includes("/v1/identity")) return Response.json({ identity: { userId: PROFILE_USER_ID, username: "乔炳源", verified: true } });
      jobsBody = JSON.parse(init.body);
      return Response.json({ jobId: "job-profile", state: "dispatch_pending" }, { status: 202 });
    }
  });
  const result = await service.submit(profileEvidence());
  assert.equal(result.accepted, true);
  assert.equal(result.deliveryState, "cloud_accepted");
  assert.equal(result.identity.userId, PROFILE_USER_ID);
  assert.equal(jobsBody.identity.userId, PROFILE_USER_ID);
  assert.equal(jobsBody.payload.event.userId, PROFILE_USER_ID);
  assert.equal(jobsBody.payload.event.username, "乔炳源");
  assert.equal(jobsBody.payload.event.domain, "english-learning");
  assert.equal(outbox.rows.size, 0);
});

test("a malformed profile event is rejected before enqueue", async () => {
  const outbox = new MemoryOutbox();
  const service = new DeliveryService({ outbox, workerUrl: "https://worker.example", token: "secret", fetchImpl: identityFetch(200, { identity: { userId: PROFILE_USER_ID, username: "乔炳源" } }) });
  await assert.rejects(service.submit(profileEvidence({
    payload: { ...profileEvidence().payload, event: { ...profileEvidence().payload.event, action: "explode" } }
  })), /invalid_profile_event/);
  assert.equal(outbox.rows.size, 0);
});

test("an invalid profile domain is rejected before enqueue", async () => {
  const outbox = new MemoryOutbox();
  const service = new DeliveryService({ outbox, workerUrl: "https://worker.example", token: "secret", fetchImpl: identityFetch(200, { identity: { userId: PROFILE_USER_ID, username: "乔炳源" } }) });
  await assert.rejects(service.submit(profileEvidence({
    payload: { ...profileEvidence().payload, domain: "algorithm" }
  })), /invalid_domain/);
  assert.equal(outbox.rows.size, 0);
});

test("a profile write for an unknown user returns identity_not_found before enqueue", async () => {
  const outbox = new MemoryOutbox();
  const service = new DeliveryService({ outbox, workerUrl: "https://worker.example", token: "secret", fetchImpl: identityFetch(404, { error: "identity_not_found" }) });
  await assert.rejects(service.submit(profileEvidence()), /identity_not_found/);
  assert.equal(outbox.rows.size, 0);
  assert.equal(outbox.identities.size, 0);
});

test("a profile write without explicit identity is rejected before enqueue", async () => {
  const outbox = new MemoryOutbox();
  const service = new DeliveryService({ outbox, workerUrl: "https://worker.example", token: "secret", fetchImpl: identityFetch(200, { identity: { userId: PROFILE_USER_ID, username: "乔炳源" } }) });
  await assert.rejects(service.submit(profileEvidence({ identity: undefined })), /invalid_identity/);
  assert.equal(outbox.rows.size, 0);
});

test("a cached identity disagreement on a profile write is permanent", async () => {
  const outbox = new MemoryOutbox();
  outbox.rememberIdentity("乔炳源", "22222222-2222-4222-8222-222222222222");
  const service = new DeliveryService({ outbox, workerUrl: "https://worker.example", token: "secret", fetchImpl: identityFetch(200, { identity: { userId: PROFILE_USER_ID, username: "乔炳源" } }) });
  await assert.rejects(service.submit(profileEvidence()), /identity_mismatch/);
  assert.equal(outbox.rows.size, 0);
});

test("a profile write transport failure stays durable and reports pending", async () => {
  const outbox = new MemoryOutbox();
  const service = new DeliveryService({
    outbox,
    workerUrl: "https://worker.example",
    token: "secret",
    fetchImpl: async (url) => {
      if (url.includes("/v1/identity")) return Response.json({ identity: { userId: PROFILE_USER_ID, username: "乔炳源" } });
      throw new Error("offline");
    }
  });
  const result = await service.submit(profileEvidence());
  assert.equal(result.deliveryState, "pending");
  assert.equal(outbox.rows.size, 1);
});
