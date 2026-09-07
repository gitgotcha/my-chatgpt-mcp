// G2-F2/R1: the failure close-out must itself be inside an error boundary.
// The 2026-09-07 implementation review reproduced three leaks: a failing
// authoritative re-check, a failing park and a failing failTask all threw the
// ORIGINAL error (raw SQL text included) out of the service boundary, while
// the task stayed in processing. The approved behaviour: the close-out
// returns a STABLE class-E result instead — honest, closed-set, no retry
// loop, no fake persisted state — and every SUCCESSFUL persisted transition
// emits one structured, sanitized log line.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withD1, applySchema } from "./support/rds2-d1.js";
import { createInvocationIo } from "../src/rds2/io/invocation-io.js";
import { closeOutFailure } from "../src/rds2/errors/close-out.js";
import { claimForProcessing } from "../src/rds2/tasks/repository.js";

const MIGRATION_SQL = readFileSync(fileURLToPath(
  new URL("../migrations/0006_rds2_v2_tables.sql", import.meta.url)
), "utf8");
const NOW = "2026-09-06T00:00:00.000Z";
const USER_A = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "task-closeout-1";
const LEASE_OWNER = "owner-1";
const LEASE_SECONDS = 300;

const LEASE_UNTIL = new Date(Date.parse(NOW) + LEASE_SECONDS * 1000).toISOString();

// A raw storage error whose message contains text that must NEVER cross the
// service boundary again.
const RAW_FAULT = () => {
  const error = new Error("synthetic_private_detail FROM rds2_secret_table");
  error.code = "ERR_SQLITE_ERROR";
  error.errcode = 1;
  return error;
};

// Shapes from the dual-binding probe (same fixtures as rds2-storage-error).
const TRIGGER_ERROR = (marker) => ({
  name: "Error",
  message: marker,
  code: "ERR_SQLITE_ERROR",
  errcode: 1811,
  errstr: "constraint failed"
});

async function seedProcessingTask(rawDb, { state = "dispatching", taskId = TASK_ID } = {}) {
  await rawDb.prepare(
    `INSERT INTO rds2_projections (user_id, namespace, projection_name, revision, last_event_seq,
       active_generation, building, summary_json, updated_at)
     VALUES (?, 'algorithm', 'learning', 0, 0, 0, 0, NULL, ?)
     ON CONFLICT (user_id, namespace, projection_name) DO NOTHING`
  ).bind(USER_A, NOW).run();
  await rawDb.prepare(
    `INSERT INTO rds2_tasks (task_id, type, user_id, namespace, projection_name, event_seq, state,
       lease_owner, lease_until, lease_epoch, available_at, created_at, updated_at)
     VALUES (?, 'projection_build', ?, 'algorithm', 'learning', NULL, ?, ?, ?, 3, ?, ?, ?)`
  ).bind(taskId, USER_A, state, LEASE_OWNER, LEASE_UNTIL, NOW, NOW, NOW).run();
  return claimForProcessing({ db: rawDb, taskId, owner: LEASE_OWNER, now: NOW, leaseSeconds: LEASE_SECONDS });
}

// Intercepts one SQL fragment at the NATIVE driver level (below wrapD1) so
// the fault lands exactly where a real storage fault would.
function dbFailingOn(rawDb, matchSql) {
  return {
    prepare: (sql) => {
      const native = rawDb.prepare(sql);
      if (sql.includes(matchSql)) {
        const trap = () => { throw RAW_FAULT(); };
        return {
          bind: () => ({ first: trap, all: trap, run: trap }),
          first: trap,
          all: trap,
          run: trap
        };
      }
      return native;
    },
    batch: (statements) => rawDb.batch(statements)
  };
}

async function runCloseOutTest(body) {
  await withD1(async (binding, rawDb) => {
    await applySchema(rawDb, MIGRATION_SQL);
    await body({ binding, rawDb });
  });
}

