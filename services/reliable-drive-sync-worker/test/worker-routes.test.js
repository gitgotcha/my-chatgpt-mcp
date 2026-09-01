import assert from "node:assert/strict";
import test from "node:test";
import workerModule, { createWorker } from "../src/index.js";
import { InMemoryJobRepository } from "../src/job-repository.js";

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

function environment() {
  return {
    MCP_BEARER_TOKEN: "secret",
    QSTASH_TOKEN: "qstash",
    SYNC_WORKER_URL: "https://worker.example/v1/sync",
    QSTASH_FAILURE_CALLBACK_URL: "https://worker.example/v1/qstash/failure",
    QSTASH_CURRENT_SIGNING_KEY: "signing"
  };
}

test("the Worker routes local MCP writes to /v1/jobs and schedules QStash", async () => {
  const repository = new InMemoryJobRepository(() => "job-1");
  const published = [];
  const worker = createWorker(environment(), {
    repository,
    publisher: { async publish(request) { published.push(request); return { messageId: "message-1" }; } },
    dispatchSubmitEvent: async () => ({ status: "ok" })
  });
  const background = [];
  const response = await worker.fetch(new Request("https://worker.example/v1/jobs", {
    method: "POST",
    headers: { authorization: "Bearer secret", "content-type": "application/json" },
    body: JSON.stringify(envelope())
  }), environment(), { waitUntil(work) { background.push(work); } });
  await Promise.all(background);

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { jobId: "job-1", state: "dispatch_pending" });
  assert.equal(published.length, 1);
  assert.equal((await repository.getJob("job-1")).state, "broker_queued");
});

test("the five-minute scheduled handler republishes durable pending jobs", async () => {
  const repository = new InMemoryJobRepository(() => "job-1");
  await repository.createOrGet(envelope());
  const published = [];
  const worker = createWorker(environment(), {
    repository,
    publisher: { async publish(request) { published.push(request); return { messageId: "message-1" }; } },
    dispatchSubmitEvent: async () => ({ status: "ok" })
  });
  const background = [];

  worker.scheduled({ cron: "*/5 * * * *" }, environment(), { waitUntil(work) { background.push(work); } });
  await Promise.all(background);

  assert.equal(published.length, 1);
  assert.equal((await repository.getJob("job-1")).state, "broker_queued");
});

test("the deployed Worker exposes no root or capability-URL MCP endpoint", async () => {
  const runtime = environment();
  runtime.DB = {};
  for (const path of ["/", "/mcp/0123456789abcdefghijklmnopqrstuvwxyz"] ) {
    const response = await workerModule.fetch(new Request(`https://worker.example${path}`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    }), runtime, {});
    assert.equal(response.status, 404);
  }
});
