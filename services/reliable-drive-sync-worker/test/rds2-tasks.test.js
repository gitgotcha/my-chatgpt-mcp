import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withD1, applySchema } from "./support/rds2-d1.js";
import { createInvocationIo } from "../src/rds2/io/invocation-io.js";
import {
  claimForDispatch,
  claimForProcessing,
  markQueued,
  completeTask,
  failTask,
  deferTask,
  requeueNeedsAttention,
  getTask
} from "../src/rds2/tasks/repository.js";
import { dispatchOne, splitQueueBatch, QUEUE_BY_TASK_TYPE } from "../src/rds2/tasks/dispatcher.js";
import { recoverOnce, RECOVERY_WORST_CASE_PER_TASK } from "../src/rds2/tasks/recovery.js";
import { handleDlq } from "../src/rds2/tasks/dlq.js";

const MIGRATION_SQL = readFileSync(fileURLToPath(
  new URL("../migrations/0006_rds2_v2_tables.sql", import.meta.url)
), "utf8");
const NOW = "2026-09-06T00:00:00.000Z";
const LATER = "2026-09-06T00:10:00.000Z";
const USER = "11111111-1111-4111-8111-111111111111";
const LEASE_SECONDS = 300;

let taskSequence = 0;

async function runTaskTest(body) {
  await withD1(async (binding, rawDb) => {
    await applySchema(rawDb, MIGRATION_SQL);
    const sent = [];
    const queues = {
      RDS2_PROJECTION_QUEUE: { send: async (message) => { sent.push({ queue: "projection", message }); } },
      RDS2_ARCHIVE_QUEUE: { send: async (message) => { sent.push({ queue: "archive", message }); } }
    };
    const io = createInvocationIo({ db: rawDb, queues, fetchImpl: async () => new Response("{}", { status: 200 }), limit: 32 });
    await body({ binding, rawDb, io, sent });
  });
}

