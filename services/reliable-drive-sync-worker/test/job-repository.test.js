import assert from "node:assert/strict";
import test from "node:test";
import { D1JobRepository, InMemoryJobRepository } from "../src/job-repository.js";

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

test("an identical requestId reuses one schema 1.2 cloud job", async () => {
  const repository = new InMemoryJobRepository(() => "job-1");

  const first = await repository.createOrGet(envelope());
  const duplicate = await repository.createOrGet(envelope());

  assert.deepEqual(first, {
    jobId: "job-1",
    requestId: "request-registration-1",
    userId: "11111111-1111-4111-8111-111111111111",
    state: "dispatch_pending",
    isNew: true
  });
  assert.equal(duplicate.jobId, "job-1");
  assert.equal(duplicate.isNew, false);
  assert.equal(repository.jobCount, 1);
  assert.deepEqual(await repository.loadEnvelope("job-1"), envelope());
});

test("a reused requestId with different JSON is a conflict", async () => {
  const repository = new InMemoryJobRepository(() => "job-1");
  await repository.createOrGet(envelope());

  await assert.rejects(
    repository.createOrGet(envelope({ payload: { displayName: "另一个人" } })),
    (error) => error?.code === "request_id_conflict"
  );
  assert.equal(repository.jobCount, 1);
});

test("the cloud job stores a clone instead of caller-owned mutable JSON", async () => {
  const repository = new InMemoryJobRepository(() => "job-1");
  const input = envelope();
  await repository.createOrGet(input);
  input.payload.displayName = "被调用方修改";

  const stored = await repository.loadEnvelope("job-1");

  assert.equal(stored.payload.displayName, "乔炳源");
});

test("expired dispatch and sync leases are made claimable again", async () => {
  const repository = new InMemoryJobRepository(() => crypto.randomUUID());
  const first = await repository.createOrGet(envelope({ requestId: "dispatch-expired" }));
  await repository.claimForDispatch(
    first.jobId, "owner-1", new Date("2026-09-01T00:00:00.000Z"), new Date("2026-08-31T23:59:00.000Z")
  );
  const second = await repository.createOrGet(envelope({ requestId: "sync-expired" }));
  await repository.claimForDispatch(second.jobId, "owner-2", new Date("2026-09-01T00:00:00.000Z"), new Date("2026-08-31T23:59:00.000Z"));
  await repository.markBrokerQueued(second.jobId, "owner-2", "message-2");
  await repository.claimForSync(second.jobId, "owner-3", new Date("2026-09-01T00:00:00.000Z"), new Date("2026-08-31T23:59:00.000Z"));

  assert.equal(await repository.requeueExpiredLeases(new Date("2026-09-01T00:01:00.000Z")), 2);
  assert.equal((await repository.getJob(first.jobId)).state, "dispatch_pending");
  assert.equal((await repository.getJob(second.jobId)).state, "broker_queued");
});

test("the D1 repository persists the complete schema 1.2 envelope and reads it back", async () => {
  let row = null;
  let insertedValues = [];
  const database = {
    prepare(query) {
      const statement = {
        values: [],
        bind(...values) {
          statement.values = values;
          return statement;
        },
        async first() {
          if (query.includes("FROM schema12_jobs") && row) return structuredClone(row);
          return null;
        },
        async run() {
          if (!query.includes("INSERT OR IGNORE INTO schema12_jobs")) {
            return { meta: { changes: 0 } };
          }
          insertedValues = statement.values;
          row = {
            job_id: statement.values[0],
            request_id: statement.values[1],
            user_id: statement.values[2],
            envelope_json: statement.values[3],
            envelope_hash: statement.values[4],
            state: "dispatch_pending"
          };
          return { meta: { changes: 1 } };
        }
      };
      return statement;
    }
  };
  const repository = new D1JobRepository(database, () => "job-d1");

  const result = await repository.createOrGet(envelope());

  assert.equal(result.jobId, "job-d1");
  assert.equal(insertedValues[1], "request-registration-1");
  assert.equal(insertedValues[2], "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(JSON.parse(insertedValues[3]), envelope());
  assert.match(insertedValues[4], /^[0-9a-f]{64}$/);
  assert.deepEqual(await repository.loadEnvelope("job-d1"), envelope());
});
