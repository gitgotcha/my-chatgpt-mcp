import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryJobRepository } from "../src/job-repository.js";
import { createIngressHandler } from "../src/ingress.js";

const secret = "test-bearer-secret";

function envelope(overrides = {}) {
  return {
    schemaVersion: "1.2",
    namespace: "system",
    eventType: "system.user-registered",
    identity: {
      username: "乔炳源",
      userId: "11111111-1111-4111-8111-111111111111"
    },
    payload: {
      displayName: "乔炳源",
      userId: "11111111-1111-4111-8111-111111111111",
      username: "乔炳源"
    },
    requestId: "request-registration-1",
    ...overrides
  };
}

function request(body, token = secret) {
  return new Request("https://worker.example/v1/jobs", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

function fixture() {
  const repository = new InMemoryJobRepository(() => "job-1");
  const dispatched = [];
  const dispatcher = { async dispatch(jobId) { dispatched.push(jobId); } };
  const identities = new Map([["乔炳源", {
    userId: "11111111-1111-4111-8111-111111111111",
    displayName: "乔炳源",
    nameKey: "乔炳源",
    verified: true
  }]]);
  const queried = [];
  const handler = createIngressHandler({ MCP_BEARER_TOKEN: secret }, repository, dispatcher, {
    async identityLookup(username) { return identities.get(username.trim()) ?? null; },
    async query(value) { queried.push(value); return { status: "ok", data: { sessions: [] } }; }
  });
  return { repository, dispatched, handler, queried };
}

test("POST /v1/jobs returns 202 only after the D1-style repository accepts the envelope", async () => {
  const { handler, dispatched } = fixture();
  const background = [];

  const response = await handler(request(envelope()), {
    waitUntil(work) { background.push(work); }
  });
  await Promise.all(background);

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { jobId: "job-1", state: "dispatch_pending" });
  assert.deepEqual(dispatched, ["job-1"]);
});

test("an identical ingress retry reuses the job and does not dispatch twice", async () => {
  const { handler, dispatched } = fixture();
  const context = { waitUntil(work) { void work; } };

  await handler(request(envelope()), context);
  const duplicate = await handler(request(envelope()), context);

  assert.equal(duplicate.status, 202);
  assert.deepEqual(await duplicate.json(), { jobId: "job-1", state: "dispatch_pending" });
  assert.deepEqual(dispatched, ["job-1"]);
});

test("a conflicting requestId returns 409 without replacing the first job", async () => {
  const { handler, repository } = fixture();
  await handler(request(envelope()));

  const response = await handler(request(envelope({ payload: { displayName: "另一个人" } })));

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "request_id_conflict" });
  assert.equal(repository.jobCount, 1);
});

test("ingress rejects missing and incorrect bearer credentials", async () => {
  const { handler, repository } = fixture();
  const missing = new Request("https://worker.example/v1/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope())
  });

  const missingResponse = await handler(missing);
  const wrongResponse = await handler(request(envelope(), "wrong"));

  assert.equal(missingResponse.status, 401);
  assert.equal(wrongResponse.status, 403);
  assert.equal(repository.jobCount, 0);
});

test("ingress rejects malformed schema 1.2 envelopes before persistence", async () => {
  const { handler, repository } = fixture();

  const response = await handler(request(envelope({ schemaVersion: "1.1" })));

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_schema_version" });
  assert.equal(repository.jobCount, 0);
});

test("GET /v1/identity looks up an existing user without creating a job", async () => {
  const { handler, repository } = fixture();
  const response = await handler(new Request(
    "https://worker.example/v1/identity?username=%E4%B9%94%E7%82%B3%E6%BA%90",
    { headers: { authorization: `Bearer ${secret}` } }
  ));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    identity: {
      userId: "11111111-1111-4111-8111-111111111111",
      username: "乔炳源",
      verified: true
    }
  });
  assert.equal(repository.jobCount, 0);
});

test("GET /v1/identity returns 404 for an unknown user", async () => {
  const { handler } = fixture();
  const response = await handler(new Request(
    "https://worker.example/v1/identity?username=%E6%9C%AA%E7%9F%A5",
    { headers: { authorization: `Bearer ${secret}` } }
  ));

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "identity_not_found" });
});

test("POST /v1/query allows session reads and returns their result synchronously", async () => {
  const { handler, queried } = fixture();
  const queryEnvelope = envelope({
    namespace: "interview",
    eventType: "interview.session.list",
    payload: {},
    requestId: "query-1"
  });
  const response = await handler(new Request("https://worker.example/v1/query", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(queryEnvelope)
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", data: { sessions: [] } });
  assert.deepEqual(queried, [queryEnvelope]);
});

test("POST /v1/query rejects writes and legacy migration execute", async () => {
  const { handler, queried } = fixture();
  const writeResponse = await handler(new Request("https://worker.example/v1/query", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(envelope())
  }));
  const migrationResponse = await handler(new Request("https://worker.example/v1/query", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(envelope({
      eventType: "system.legacy-migration-requested",
      payload: {
        displayName: "乔炳源",
        mode: "execute",
        migrationId: "22222222-2222-4222-8222-222222222222",
        approvedPlanHash: "a".repeat(64),
        domains: ["algorithm"]
      }
    }))
  }));

  assert.equal(writeResponse.status, 405);
  assert.equal(migrationResponse.status, 405);
  assert.deepEqual(queried, []);
});