async function seedTask(rawDb, overrides = {}) {
  taskSequence += 1;
  const task = {
    taskId: `task-${String(taskSequence).padStart(3, "0")}`,
    type: "projection",
    userId: USER,
    namespace: "algorithm",
    projectionName: "learning",
    eventSeq: taskSequence,
    artifactId: null,
    state: "pending",
    availableAt: NOW,
    leaseEpoch: 0,
    failureCount: 0,
    ...overrides
  };
  await rawDb.prepare(
    `INSERT INTO rds2_tasks (task_id, type, user_id, namespace, projection_name, event_seq, artifact_id,
       state, available_at, lease_epoch, failure_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    task.taskId, task.type, task.userId, task.namespace, task.projectionName,
    task.eventSeq, task.artifactId, task.state, task.availableAt,
    task.leaseEpoch, task.failureCount, NOW, NOW
  ).run();
  return task;
}

function makeIo(rawDb, queues, limit = 32) {
  return createInvocationIo({ db: rawDb, queues, fetchImpl: async () => new Response("{}", { status: 200 }), limit });
}

test("a pending task before available_at is never sent", async () => {
  await runTaskTest(async ({ binding, rawDb, io, sent }) => {
    const task = await seedTask(rawDb, { availableAt: LATER });
    const result = await dispatchOne({ io, taskId: task.taskId, owner: "worker-a", now: NOW });
    assert.equal(result.outcome, "noop", `(${binding}) a future task is not dispatchable`);
    assert.equal(result.code, "not_claimable");
    assert.deepEqual(sent, [], `(${binding}) zero queue sends for a future task`);
    const row = await getTask(rawDb, task.taskId);
    assert.equal(row.state, "pending");
    assert.equal(row.attempt, 0);
  });
});

test("dispatchOne claims with a lease, sends only taskId and type, then marks queued", async () => {
  await runTaskTest(async ({ binding, rawDb, io, sent }) => {
    const task = await seedTask(rawDb);
    const result = await dispatchOne({ io, taskId: task.taskId, owner: "worker-a", now: NOW });
    assert.equal(result.outcome, "continued");
    assert.equal(result.code, "queued");
    assert.deepEqual(sent.map((entry) => entry.message), [{ taskId: task.taskId, type: "projection" }],
      `(${binding}) queue messages carry only taskId and type`);
    assert.equal(sent[0].queue, "projection");
    const row = await getTask(rawDb, task.taskId);
    assert.equal(row.state, "queued");
    assert.equal(row.attempt, 1, `(${binding}) a real dispatch claim adds one attempt`);
    assert.equal(row.lease_epoch, 1);
    assert.equal(row.lease_owner, "worker-a");
    assert.equal(row.lease_until > NOW, true);
  });
});

test("markQueued never reverts a task the consumer already claimed", async () => {
  await runTaskTest(async ({ binding, rawDb, io, sent }) => {
    const task = await seedTask(rawDb);
    await dispatchOne({ io, taskId: task.taskId, owner: "worker-a", now: NOW });
    // The consumer claims (dispatching/queued -> processing) before the
    // dispatcher's late markQueued lands.
    const consumerLease = await claimForProcessing({ db: rawDb, taskId: task.taskId, owner: "consumer-1", now: NOW, leaseSeconds: LEASE_SECONDS });
    assert.ok(consumerLease, `(${binding}) the consumer must be able to claim a queued task`);
    assert.equal(consumerLease.epoch, 2, `(${binding}) the consumer claim increments the epoch without adding an attempt`);
    const rowAfterClaim = await getTask(rawDb, task.taskId);
    assert.equal(rowAfterClaim.attempt, 1, `(${binding}) consumer claims never add attempts`);
    const queued = await markQueued({ db: rawDb, taskId: task.taskId, owner: "worker-a", epoch: 1, now: NOW });
    assert.equal(queued.rowsWritten, 0, `(${binding}) the late markQueued must be a no-op`);
    const row = await getTask(rawDb, task.taskId);
    assert.equal(row.state, "processing", `(${binding}) the consumer claim must survive the late markQueued`);
    const completed = await completeTask({ db: rawDb, lease: consumerLease, now: NOW });
    assert.equal(completed.rowsWritten, 1);
  });
});

test("duplicate queue messages do not add attempts or double-process", async () => {
  await runTaskTest(async ({ binding, rawDb, io, sent }) => {
    const task = await seedTask(rawDb);
    await dispatchOne({ io, taskId: task.taskId, owner: "worker-a", now: NOW });
    const first = await claimForProcessing({ db: rawDb, taskId: task.taskId, owner: "consumer-1", now: NOW, leaseSeconds: LEASE_SECONDS });
    const second = await claimForProcessing({ db: rawDb, taskId: task.taskId, owner: "consumer-2", now: NOW, leaseSeconds: LEASE_SECONDS });
    assert.ok(first);
    assert.equal(second, null, `(${binding}) a processing task cannot be claimed twice`);
    const row = await getTask(rawDb, task.taskId);
    assert.equal(row.attempt, 1, `(${binding}) duplicate messages must not add attempts`);
    assert.equal(row.lease_owner, "consumer-1");
  });
});

test("an expired lease lets a new owner win and the old owner cannot overwrite", async () => {
  await runTaskTest(async ({ binding, rawDb, io }) => {
    const task = await seedTask(rawDb, { state: "processing", leaseEpoch: 2 });
    await rawDb.prepare(
      `UPDATE rds2_tasks SET lease_owner = 'worker-old', lease_until = ? WHERE task_id = ?`
    ).bind("2026-09-05T23:59:00.000Z", task.taskId).run();
    // Recovery reclaims the expired processing lease and re-dispatches it.
    const stats = await recoverOnce({ io, now: NOW, limit: 4 });
    assert.equal(stats.reclaimed, 1, `(${binding}) the expired task is reclaimed`);
    assert.equal(stats.dispatched, 1, `(${binding}) the reclaimed task is queued again`);
    const lease = await claimForProcessing({ db: rawDb, taskId: task.taskId, owner: "consumer-new", now: NOW, leaseSeconds: LEASE_SECONDS });
    assert.ok(lease);
    assert.equal(lease.owner, "consumer-new");
    const staleWrite = await completeTask({ db: rawDb, lease: { taskId: task.taskId, owner: "worker-old", epoch: 2, leaseUntil: "2026-09-05T23:59:00.000Z" }, now: NOW });
    assert.equal(staleWrite.rowsWritten, 0, `(${binding}) the stale owner must not complete the task`);
    const freshWrite = await completeTask({ db: rawDb, lease, now: NOW });
    assert.equal(freshWrite.rowsWritten, 1, `(${binding}) the current owner completes`);
    const row = await getTask(rawDb, task.taskId);
    assert.equal(row.state, "completed");
  });
});

test("real failures back off and five consecutive failures need attention", async () => {
  await runTaskTest(async ({ binding, rawDb, io, sent }) => {
    const task = await seedTask(rawDb);
    await dispatchOne({ io, taskId: task.taskId, owner: "worker-a", now: NOW });
    let lease = await claimForProcessing({ db: rawDb, taskId: task.taskId, owner: "consumer-1", now: NOW, leaseSeconds: LEASE_SECONDS });
    const backoffs = [30, 60, 120, 240];
    for (let index = 0; index < backoffs.length; index += 1) {
      const failed = await failTask({ db: rawDb, lease, now: NOW, code: "drive_5xx" });
      assert.equal(failed.rowsWritten, 1);
      const row = await getTask(rawDb, task.taskId);
      assert.equal(row.failure_count, index + 1, `(${binding}) failure ${index + 1} is recorded`);
      assert.equal(row.state, "pending", `(${binding}) the task returns to pending for retry`);
      const expected = new Date(Date.parse(NOW) + backoffs[index] * 1000).toISOString();
      assert.equal(row.available_at, expected, `(${binding}) backoff ${backoffs[index]}s is applied`);
      // redispatch and claim again for the next failure round
      await dispatchOne({ io, taskId: task.taskId, owner: `worker-${index}`, now: row.available_at });
      lease = await claimForProcessing({ db: rawDb, taskId: task.taskId, owner: `consumer-${index}`, now: row.available_at, leaseSeconds: LEASE_SECONDS });
      assert.ok(lease);
    }
    // Fifth consecutive failure must park the task in needs_attention.
    const parked = await failTask({ db: rawDb, lease, now: NOW, code: "drive_5xx" });
    assert.equal(parked.rowsWritten, 1);
    const row = await getTask(rawDb, task.taskId);
    assert.equal(row.state, "needs_attention", `(${binding}) five consecutive failures need attention`);
    assert.equal(row.failure_count, 5);
    // needs_attention never auto-revives: dispatch must refuse.
    const revived = await dispatchOne({ io, taskId: task.taskId, owner: "worker-b", now: LATER });
    assert.equal(revived.outcome, "noop", `(${binding}) needs_attention is not auto-revived`);
    // Admin replay keeps the same task id, records the reason and bumps the epoch.
    const epochBefore = row.lease_epoch;
    const replayed = await requeueNeedsAttention({ db: rawDb, taskId: task.taskId, reason: "operator-replay", now: LATER });
    assert.equal(replayed.rowsWritten, 1);
    const after = await getTask(rawDb, task.taskId);
    assert.equal(after.state, "pending");
    assert.equal(after.lease_epoch, epochBefore + 1, `(${binding}) admin replay increments the epoch`);
    assert.equal(JSON.parse(after.payload_json).lastReplayReason.reason, "operator-replay");
  });
});

test("deferred tasks wait without counting failures", async () => {
  await runTaskTest(async ({ binding, rawDb, io }) => {
    const task = await seedTask(rawDb);
    await dispatchOne({ io, taskId: task.taskId, owner: "worker-a", now: NOW });
    const lease = await claimForProcessing({ db: rawDb, taskId: task.taskId, owner: "consumer-1", now: NOW, leaseSeconds: LEASE_SECONDS });
    await deferTask({ db: rawDb, lease, now: NOW, availableAt: LATER });
    const row = await getTask(rawDb, task.taskId);
    assert.equal(row.state, "pending");
    assert.equal(row.failure_count, 0, `(${binding}) deferral never counts as a failure`);
    assert.equal(row.available_at, LATER);
    const early = await dispatchOne({ io, taskId: task.taskId, owner: "worker-b", now: NOW });
    assert.equal(early.outcome, "noop", `(${binding}) a deferred task is not dispatched early`);
  });
});

test("a failed queue send releases the lease through owner-scoped failure close", async () => {
  await runTaskTest(async ({ binding, rawDb }) => {
    const task = await seedTask(rawDb);
    let calls = 0;
    const failingQueue = { send: async () => { calls += 1; throw new Error("queue_down"); } };
    const io = makeIo(rawDb, { RDS2_PROJECTION_QUEUE: failingQueue, RDS2_ARCHIVE_QUEUE: failingQueue });
    const result = await dispatchOne({ io, taskId: task.taskId, owner: "worker-a", now: NOW });
    assert.equal(result.outcome, "retry", `(${binding}) a failed send is retryable`);
    assert.equal(result.code, "queue_send_failed");
    assert.equal(calls, 1);
    const row = await getTask(rawDb, task.taskId);
    assert.equal(row.state, "pending", `(${binding}) the task is back to pending`);
    assert.equal(row.failure_count, 1, `(${binding}) a real external failure counts`);
    assert.equal(row.lease_owner, null, `(${binding}) the lease is released`);
    assert.equal(row.attempt, 1, `(${binding}) the attempt is diagnostic only`);
  });
});

test("recovery reclaims expired tasks, dispatches them and never touches active leases", async () => {
  await runTaskTest(async ({ binding, rawDb, io, sent }) => {
    const expiredDispatching = await seedTask(rawDb, { state: "dispatching", leaseEpoch: 1 });
    await rawDb.prepare("UPDATE rds2_tasks SET lease_owner = 'w1', lease_until = ? WHERE task_id = ?")
      .bind("2026-09-05T23:00:00.000Z", expiredDispatching.taskId).run();
    const expiredQueued = await seedTask(rawDb, { state: "queued", leaseEpoch: 1 });
    await rawDb.prepare("UPDATE rds2_tasks SET lease_owner = 'w2', lease_until = ? WHERE task_id = ?")
      .bind("2026-09-05T23:00:00.000Z", expiredQueued.taskId).run();
    const active = await seedTask(rawDb, { state: "processing", leaseEpoch: 1 });
    await rawDb.prepare("UPDATE rds2_tasks SET lease_owner = 'w3', lease_until = ? WHERE task_id = ?")
      .bind("2026-09-06T01:00:00.000Z", active.taskId).run();

    const stats = await recoverOnce({ io, now: NOW, limit: 4 });
    assert.equal(stats.reclaimed, 2, `(${binding}) exactly the expired tasks are reclaimed`);
    assert.equal(stats.dispatched, 2, `(${binding}) reclaimed tasks are redispatched`);
    assert.equal(stats.stoppedForBudget, false);
    const activeRow = await getTask(rawDb, active.taskId);
    assert.equal(activeRow.state, "processing", `(${binding}) the active lease is untouched`);
    assert.equal(activeRow.lease_owner, "w3");
    const reclaimedIds = sent.filter((entry) => entry.message.type === "projection").map((entry) => entry.message.taskId);
    assert.deepEqual(reclaimedIds.sort(), [expiredDispatching.taskId, expiredQueued.taskId].sort());
  });
});

test("recovery stops before starting a task without worst-case budget headroom", async () => {
  await runTaskTest(async ({ binding, rawDb }) => {
    const failingQueue = { send: async () => { throw new Error("queue_down"); } };
    for (let index = 0; index < 3; index += 1) {
      const task = await seedTask(rawDb, { state: "dispatching", leaseEpoch: 1 });
      await rawDb.prepare("UPDATE rds2_tasks SET lease_owner = 'w', lease_until = ? WHERE task_id = ?")
        .bind("2026-09-05T23:00:00.000Z", task.taskId).run();
    }
    // With a failing queue every task hits the worst case exactly: reclaim +
    // dispatch claim + counted failed send + failure close read/write. The
    // limit covers the find batch plus two such tasks only.
    const tightLimit = 1 + 2 * RECOVERY_WORST_CASE_PER_TASK;
    const io = makeIo(rawDb, { RDS2_PROJECTION_QUEUE: failingQueue, RDS2_ARCHIVE_QUEUE: failingQueue }, tightLimit);
    const stats = await recoverOnce({ io, now: NOW, limit: 4 });
    assert.equal(stats.reclaimed, 2, `(${binding}) only two tasks fit the reserved budget`);
    assert.equal(stats.dispatched, 0, `(${binding}) the failing sends are recorded as failures`);
    assert.equal(stats.stoppedForBudget, true, `(${binding}) recovery reports the budget stop`);
    assert.equal(io.budget.snapshot().used <= tightLimit, true);
    const third = await rawDb.prepare(
      "SELECT state FROM rds2_tasks WHERE state IN ('dispatching','queued','processing')"
    ).first("state");
    assert.equal(third, "dispatching", `(${binding}) the third task waits for the next recovery pass`);
  });
});

test("splitQueueBatch processes the first message and retries the rest", () => {
  const batch = [
    { taskId: "t-1", type: "projection" },
    { taskId: "t-2", type: "projection" },
    { taskId: "t-3", type: "archive_event" }
  ];
  const split = splitQueueBatch(batch);
  assert.deepEqual(split.first, { taskId: "t-1", type: "projection" });
  assert.deepEqual(split.rest, [{ taskId: "t-2", type: "projection" }, { taskId: "t-3", type: "archive_event" }]);
  assert.deepEqual(splitQueueBatch([]), { first: null, rest: [] });
  const invalid = splitQueueBatch([{ bogus: true }, { taskId: "t-9", type: "projection" }]);
  assert.equal(invalid.first, null, "an invalid first message is not processed");
  assert.deepEqual(invalid.rest, [{ bogus: true }, { taskId: "t-9", type: "projection" }]);
  assert.equal(QUEUE_BY_TASK_TYPE.projection, "RDS2_PROJECTION_QUEUE");
  assert.equal(QUEUE_BY_TASK_TYPE.archive_event, "RDS2_ARCHIVE_QUEUE");
  assert.equal(QUEUE_BY_TASK_TYPE.archive_delta, "RDS2_ARCHIVE_QUEUE");
});

test("DLQ acks completed tasks and never revives needs_attention", async () => {
  await runTaskTest(async ({ binding, rawDb, io, sent }) => {
    const completed = await seedTask(rawDb, { state: "completed", leaseEpoch: 3 });
    const ack = await handleDlq({ io, taskId: completed.taskId, now: NOW });
    assert.equal(ack.outcome, "noop", `(${binding}) a completed task is only acked`);
    assert.deepEqual(sent, [], `(${binding}) acking a completed task sends nothing`);

    const parked = await seedTask(rawDb, { state: "needs_attention", leaseEpoch: 4, failureCount: 5 });
    const ignored = await handleDlq({ io, taskId: parked.taskId, now: NOW });
    assert.equal(ignored.outcome, "noop", `(${binding}) needs_attention is not auto-revived`);
    assert.equal(ignored.code, "needs_attention");
    const parkedRow = await getTask(rawDb, parked.taskId);
    assert.equal(parkedRow.state, "needs_attention");

    const pending = await seedTask(rawDb);
    const dispatched = await handleDlq({ io, taskId: pending.taskId, now: NOW });
    assert.equal(dispatched.outcome, "continued", `(${binding}) a live task is dispatched from the DLQ path`);
    const pendingRow = await getTask(rawDb, pending.taskId);
    assert.equal(pendingRow.state, "queued");
  });
});

test("DLQ handling only trusts the taskId and loads the task from D1", async () => {
  await runTaskTest(async ({ binding, rawDb, io }) => {
    const unknown = await handleDlq({ io, taskId: "task-does-not-exist", now: NOW });
    assert.equal(unknown.outcome, "noop");
    assert.equal(unknown.code, "unknown_task", `(${binding}) an unknown DLQ taskId is a safe no-op`);
  });
});