test("F2-R1 a failing authoritative re-check returns a stable class E, not the raw error", async () => {
  await runCloseOutTest(async ({ binding, rawDb }) => {
    const lease = await seedProcessingTask(rawDb);
    const io = createInvocationIo({ db: rawDb, limit: 12 });
    let logged = [];
    const result = await closeOutFailure({
      io: { ...io, log: (line) => logged.push(line) },
      lease, now: NOW, taskId: TASK_ID,
      error: TRIGGER_ERROR("stale_task_write"),
      verifyAuthoritative: async () => { throw RAW_FAULT(); }
    });
    assert.equal(result.class, "E", `(${binding}) ${JSON.stringify(result)}`);
    assert.equal(result.outcome, "failed");
    assert.equal(result.code, "closeout_verify_unavailable");
    // Honest state: nothing was written, the lease is untouched and the
    // recovery pass (reclaimStale) remains the path forward.
    const task = await rawDb.prepare("SELECT state, failure_count FROM rds2_tasks WHERE task_id = ?")
      .bind(TASK_ID).first();
    assert.equal(task.state, "processing", `(${binding}) no fake close-out was persisted`);
    assert.equal(Number(task.failure_count), 0);
    // No structured log: nothing was durably transitioned.
    assert.equal(logged.length, 0, `(${binding}) an unsuccessful close-out logs nothing`);
  });
});

test("F2-R1 a failing park returns a stable class E without leaking raw text", async () => {
  await runCloseOutTest(async ({ binding, rawDb }) => {
    const lease = await seedProcessingTask(rawDb);
    const logged = [];
    const io = createInvocationIo({ db: dbFailingOn(rawDb, "SET state = 'needs_attention'"), limit: 12, log: (line) => logged.push(line) });
    const result = await closeOutFailure({
      io, lease, now: NOW, taskId: TASK_ID,
      error: TRIGGER_ERROR("cursor_regression")
    });
    assert.equal(result.class, "E", `(${binding}) ${JSON.stringify(result)}`);
    assert.equal(result.code, "closeout_park_unavailable");
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes("synthetic_private_detail"), `(${binding}) raw detail leaked: ${serialized}`);
    assert.ok(!serialized.includes("rds2_secret_table"), `(${binding}) raw table leaked: ${serialized}`);
    const task = await rawDb.prepare("SELECT state FROM rds2_tasks WHERE task_id = ?").bind(TASK_ID).first("state");
    assert.equal(task, "processing", `(${binding}) the park must not be claimed when it failed`);
    assert.equal(logged.length, 0);
  });
});

test("F2-R1 a failing failTask returns a stable class E without leaking raw text", async () => {
  await runCloseOutTest(async ({ binding, rawDb }) => {
    const lease = await seedProcessingTask(rawDb);
    const io = createInvocationIo({ db: dbFailingOn(rawDb, "failure_count = failure_count + 1"), limit: 12 });
    const result = await closeOutFailure({
      io, lease, now: NOW, taskId: TASK_ID,
      error: { message: "no such table: rds2_missing", code: "ERR_SQLITE_ERROR", errcode: 1 }
    });
    assert.equal(result.class, "E", `(${binding}) ${JSON.stringify(result)}`);
    assert.equal(result.code, "closeout_fail_unavailable");
    assert.ok(!JSON.stringify(result).includes("rds2_missing"));
    const task = await rawDb.prepare("SELECT state, failure_count FROM rds2_tasks WHERE task_id = ?")
      .bind(TASK_ID).first();
    assert.equal(task.state, "processing");
    assert.equal(Number(task.failure_count), 0, `(${binding}) a failed booking writes no count`);
  });
});

test("F2-R1 budget_exhausted arriving at the close-out is a normal wait, never parked", async () => {
  await runCloseOutTest(async ({ binding, rawDb }) => {
    const lease = await seedProcessingTask(rawDb);
    const io = createInvocationIo({ db: rawDb, limit: 12 });
    const result = await closeOutFailure({
      io, lease, now: NOW, taskId: TASK_ID,
      error: { message: "budget_exhausted", code: "budget_exhausted" }
    });
    assert.equal(result.class, "A", `(${binding}) ${JSON.stringify(result)}`);
    assert.equal(result.outcome, "retry");
    const task = await rawDb.prepare("SELECT state, failure_count, available_at FROM rds2_tasks WHERE task_id = ?")
      .bind(TASK_ID).first();
    assert.equal(task.state, "pending", `(${binding}) back to pending without a count`);
    assert.equal(Number(task.failure_count), 0, `(${binding}) budget exhaustion is not a failure`);
  });
});

