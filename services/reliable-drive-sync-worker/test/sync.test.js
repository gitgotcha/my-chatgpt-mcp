import assert from "node:assert/strict";
import test from "node:test";
import { ProtocolError } from "../src/protocol.js";
import { InMemoryJobRepository } from "../src/job-repository.js";
import { createFailureCallbackHandler, createSyncHandler } from "../src/sync.js";

const signingKey = "qstash-signing-key";
const syncUrl = "https://worker.example/v1/sync";
const failureUrl = "https://worker.example/v1/qstash/failure";

function envelope() {
  return {
    schemaVersion: "1.2",
    namespace: "system",
    eventType: "system.user-registered",
    identity: { username: "乔炳源", userId: "11111111-1111-4111-8111-111111111111" },
    payload: {
      displayName: "乔炳源",
      username: "乔炳源",
      userId: "11111111-1111-4111-8111-111111111111"
    },
    requestId: "request-1"
  };
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function signature(body, url, key = signingKey) {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const payload = base64Url(JSON.stringify({
    iss: "Upstash",
    sub: url,
    exp: Math.floor(Date.now() / 1000) + 300,
    body: base64Url(new Uint8Array(digest))
  }));
  const signed = `${header}.${payload}`;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(signed));
  return `${signed}.${base64Url(new Uint8Array(mac))}`;
}

async function readyRepository() {
  const repository = new InMemoryJobRepository(() => "job-1");
  await repository.createOrGet(envelope());
  await repository.claimForDispatch("job-1", "dispatch", new Date(), new Date(Date.now() + 60_000));
  await repository.markBrokerQueued("job-1", "dispatch", "message-1", new Date());
  return repository;
}

async function signedRequest(body, url = syncUrl) {
  const raw = JSON.stringify(body);
  return new Request(url, {
    method: "POST",
    headers: { "Upstash-Signature": await signature(raw, url) },
    body: raw
  });
}

function message() {
  return {
    jobId: "job-1",
    requestId: "request-1",
    userId: "11111111-1111-4111-8111-111111111111"
  };
}

function environment() {
  return {
    SYNC_WORKER_URL: syncUrl,
    QSTASH_FAILURE_CALLBACK_URL: failureUrl,
    QSTASH_CURRENT_SIGNING_KEY: signingKey
  };
}

test("a signed successful delivery marks the D1 job synced", async () => {
  const repository = await readyRepository();
  const handler = createSyncHandler(environment(), repository, async (value) => {
    assert.deepEqual(value, envelope());
    return { status: "ok" };
  }, () => new Date("2026-09-01T00:00:00.000Z"), () => "sync-lease");

  const response = await handler(await signedRequest(message()));

  assert.equal(response.status, 204);
  assert.equal((await repository.getJob("job-1")).state, "synced");
});

test("already_scored_today is terminal and does not retry forever", async () => {
  const repository = await readyRepository();
  const handler = createSyncHandler(environment(), repository, async () => ({ status: "already_scored_today" }));

  const response = await handler(await signedRequest(message()));

  assert.equal(response.status, 204);
  assert.equal((await repository.getJob("job-1")).state, "synced");
});

test("profile_cache_pending releases the lease for QStash retry", async () => {
  const repository = await readyRepository();
  const handler = createSyncHandler(environment(), repository, async () => ({ status: "profile_cache_pending" }));

  const response = await handler(await signedRequest(message()));

  assert.equal(response.status, 503);
  assert.equal((await repository.getJob("job-1")).state, "broker_queued");
  assert.equal((await repository.getJob("job-1")).lastErrorCode, "profile_cache_pending");
});

test("a permanent protocol conflict is sealed as needs_attention", async () => {
  const repository = await readyRepository();
  const handler = createSyncHandler(environment(), repository, async () => {
    throw new ProtocolError("identity_mismatch");
  });

  const response = await handler(await signedRequest(message()));

  assert.equal(response.status, 489);
  assert.equal(response.headers.get("Upstash-NonRetryable-Error"), "true");
  assert.equal((await repository.getJob("job-1")).state, "needs_attention");
});

test("an invalid QStash signature never loads or mutates the job", async () => {
  const repository = await readyRepository();
  const handler = createSyncHandler(environment(), repository, async () => ({ status: "ok" }));
  const raw = JSON.stringify(message());
  const request = new Request(syncUrl, {
    method: "POST",
    headers: { "Upstash-Signature": "invalid" },
    body: raw
  });

  const response = await handler(request);

  assert.equal(response.status, 489);
  assert.equal((await repository.getJob("job-1")).state, "broker_queued");
});

test("a signed terminal failure callback marks the job for attention", async () => {
  const repository = await readyRepository();
  const callbackBody = JSON.stringify({ body: JSON.stringify(message()) });
  const request = new Request(failureUrl, {
    method: "POST",
    headers: { "Upstash-Signature": await signature(callbackBody, failureUrl) },
    body: callbackBody
  });
  const handler = createFailureCallbackHandler(environment(), repository);

  const response = await handler(request);

  assert.equal(response.status, 489);
  assert.equal((await repository.getJob("job-1")).state, "needs_attention");
});
