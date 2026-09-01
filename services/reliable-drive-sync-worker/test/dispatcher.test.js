import assert from "node:assert/strict";
import test from "node:test";
import { Dispatcher, QStashPublishError } from "../src/dispatcher.js";
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

async function fixture(publish) {
  const repository = new InMemoryJobRepository(() => "job-1");
  await repository.createOrGet(envelope());
  const dispatcher = new Dispatcher(
    repository,
    { publish },
    {
      QSTASH_TOKEN: "token",
      SYNC_WORKER_URL: "https://worker.example/v1/sync",
      QSTASH_FAILURE_CALLBACK_URL: "https://worker.example/v1/qstash/failure"
    },
    () => new Date("2026-09-01T00:00:00.000Z"),
    () => "dispatch-lease"
  );
  return { repository, dispatcher };
}

test("a QStash acknowledgement moves a D1 job to broker_queued", async () => {
  let published;
  const { repository, dispatcher } = await fixture(async (request) => {
    published = request;
    return { messageId: "message-1" };
  });

  await dispatcher.dispatch("job-1");

  assert.deepEqual(published.job, {
    jobId: "job-1",
    requestId: "request-1",
    userId: "11111111-1111-4111-8111-111111111111"
  });
  assert.equal((await repository.getJob("job-1")).state, "broker_queued");
  assert.equal((await repository.getJob("job-1")).brokerMessageId, "message-1");
});

test("a failed QStash publish remains dispatch_pending for Cron retry", async () => {
  const { repository, dispatcher } = await fixture(async () => {
    throw new QStashPublishError(503);
  });

  await dispatcher.dispatch("job-1");

  const job = await repository.getJob("job-1");
  assert.equal(job.state, "dispatch_pending");
  assert.equal(job.dispatchAttempts, 1);
  assert.equal(job.lastErrorCode, "qstash_publish_http_503");
});

test("missing QStash configuration leaves the durable job recoverable", async () => {
  const repository = new InMemoryJobRepository(() => "job-1");
  await repository.createOrGet(envelope());
  const dispatcher = new Dispatcher(repository, { publish: async () => { throw new Error("must not publish"); } }, {});

  await dispatcher.dispatch("job-1");

  const job = await repository.getJob("job-1");
  assert.equal(job.state, "dispatch_pending");
  assert.equal(job.lastErrorCode, "qstash_config_missing");
});