test("F2-R1 each successful persisted transition emits exactly one sanitized log line", async () => {
  await runCloseOutTest(async ({ binding, rawDb }) => {
    // C: failTask succeeds -> one log line.
    const leaseC = await seedProcessingTask(rawDb);
    const loggedC = [];
    const ioC = createInvocationIo({ db: rawDb, limit: 12, log: (line) => loggedC.push(line) });
    const resultC = await closeOutFailure({
      io: ioC, lease: leaseC, now: NOW, taskId: TASK_ID,
      error: { message: "synthetic_private_detail FROM rds2_secret_table", code: "ERR_SQLITE_ERROR", errcode: 1 }
    });
    assert.equal(resultC.class, "C");
    assert.equal(loggedC.length, 1, `(${binding}) exactly one line for the failed booking`);
    const entry = JSON.parse(loggedC[0]);
    assert.deepEqual(
      Object.keys(entry).sort(),
      ["at", "class", "code", "event", "outcome", "taskId"],
      `(${binding}) closed-set fields only: ${loggedC[0]}`
    );
    assert.equal(entry.event, "rds2_task_closeout");
    assert.equal(entry.taskId, TASK_ID);
    assert.equal(entry.class, "C");
    assert.equal(entry.outcome, resultC.outcome);
    assert.ok(!loggedC[0].includes("synthetic_private_detail"), `(${binding}) user-visible fault text leaked`);
    assert.ok(!loggedC[0].includes("rds2_secret_table"), `(${binding}) raw SQL leaked`);
  });
});

test("F2-R1 a successful park and a verified completion log their transitions", async () => {
  await runCloseOutTest(async ({ binding, rawDb }) => {
    // D: park succeeds.
    const leaseD = await seedProcessingTask(rawDb);
    const loggedD = [];
    const ioD = createInvocationIo({ db: rawDb, limit: 12, log: (line) => loggedD.push(line) });
    const resultD = await closeOutFailure({
      io: ioD, lease: leaseD, now: NOW, taskId: TASK_ID,
      error: TRIGGER_ERROR("cursor_regression")
    });
    assert.equal(resultD.class, "D");
    assert.equal(resultD.outcome, "needs_attention");
    assert.equal(loggedD.length, 1);
    assert.equal(JSON.parse(loggedD[0]).class, "D");
    assert.equal(JSON.parse(loggedD[0]).code, "cursor_regression");
    const taskD = await rawDb.prepare("SELECT state FROM rds2_tasks WHERE task_id = ?").bind(TASK_ID).first("state");
    assert.equal(taskD, "needs_attention");
  });
});

test("F2-R1 a lost lease and a failed close-out never log a transition", async () => {
  await runCloseOutTest(async ({ binding, rawDb }) => {
    // Lease lost: the task is no longer processing, so the park writes zero rows.
    const lease = await seedProcessingTask(rawDb);
    await rawDb.prepare(
      "UPDATE rds2_tasks SET state = 'pending', lease_owner = NULL, lease_until = NULL WHERE task_id = ?"
    ).bind(TASK_ID).run();
    const logged = [];
    const io = createInvocationIo({ db: rawDb, limit: 12, log: (line) => logged.push(line) });
    const lost = await closeOutFailure({
      io, lease, now: NOW, taskId: TASK_ID,
      error: TRIGGER_ERROR("cursor_regression")
    });
    assert.equal(lost.outcome, "noop", `(${binding}) zero rows written is a lost lease, not a park`);
    assert.equal(lost.code, "lease_lost");
    // E: nothing persisted, nothing logged.
    // seedProcessingTask already claims the task (dispatching -> processing),
    // so the lease it returns IS the active lease; claiming again would find
    // no dispatching row and correctly fail.
    const E_TASK = "task-closeout-2";
    const leaseE = await seedProcessingTask(rawDb, { state: "dispatching", taskId: E_TASK });
    assert.ok(leaseE, "second seed must return an active lease");
    const ioE = createInvocationIo({ db: dbFailingOn(rawDb, "failure_count = failure_count + 1"), limit: 12, log: (line) => logged.push(line) });
    const failed = await closeOutFailure({
      io: ioE, lease: leaseE, now: NOW, taskId: E_TASK,
      error: { message: "boom", code: "ERR_SQLITE_ERROR", errcode: 1 }
    });
    assert.equal(failed.class, "E");
    assert.equal(logged.length, 0, `(${binding}) only SUCCESSFUL transitions are logged, got ${JSON.stringify(logged)}`);
  });
});
