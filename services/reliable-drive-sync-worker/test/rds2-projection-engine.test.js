import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withD1, applySchema } from "./support/rds2-d1.js";
import { createInvocationIo } from "../src/rds2/io/invocation-io.js";
import { acceptEvent } from "../src/rds2/events/accept.js";
import { projectOne, PREDECESSOR_PROBE_SQL } from "../src/rds2/projection/engine.js";
import { continueBuild, loadProjectionHead, ensureBuild } from "../src/rds2/projection/builds.js";
import { commitProjection } from "../src/rds2/projection/commit.js";
import { algorithmReducer } from "../src/rds2/projection/algorithm.js";
import { deferTask, completeTask, failTask } from "../src/rds2/tasks/repository.js";
import { dispatchOne } from "../src/rds2/tasks/dispatcher.js";

const MIGRATION_SQL = readFileSync(fileURLToPath(
  new URL("../migrations/0006_rds2_v2_tables.sql", import.meta.url)
), "utf8");
const NOW = "2026-09-06T00:00:00.000Z";
const FUTURE_LEASE = "2026-09-06T01:00:00.000Z";
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const NAME = "乔炳源";
const PROJECTION_LIMIT = 24;

// Domain-agnostic test reducer: one topic row per event, a counting summary
// carrying the event's real identity. Supports forced rebuild and oversize.
function testReducer({ oversize = false, rebuildOn = null } = {}) {
  return {
    plan({ event, head }) {
      if (rebuildOn !== null && event.eventKey === rebuildOn) {
        return { rebuild: { reason: "test-rebuild" } };
      }
      if (oversize) {
        return {
          rowChanges: Array.from({ length: 21 }, (_, index) => ({
            rowKind: "topic", rowKey: `t-${index}`, value: { n: index }
          })),
          summary: { count: 21 }
        };
      }
      const previous = head?.summary?.count ?? 0;
      return {
        rowChanges: [{
          rowKind: "topic",
          rowKey: event.eventKey,
          sortKey: String(event.eventSeq).padStart(20, "0"),
          value: { topic: event.eventKey, eventSeq: event.eventSeq }
        }],
        summary: {
          count: previous + 1,
          identity: { userId: event.userId, username: event.username }
        }
      };
    },
    buildPage({ events, continuation }) {
      const rowChanges = events.map((event) => ({
        rowKind: "topic",
        rowKey: event.eventKey,
        sortKey: String(event.eventSeq).padStart(20, "0"),
        value: { topic: event.eventKey, eventSeq: event.eventSeq }
      }));
      const summary = { count: continuation.stagedCount + events.length };
      return {
        rowChanges,
        summary,
        continuation: { nextEventSeq: continuation.nextAfterPage, stagedCount: continuation.stagedCount + events.length }
      };
    }
  };
}

async function runProjectionTest(body) {
  await withD1(async (binding, rawDb) => {
    await applySchema(rawDb, MIGRATION_SQL);
    const sent = [];
    const makeIo = () => createInvocationIo({
      db: rawDb,
      queues: {
        RDS2_PROJECTION_QUEUE: { send: async (m) => { sent.push(m); } },
        RDS2_ARCHIVE_QUEUE: { send: async (m) => { sent.push(m); } }
      },
      fetchImpl: async () => new Response('{}', { status: 200 }),
      limit: PROJECTION_LIMIT
    });
    const io = makeIo();
    await body({ binding, rawDb, io, makeIo, sent });
  });
}

// Seeds a scope head plus events (with tasks) straight into the schema.
async function seedScope(rawDb, { userId, eventKeys, lastEventSeq = 0, revision = 0 }) {
  await rawDb.prepare(
    `INSERT INTO rds2_projections (user_id, namespace, projection_name, revision, last_event_seq,
       active_generation, building, summary_json, updated_at)
     VALUES (?, 'algorithm', 'learning', ?, ?, 0, 0, NULL, ?)
     ON CONFLICT (user_id, namespace, projection_name) DO NOTHING`
  ).bind(userId, revision, lastEventSeq, NOW).run();
  let previousSeq = 0;
  const eventSeqs = [];
  for (const eventKey of eventKeys) {
    const envelope = JSON.stringify({
      schemaVersion: "1.2",
      namespace: "algorithm",
      eventType: "algorithm.learning.completed",
      identity: { username: NAME, userId },
      payload: {
        event: {
          schemaVersion: "1.2",
          eventType: "algorithm.learning.completed",
          eventKey,
          userId,
          username: NAME
        }
      }
    });
    const inserted = await rawDb.prepare(
      `INSERT INTO rds2_events (user_id, namespace, projection_name, event_id, event_key, event_type,
         created_by_request, envelope_json, content_hash, created_at)
       VALUES (?, 'algorithm', 'learning', ?, ?, 'algorithm.learning.completed', 'seed', ?, 'c', ?)`
    ).bind(userId, `${userId}:${eventKey}`, eventKey, envelope, NOW).run();
    const eventSeq = Number(inserted.meta.last_row_id);
    eventSeqs.push(eventSeq);
    await rawDb.prepare(
      `INSERT INTO rds2_tasks (task_id, type, user_id, namespace, projection_name, event_seq, state,
         available_at, created_at, updated_at)
       VALUES (?, 'projection', ?, 'algorithm', 'learning', ?, 'pending', ?, ?, ?)`
    ).bind(`task-${userId.slice(0, 2)}-${eventSeq}`, userId, eventSeq, NOW, NOW, NOW).run();
    previousSeq = eventSeq;
  }
  return { eventSeqs };
}

async function getHead(rawDb, userId) {
  return rawDb.prepare(
    `SELECT revision, last_event_seq, active_generation, building, summary_json
     FROM rds2_projections WHERE user_id = ? AND namespace = 'algorithm' AND projection_name = 'learning'`
  ).bind(userId).first();
}

async function countRows(rawDb, { userId, generation }) {
  return Number(await rawDb.prepare(
    `SELECT COUNT(*) AS n FROM rds2_projection_rows
     WHERE user_id = ? AND namespace = 'algorithm' AND projection_name = 'learning' AND generation = ?`
  ).bind(userId, generation).first("n"));
}

async function countDeltas(rawDb, userId) {
  return Number(await rawDb.prepare(
    `SELECT COUNT(*) AS n FROM rds2_archive_deliveries
     WHERE user_id = ? AND object_type = 'projection_delta'`
  ).bind(userId).first("n"));
}

test("projectOne applies the minimal unprocessed event and completes its task atomically", async () => {
  await runProjectionTest(async ({ binding, rawDb, io, sent }) => {
    const { eventSeqs } = await seedScope(rawDb, { userId: USER_A, eventKeys: ["two-sum"] });
    const taskId = `task-11-${eventSeqs[0]}`;
    const result = await processTask(io, taskId, "consumer-1", testReducer());
    assert.equal(result.outcome, "completed", `(${binding}) ${JSON.stringify(result)}`);
    const head = await getHead(rawDb, USER_A);
    assert.equal(head.revision, 1);
    assert.equal(head.last_event_seq, eventSeqs[0]);
    assert.equal(head.building, 0);
    const summary = JSON.parse(head.summary_json);
    assert.equal(summary.count, 1);
    assert.deepEqual(summary.identity, { userId: USER_A, username: NAME });
    assert.equal(await countRows(rawDb, { userId: USER_A, generation: 0 }), 1);
    assert.equal(await countDeltas(rawDb, USER_A), 1, `(${binding}) one frozen delta`);
    const delta = await rawDb.prepare(
      `SELECT frozen_json, artifact_hash, object_type FROM rds2_archive_deliveries WHERE user_id = ?`
    ).bind(USER_A).first();
    assert.equal(delta.object_type, "projection_delta");
    const parsed = JSON.parse(delta.frozen_json);
    assert.equal(parsed.storageVersion, 2);
    assert.equal(parsed.kind, "projection_delta");
    assert.equal(parsed.baseRevision, 0);
    assert.equal(parsed.revision, 1);
    assert.equal(parsed.eventSeq, eventSeqs[0]);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(delta.frozen_json));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    assert.equal(delta.artifact_hash, hex, `(${binding}) the delta hash covers its frozen bytes`);
    const archiveTask = await rawDb.prepare(
      "SELECT type FROM rds2_tasks WHERE type = 'archive_delta'"
    ).first("type");
    assert.equal(archiveTask, "archive_delta", `(${binding}) the delta gets its own archive task`);
    const guards = await rawDb.prepare("SELECT COUNT(*) AS n FROM rds2_commit_guards").first("n");
    assert.equal(guards, 0, `(${binding}) the guard is deleted inside the same batch`);
    const taskRow = await rawDb.prepare(
      "SELECT state FROM rds2_tasks WHERE task_id = ?"
    ).bind(taskId).first("state");
    assert.equal(taskRow, "completed");
    assert.deepEqual(sent, [{ taskId, type: "projection" }], `(${binding}) only the dispatch send happens`);
  });
});

test("two users' interleaved sequences advance independently", async () => {
  await runProjectionTest(async ({ binding, rawDb, io }) => {
    const a = await seedScope(rawDb, { userId: USER_A, eventKeys: ["a-1", "a-2"] });
    const b = await seedScope(rawDb, { userId: USER_B, eventKeys: ["b-1"] });
    // Interleave: A's first event, then B's, then A's second.
    await processTask(io, `task-11-${a.eventSeqs[0]}`, "c1", testReducer());
    await processTask(io, `task-22-${b.eventSeqs[0]}`, "c2", testReducer());
    await processTask(io, `task-11-${a.eventSeqs[1]}`, "c3", testReducer());
    const headA = await getHead(rawDb, USER_A);
    const headB = await getHead(rawDb, USER_B);
    assert.equal(headA.revision, 2);
    assert.equal(headA.last_event_seq, a.eventSeqs[1]);
    assert.equal(headB.revision, 1);
    assert.equal(headB.last_event_seq, b.eventSeqs[0], `(${binding}) B's head never advances from A's events`);
  });
});

test("concurrent commits from the same base revision leave exactly one valid delta", async () => {
  await runProjectionTest(async ({ binding, rawDb, io }) => {
    const { eventSeqs } = await seedScope(rawDb, { userId: USER_A, eventKeys: ["e-1", "e-2"] });
    // Both tasks claimed before either commits — the racing window.
    const lease1 = await claimTask(io, `task-11-${eventSeqs[0]}`);
    const lease2 = await claimTask(io, `task-11-${eventSeqs[1]}`);
    const head = await loadProjectionHead(io.db, { userId: USER_A, namespace: "algorithm", projectionName: "learning" });
    assert.equal(head.revision, 0);
    const reducer = testReducer();
    const shape = (lease, seq) => ({
      eventSeq: seq, eventKey: `e-${seq}`, userId: USER_A, username: NAME
    });

    const plan1 = reducer.plan({ scope: lease1.scope, event: shape(lease1, eventSeqs[0]), head });
    await commitProjection({
      io, lease: lease1, baseRevision: 0, activeGeneration: 0,
      changes: { rowChanges: plan1.rowChanges, summary: plan1.summary, eventSeq: eventSeqs[0] }, now: NOW
    });
    const plan2 = reducer.plan({ scope: lease2.scope, event: shape(lease2, eventSeqs[1]), head });
    await assert.rejects(
      () => commitProjection({
        io, lease: lease2, baseRevision: 0, activeGeneration: 0,
        changes: { rowChanges: plan2.rowChanges, summary: plan2.summary, eventSeq: eventSeqs[1] }, now: NOW
      }),
      (error) => /stale_projection_revision|UNIQUE constraint/.test(String(error.message)),
      `(${binding}) the guard must abort the stale-revision commit`
    );
    const headAfter = await getHead(rawDb, USER_A);
    assert.equal(headAfter.revision, 1, `(${binding}) only the winner advanced the head`);
    assert.equal(await countDeltas(rawDb, USER_A), 1, `(${binding}) exactly one valid delta exists`);
    assert.equal(await countRows(rawDb, { userId: USER_A, generation: 0 }), 1);
    // The loser defers with a clean failure count.
    const deferred = await deferTask({ db: io.db, lease: lease2, now: NOW, availableAt: NOW });
    assert.equal(deferred.rowsWritten, 1);
    const task2 = await rawDb.prepare("SELECT state, failure_count FROM rds2_tasks WHERE task_id = ?")
      .bind(`task-11-${eventSeqs[1]}`).first();
    assert.equal(task2.state, "pending", `(${binding}) the loser waits for its next wake-up`);
    assert.equal(task2.failure_count, 0, `(${binding}) losing a race is not a failure`);
  });
});

async function processTask(io, taskId, owner, reducer, extra = {}) {
  const dispatched = await dispatchOne({ io, taskId, owner: `dispatch-${owner}`, now: NOW });
  assert.equal(dispatched.outcome, "continued", `dispatch failed: ${JSON.stringify(dispatched)}`);
  return projectOne({ io, taskId, owner, now: NOW, reducer, ...extra });
}

async function claimTask(io, taskId) {
  const { claimForProcessing } = await import("../src/rds2/tasks/repository.js");
  await dispatchOne({ io, taskId, owner: `dispatch-${taskId}`, now: NOW });
  return claimForProcessing({ db: io.db, taskId, owner: `owner-${taskId}`, now: NOW, leaseSeconds: 300 });
}

test("a failing write inside the commit batch rolls the whole projection back", async () => {
  await runProjectionTest(async ({ binding, rawDb, io }) => {
    const { eventSeqs } = await seedScope(rawDb, { userId: USER_A, eventKeys: ["e-1"] });
    const failingDb = {
      prepare: (sql) => rawDb.prepare(sql),
      batch: async (records) => {
        if (records.length >= 5) {
          const corrupted = [...records];
          // The head update (second-to-last statement) is forced to fail.
          corrupted[records.length - 3] = rawDb.prepare(
            // A transient storage fault, deliberately NOT a constraint
            // violation: the point of this case is an infra-level write
            // failure. (A CHECK violation is deterministic and, since G2-F2,
            // parks instead of retrying — see the classification in
            // src/rds2/errors/storage-error.js.)
            `INSERT INTO rds2_no_such_table (x) VALUES (1)`
          );
          return rawDb.batch(corrupted);
        }
        return rawDb.batch(records);
      }
    };
    const faultedIo = createInvocationIo({
      db: failingDb,
      queues: { RDS2_PROJECTION_QUEUE: { send: async () => {} }, RDS2_ARCHIVE_QUEUE: { send: async () => {} } },
      fetchImpl: async () => new Response("{}", { status: 200 }),
      limit: PROJECTION_LIMIT
    });
    const dispatched = await dispatchOne({ io: faultedIo, taskId: `task-11-${eventSeqs[0]}`, owner: "dispatch-c1", now: NOW });
    assert.equal(dispatched.outcome, "continued");
    const result = await projectOne({ io: faultedIo, taskId: `task-11-${eventSeqs[0]}`, owner: "c1", now: NOW, reducer: testReducer() });
    assert.equal(result.outcome, "retry", `(${binding}) the engine defers after a batch failure`);
    assert.equal(result.code, "deferred_commit_failed");
    const head = await getHead(rawDb, USER_A);
    assert.equal(head.revision, 0, `(${binding}) the head never advanced`);
    assert.equal(await countRows(rawDb, { userId: USER_A, generation: 0 }), 0, `(${binding}) no half-written rows`);
    assert.equal(await countDeltas(rawDb, USER_A), 0, `(${binding}) no orphan delta`);
    const task = await rawDb.prepare("SELECT state, failure_count FROM rds2_tasks WHERE task_id = ?")
      .bind(`task-11-${eventSeqs[0]}`).first();
    assert.equal(task.state, "pending", `(${binding}) the task is back to pending`);
    // G2-F2: this assertion used to be 0, which was the bug — a real storage
    // failure was never counted, so it could retry forever with no backoff and
    // never park. One failure is still retryable; it is simply counted now.
    assert.equal(task.failure_count, 1,
      `(${binding}) a real storage failure is counted and backs off, but does not park yet`);
  });
});

test("an out-of-order event defers without counting a failure", async () => {
  await runProjectionTest(async ({ binding, rawDb, io }) => {
    // Two events with a scope gap handled by seeding two events; the second
    // task is processed while the first is still pending.
    const { eventSeqs } = await seedScope(rawDb, { userId: USER_A, eventKeys: ["e-1", "e-2"] });
    const result = await processTask(io, `task-11-${eventSeqs[1]}`, "c1", testReducer());
    assert.equal(result.outcome, "retry", `(${binding}) a later event must not jump the queue`);
    assert.equal(result.code, "deferred_predecessor");
    const task = await rawDb.prepare("SELECT state, failure_count FROM rds2_tasks WHERE task_id = ?")
      .bind(`task-11-${eventSeqs[1]}`).first();
    assert.equal(task.state, "pending");
    assert.equal(task.failure_count, 0, `(${binding}) waiting for a predecessor is not a failure`);
    const head = await getHead(rawDb, USER_A);
    assert.equal(head.revision, 0);
  });
});

test("needs_attention tasks are never completed by the projection engine", async () => {
  await runProjectionTest(async ({ binding, rawDb, io }) => {
    const { eventSeqs } = await seedScope(rawDb, { userId: USER_A, eventKeys: ["e-1"] });
    const taskId = `task-11-${eventSeqs[0]}`;
    await rawDb.prepare("UPDATE rds2_tasks SET state = 'needs_attention' WHERE task_id = ?").bind(taskId).run();
    const result = await projectOne({ io, taskId, owner: "c1", now: NOW, reducer: testReducer() });
    assert.equal(result.outcome, "noop", `(${binding}) a parked task is not processed`);
    const task = await rawDb.prepare("SELECT state FROM rds2_tasks WHERE task_id = ?").bind(taskId).first("state");
    assert.equal(task, "needs_attention");
    const head = await getHead(rawDb, USER_A);
    assert.equal(head.revision, 0);
  });
});

test("rowChanges beyond the bounded limit are rejected, never truncated", async () => {
  await runProjectionTest(async ({ binding, rawDb, io }) => {
    const { eventSeqs } = await seedScope(rawDb, { userId: USER_A, eventKeys: ["e-1"] });
    await dispatchOne({ io, taskId: `task-11-${eventSeqs[0]}`, owner: "dispatch-oversize", now: NOW });
    await assert.rejects(
      () => projectOne({
        io, taskId: `task-11-${eventSeqs[0]}`, owner: "c1", now: NOW,
        reducer: testReducer({ oversize: true })
      }),
      (error) => error.code === "changes_too_large",
      `(${binding}) 21 row changes exceed the 20-row commit bound`
    );
    assert.equal(await countRows(rawDb, { userId: USER_A, generation: 0 }), 0);
    const head = await getHead(rawDb, USER_A);
    assert.equal(head.revision, 0);
  });
});

test("a rebuild decision starts a paged build and defers the task", async () => {
  await runProjectionTest(async ({ binding, rawDb, io }) => {
    const { eventSeqs } = await seedScope(rawDb, { userId: USER_A, eventKeys: ["e-1", "e-2"] });
    const result = await processTask(io, `task-11-${eventSeqs[0]}`, "c1", testReducer({ rebuildOn: "e-1" }));
    assert.equal(result.outcome, "retry", `(${binding}) the engine hands over to the build path`);
    assert.equal(result.code, "rebuild_started");
    const build = await rawDb.prepare(
      `SELECT build_id, stage, base_revision, target_event_seq, staging_generation
       FROM rds2_projection_builds WHERE user_id = ? AND stage IN ('scanning', 'activating')`
    ).bind(USER_A).first();
    assert.ok(build, `(${binding}) a running build exists`);
    assert.equal(build.stage, "scanning");
    assert.equal(build.base_revision, 0);
    assert.equal(build.staging_generation, 1);
    const head = await getHead(rawDb, USER_A);
    assert.equal(head.building, 1, `(${binding}) the head reports building`);
    assert.equal(head.active_generation, 0, `(${binding}) the old generation stays active`);
    const task = await rawDb.prepare("SELECT state FROM rds2_tasks WHERE task_id = ?")
      .bind(`task-11-${eventSeqs[0]}`).first("state");
    assert.equal(task, "pending", `(${binding}) the original task waits while the build runs`);
  });
});

test("build pages accumulate into staging and the final page activates atomically", async () => {
  await runProjectionTest(async ({ binding, rawDb, io, makeIo, sent }) => {
    const keys = Array.from({ length: 12 }, (_, index) => `e-${index}`);
    const { eventSeqs } = await seedScope(rawDb, { userId: USER_A, eventKeys: keys });
    await processTask(io, `task-11-${eventSeqs[0]}`, "c1", testReducer({ rebuildOn: "e-0" }));
    // Drive the build through its pages with a page size of 5. Each page task
    // reaches the consumer through the normal dispatch path.
    let page = 0;
    let result = null;
    while (page < 5) {
      const nextTask = await rawDb.prepare(
        `SELECT task_id FROM rds2_tasks
         WHERE type = 'projection_build' AND state = 'pending' ORDER BY task_id LIMIT 1`
      ).first("task_id");
      if (!nextTask) break;
      const pageIo = makeIo();
      await dispatchOne({ io: pageIo, taskId: nextTask, owner: `dispatch-${page}`, now: NOW });
      result = await continueBuild({ io: pageIo, taskId: nextTask, owner: `builder-${page}`, now: NOW, reducer: testReducer(), pageSize: 5 });
      page += 1;
      if (result.outcome === "completed") break;
    }
    assert.equal(result.outcome, "completed", `(${binding}) the build activated`);
    const head = await getHead(rawDb, USER_A);
    assert.equal(head.active_generation, 1, `(${binding}) the staging generation became active`);
    assert.equal(head.revision, 1, `(${binding}) the activation advanced the revision`);
    assert.equal(head.last_event_seq, Math.max(...eventSeqs), `(${binding}) only activation advances the cursor`);
    assert.equal(head.building, 0);
    assert.equal(await countRows(rawDb, { userId: USER_A, generation: 1 }), 12);
    const build = await rawDb.prepare(
      "SELECT stage FROM rds2_projection_builds WHERE user_id = ?"
    ).bind(USER_A).first("stage");
    assert.equal(build, "completed");
    const activationDelta = await rawDb.prepare(
      `SELECT object_type FROM rds2_archive_deliveries WHERE object_type = 'projection_delta'`
    ).first("object_type");
    assert.equal(activationDelta, "projection_delta", `(${binding}) the activation froze its delta`);
  });
});

test("a replayed build page does not double-contribute", async () => {
  await runProjectionTest(async ({ binding, rawDb, io, makeIo, sent }) => {
    const keys = ["e-1", "e-2", "e-3"];
    const { eventSeqs } = await seedScope(rawDb, { userId: USER_A, eventKeys: keys });
    await processTask(io, `task-11-${eventSeqs[0]}`, "c1", testReducer({ rebuildOn: "e-1" }));
    const buildTask = await rawDb.prepare(
      "SELECT task_id FROM rds2_tasks WHERE type = 'projection_build' AND state = 'pending' LIMIT 1"
    ).first("task_id");
    const firstPageIo = makeIo();
    await dispatchOne({ io: firstPageIo, taskId: buildTask, owner: "dispatch-1", now: NOW });
    await continueBuild({ io: firstPageIo, taskId: buildTask, owner: "builder-1", now: NOW, reducer: testReducer(), pageSize: 2 });
    const afterFirstPage = await countRows(rawDb, { userId: USER_A, generation: 1 });
    // Simulate a crashed page: reset the build-page task and the continuation
    // to the start of the same page, then run it again.
    await rawDb.prepare(
      `UPDATE rds2_projection_builds
       SET continuation_json = json_set(continuation_json, '$.nextEventSeq',
         (SELECT MIN(event_seq) FROM rds2_events WHERE user_id = ? AND namespace = 'algorithm' AND projection_name = 'learning'))
       WHERE user_id = ? AND stage = 'scanning'`
    ).bind(USER_A, USER_A).run();
    await rawDb.prepare(
      `INSERT INTO rds2_tasks (task_id, type, user_id, namespace, projection_name, event_seq, artifact_id,
         state, available_at, created_at, updated_at)
       VALUES ('build-replay', 'projection_build', ?, 'algorithm', 'learning', NULL, NULL, 'pending', ?, ?, ?)`
    ).bind(USER_A, NOW, NOW, NOW).run();
    const replayIo = makeIo();
    await dispatchOne({ io: replayIo, taskId: "build-replay", owner: "dispatch-replay", now: NOW });
    await continueBuild({ io: replayIo, taskId: "build-replay", owner: "builder-replay", now: NOW, reducer: testReducer(), pageSize: 2 });
    const afterReplay = await countRows(rawDb, { userId: USER_A, generation: 1 });
    assert.equal(afterReplay, afterFirstPage, `(${binding}) a replayed page must not add rows`);
  });
});

test("an event accepted through the real accept path projects end to end", async () => {
  await runProjectionTest(async ({ binding, rawDb, io }) => {
    const principal = { userId: USER_A, username: NAME };
    const receipt = await acceptEvent({
      io, principal, now: NOW,
      envelope: {
        schemaVersion: "1.2",
        namespace: "algorithm",
        eventType: "algorithm.learning.completed",
        identity: { username: NAME, userId: USER_A },
        payload: {
          event: {
            schemaVersion: "1.2",
            eventId: "44444444-4444-4444-8444-444444444444",
            eventKey: `${USER_A}:algorithm-learning:two-sum:2026-09-06T10:00:00.000Z`,
            eventType: "algorithm.learning.completed",
            userId: USER_A,
            username: NAME,
            observedAt: "2026-09-06T10:00:00.000Z",
            source: "qa",
            topic: "two-sum",
            problem: { title: "Two Sum", source: "Hot100", url: "" },
            outcome: "consulted",
            evidence: "讲解",
            tags: [],
            confidence: "medium"
          }
        },
        requestId: "req-t06-e2e"
      }
    });
    assert.equal(receipt.disposition, "accepted");
    const projectionTask = await rawDb.prepare(
      "SELECT task_id FROM rds2_tasks WHERE type = 'projection'"
    ).first("task_id");
    const result = await processTask(io, projectionTask, "consumer-1", testReducer());
    assert.equal(result.outcome, "completed", `(${binding}) ${JSON.stringify(result)}`);
    const head = await getHead(rawDb, USER_A);
    assert.equal(head.revision, 1);
    const summary = JSON.parse(head.summary_json);
    assert.deepEqual(summary.identity, { userId: USER_A, username: NAME });
  });
});

// ---------------------------------------------------------------------------
// G2-R2 regression: a build page's "read less than a full page" is NOT "done";
// the reducer may consume fewer events than fetched. Page reads are bounded by
// the frozen target and the page size is validated.
// ---------------------------------------------------------------------------

async function seedEventsThroughAccept(makeIo, rawDb, count, { topic = "t-build", idOffset = 0, allowDeferred = false, project = true, userId = USER_A, username = NAME } = {}) {
  for (let index = 1; index <= count; index += 1) {
    const eventIdNumber = idOffset + index;
    const envelope = {
      schemaVersion: "1.2",
      namespace: "algorithm",
      eventType: "algorithm.learning.completed",
      identity: { username, userId },
      payload: {
        event: {
          schemaVersion: "1.2",
          eventId: `71000000-0000-4000-8000-${String(eventIdNumber).padStart(12, "0")}`,
          eventKey: `r2-${topic}-${eventIdNumber}`,
          eventType: "algorithm.learning.completed",
          userId,
          username,
          observedAt: `2026-09-06T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
          source: "qa",
          topic,
          problem: { title: "P", source: "S", url: "" },
          outcome: "consulted",
          evidence: "e",
          tags: [],
          confidence: "medium"
        }
      },
      requestId: `req-r2-${index}-${Math.random().toString(36).slice(2, 6)}`
    };
    const receipt = await acceptEvent({ io: makeIo(), principal: { userId, username }, envelope, now: NOW });
    assert.equal(receipt.disposition, "accepted");
    // Scoped to the seeding user: interleaved users must never hand each
    // other's pending task to the wrong projection.
    const taskId = await rawDb.prepare(
      "SELECT task_id FROM rds2_tasks WHERE type = 'projection' AND user_id = ? AND state = 'pending' ORDER BY created_at DESC, task_id DESC LIMIT 1"
    ).bind(userId).first("task_id");
    if (!project) continue;
    await dispatchOne({ io: makeIo(), taskId, owner: "d", now: NOW });
    const result = await projectOne({ io: makeIo(), taskId, owner: "c", now: NOW, reducer: algorithmReducer });
    if (allowDeferred) {
      assert.ok(["completed", "retry"].includes(result.outcome), JSON.stringify(result));
    } else {
      assert.equal(result.outcome, "completed");
    }
  }
}

// Explicit-cap build driver. Every business call gets its OWN invocation io —
// the helper never resets a budget inside a call — and exhausting the cap
// without an activation FAILS instead of quietly returning a half-built
// projection (a partially consumed reducer needs far more than 8 pages).
async function drainBuildPages(makeIo, rawDb, { rounds = 40, pageSize, reducer = algorithmReducer } = {}) {
  const outcomes = [];
  let last = null;
  for (let round = 1; round <= rounds; round += 1) {
    const nextTask = await rawDb.prepare(
      "SELECT task_id FROM rds2_tasks WHERE type = 'projection_build' AND state = 'pending' ORDER BY created_at, task_id LIMIT 1"
    ).first("task_id");
    if (!nextTask) break;
    await dispatchOne({ io: makeIo(), taskId: nextTask, owner: "dispatch", now: NOW });
    last = await continueBuild({
      io: makeIo(), taskId: nextTask, owner: "builder", now: NOW, reducer,
      ...(pageSize === undefined ? {} : { pageSize })
    });
    outcomes.push({ taskId: nextTask, outcome: last.outcome, code: last.code });
    if (last.outcome === "completed") return last;
  }
  assert.fail(`the build must activate within ${rounds} page invocations, got ${JSON.stringify(outcomes)}`);
}

// Drives exactly one build page and returns its result, for scenarios that
// must observe the projection between two pages.
async function runOneBuildPage(makeIo, rawDb, { pageSize, reducer = algorithmReducer, owner = "builder" } = {}) {
  const nextTask = await rawDb.prepare(
    "SELECT task_id FROM rds2_tasks WHERE type = 'projection_build' AND state = 'pending' ORDER BY created_at, task_id LIMIT 1"
  ).first("task_id");
  assert.ok(nextTask, "a build page task must be pending");
  await dispatchOne({ io: makeIo(), taskId: nextTask, owner: "dispatch", now: NOW });
  return continueBuild({
    io: makeIo(), taskId: nextTask, owner, now: NOW, reducer,
    ...(pageSize === undefined ? {} : { pageSize })
  });
}

test("R2 six events build with the default page size counts every event", async () => {
  await runProjectionTest(async ({ binding, rawDb, io, makeIo, sent }) => {
    await seedEventsThroughAccept(makeIo, rawDb, 6);
    const head = await loadProjectionHead(io.db, { userId: USER_A, namespace: "algorithm", projectionName: "learning" });
    await ensureBuild({
      db: rawDb, scope: { userId: USER_A, namespace: "algorithm", projectionName: "learning" },
      baseRevision: head.revision, now: NOW
    });
    const last = await drainBuildPages(makeIo, rawDb);
    assert.equal(last.outcome, "completed", `(${binding}) the build activates`);
    const topic = JSON.parse(await rawDb.prepare(
      `SELECT value_json FROM rds2_projection_rows WHERE user_id = ? AND generation = 1 AND row_kind = 'topic' AND row_key = 't-build'`
    ).bind(USER_A).first("value_json"));
    assert.equal(topic.attempts, 6, `(${binding}) all six events count, got ${topic.attempts}`);
    assert.equal(head.lastEventSeq, 6);
  });
});

test("R2 a build never reads past its frozen target", async () => {
  await runProjectionTest(async ({ binding, rawDb, io, makeIo, sent }) => {
    await seedEventsThroughAccept(makeIo, rawDb, 2);
    const head = await loadProjectionHead(io.db, { userId: USER_A, namespace: "algorithm", projectionName: "learning" });
    await ensureBuild({
      db: rawDb, scope: { userId: USER_A, namespace: "algorithm", projectionName: "learning" },
      baseRevision: head.revision, now: NOW
    });
    // A third event arrives after the build froze its target.
    // The late event defers while the build is running (building = 1).
    await seedEventsThroughAccept(makeIo, rawDb, 1, { topic: "t-late", idOffset: 100, allowDeferred: true });
    const last = await drainBuildPages(makeIo, rawDb);
    assert.equal(last.outcome, "completed", `(${binding}) the build activates`);
    const staged = await rawDb.prepare(
      `SELECT value_json FROM rds2_projection_rows WHERE user_id = ? AND generation = 1 AND row_kind = 'topic' AND row_key = 't-late'`
    ).bind(USER_A).first("value_json");
    assert.equal(staged, null, `(${binding}) the late event must not be computed into the frozen build`);
    const built = await loadProjectionHead(io.db, { userId: USER_A, namespace: "algorithm", projectionName: "learning" });
    assert.equal(built.lastEventSeq, head.lastEventSeq, `(${binding}) activation advances exactly to the frozen target`);
  });
});

test("R2 the build page size is validated and capped at 50", async () => {
  await runProjectionTest(async ({ binding, rawDb, io, makeIo, sent }) => {
    await seedEventsThroughAccept(makeIo, rawDb, 2);
    const head = await loadProjectionHead(io.db, { userId: USER_A, namespace: "algorithm", projectionName: "learning" });
    await ensureBuild({
      db: rawDb, scope: { userId: USER_A, namespace: "algorithm", projectionName: "learning" },
      baseRevision: head.revision, now: NOW
    });
    const nextTask = await rawDb.prepare(
      "SELECT task_id FROM rds2_tasks WHERE type = 'projection_build' AND state = 'pending' LIMIT 1"
    ).first("task_id");
    await dispatchOne({ io: makeIo(), taskId: nextTask, owner: "dispatch", now: NOW });
    await assert.rejects(
      () => continueBuild({ io: makeIo(), taskId: nextTask, owner: "builder", now: NOW, reducer: algorithmReducer, pageSize: 51 }),
      (error) => error.code === "invalid_page_size",
      `(${binding}) a page size above 50 must be rejected`
    );
  });
});

// ---------------------------------------------------------------------------
// G2-R2 (验收调整): the event-count boundaries at the DEFAULT page size, the
// cross-user sequence hole, events appended between pages, and a reducer that
// claims to have consumed more than the page it was handed.
// ---------------------------------------------------------------------------

const SCOPE_A = { userId: USER_A, namespace: "algorithm", projectionName: "learning" };

for (const eventCount of [0, 1, 5, 6, 49, 50, 51]) {
  test(`R2 a ${eventCount}-event build with the default page size counts every event`, async () => {
    await runProjectionTest(async ({ binding, rawDb, io, makeIo }) => {
      if (eventCount === 0) {
        // A legal empty head: no events, nothing projected, nothing building.
        await seedScope(rawDb, { userId: USER_A, eventKeys: [] });
      } else {
        await seedEventsThroughAccept(makeIo, rawDb, eventCount);
      }
      const before = await loadProjectionHead(io.db, SCOPE_A);
      await ensureBuild({ db: rawDb, scope: SCOPE_A, baseRevision: before.revision, now: NOW });
      // page size is deliberately omitted: the real default must be exercised.
      const last = await drainBuildPages(makeIo, rawDb);
      assert.equal(last.outcome, "completed", `(${binding}) the build activates`);
      const after = await loadProjectionHead(io.db, SCOPE_A);
      assert.equal(after.lastEventSeq, eventCount, `(${binding}) the cursor lands exactly on the frozen target`);
      assert.equal(after.revision, before.revision + 1, `(${binding}) the revision advances exactly once`);
      const pending = await rawDb.prepare(
        "SELECT COUNT(*) AS n FROM rds2_tasks WHERE type = 'projection_build' AND state = 'pending'"
      ).first("n");
      assert.equal(pending, 0, `(${binding}) no unfinished paging task is left behind`);
      if (eventCount === 0) return;
      const topic = JSON.parse(await rawDb.prepare(
        `SELECT value_json FROM rds2_projection_rows
          WHERE user_id = ? AND generation = ? AND row_kind = 'topic' AND row_key = 't-build'`
      ).bind(USER_A, after.activeGeneration).first("value_json"));
      assert.equal(topic.attempts, eventCount, `(${binding}) every event is counted exactly once`);
      assert.equal(after.summary.counts.attempts, eventCount, `(${binding}) the summary agrees with the rows`);
    });
  });
}

test("R2 a build of one user ignores the other user's interleaved sequence numbers", async () => {
  await runProjectionTest(async ({ binding, rawDb, io, makeIo }) => {
    // event_seq is global, so A owns 1,3,5 and B owns 2,4,6: A's sequence
    // RANGE is five wide while A actually owns three events.
    for (let index = 1; index <= 3; index += 1) {
      await seedEventsThroughAccept(makeIo, rawDb, 1, { userId: USER_A, topic: "t-a", idOffset: index });
      await seedEventsThroughAccept(makeIo, rawDb, 1, { userId: USER_B, topic: "t-b", idOffset: 100 + index });
    }
    const before = await loadProjectionHead(io.db, SCOPE_A);
    await ensureBuild({ db: rawDb, scope: SCOPE_A, baseRevision: before.revision, now: NOW });
    const last = await drainBuildPages(makeIo, rawDb);
    assert.equal(last.outcome, "completed", `(${binding}) A's build activates`);
    const after = await loadProjectionHead(io.db, SCOPE_A);
    assert.equal(after.lastEventSeq, 5, `(${binding}) A's cursor is A's own last event, not the global count`);
    const topicA = JSON.parse(await rawDb.prepare(
      `SELECT value_json FROM rds2_projection_rows
        WHERE user_id = ? AND generation = ? AND row_kind = 'topic' AND row_key = 't-a'`
    ).bind(USER_A, after.activeGeneration).first("value_json"));
    assert.equal(topicA.attempts, 3, `(${binding}) the global sequence gap must not inflate A's count`);
    // B's data never leaks into A's build.
    const leaked = await rawDb.prepare(
      `SELECT COUNT(*) AS n FROM rds2_projection_rows
        WHERE user_id = ? AND generation = ? AND row_key = 't-b'`
    ).bind(USER_A, after.activeGeneration).first("n");
    assert.equal(leaked, 0, `(${binding}) the build must not read the other user's events`);
    const headB = await loadProjectionHead(io.db, { userId: USER_B, namespace: "algorithm", projectionName: "learning" });
    assert.equal(headB.lastEventSeq, 6, `(${binding}) B's projection is untouched`);
  });
});

test("R2 events appended between build pages are counted neither early nor lost", async () => {
  await runProjectionTest(async ({ binding, rawDb, io, makeIo }) => {
    await seedEventsThroughAccept(makeIo, rawDb, 8);
    const before = await loadProjectionHead(io.db, SCOPE_A);
    await ensureBuild({ db: rawDb, scope: SCOPE_A, baseRevision: before.revision, now: NOW });
    const firstPage = await runOneBuildPage(makeIo, rawDb);
    assert.equal(firstPage.outcome, "continued", `(${binding}) eight events span more than one page at the default size`);
    // Appended between two pages — after the target was frozen.
    await seedEventsThroughAccept(makeIo, rawDb, 1, { topic: "t-late", idOffset: 200, allowDeferred: true });
    const last = await drainBuildPages(makeIo, rawDb);
    assert.equal(last.outcome, "completed", `(${binding}) the build activates`);
    const built = await loadProjectionHead(io.db, SCOPE_A);
    assert.equal(built.lastEventSeq, 8, `(${binding}) activation stops at the frozen target`);
    const lateDuringBuild = await rawDb.prepare(
      `SELECT value_json FROM rds2_projection_rows
        WHERE user_id = ? AND generation = ? AND row_kind = 'topic' AND row_key = 't-late'`
    ).bind(USER_A, built.activeGeneration).first("value_json");
    assert.equal(lateDuringBuild, null, `(${binding}) the appended event is not counted into the frozen build`);

    // ... and it is not lost either: it projects after the activation.
    const lateSeq = await rawDb.prepare(
      "SELECT event_seq FROM rds2_events WHERE user_id = ? ORDER BY event_seq DESC LIMIT 1"
    ).bind(USER_A).first("event_seq");
    const lateTask = await rawDb.prepare(
      "SELECT task_id FROM rds2_tasks WHERE type = 'projection' AND user_id = ? AND event_seq = ?"
    ).bind(USER_A, Number(lateSeq)).first("task_id");
    await dispatchOne({ io: makeIo(), taskId: lateTask, owner: "d", now: NOW });
    const projected = await projectOne({ io: makeIo(), taskId: lateTask, owner: "c", now: NOW, reducer: algorithmReducer });
    assert.equal(projected.outcome, "completed", `(${binding}) the appended event is processed after activation`);
    const after = await loadProjectionHead(io.db, SCOPE_A);
    assert.equal(after.lastEventSeq, 9, `(${binding}) the cursor picks the appended event up`);
    const lateNow = JSON.parse(await rawDb.prepare(
      `SELECT value_json FROM rds2_projection_rows
        WHERE user_id = ? AND generation = ? AND row_kind = 'topic' AND row_key = 't-late'`
    ).bind(USER_A, after.activeGeneration).first("value_json"));
    assert.equal(lateNow.attempts, 1, `(${binding}) the appended event counts exactly once`);
  });
});

test("R2 a reducer that claims to have consumed past the page it was handed is refused", async () => {
  await runProjectionTest(async ({ binding, rawDb, io, makeIo }) => {
    await seedEventsThroughAccept(makeIo, rawDb, 6);
    const before = await loadProjectionHead(io.db, SCOPE_A);
    await ensureBuild({ db: rawDb, scope: SCOPE_A, baseRevision: before.revision, now: NOW });
    // The page offers events 1..2; the reducer claims to have consumed four.
    const overreaching = {
      ...algorithmReducer,
      buildPage: (args) => {
        const result = algorithmReducer.buildPage(args);
        return {
          ...result,
          continuation: { ...result.continuation, nextEventSeq: args.continuation.nextAfterPage + 2 }
        };
      }
    };
    const result = await runOneBuildPage(makeIo, rawDb, { pageSize: 2, reducer: overreaching });
    assert.equal(result.outcome, "needs_attention",
      `(${binding}) a cursor past the fetched page is a reducer contract violation, got ${JSON.stringify(result)}`);
    assert.equal(result.code, "build_no_progress");
    const after = await loadProjectionHead(io.db, SCOPE_A);
    assert.equal(after.revision, before.revision, `(${binding}) nothing activates on a broken cursor`);
    const task = await rawDb.prepare(
      "SELECT state FROM rds2_tasks WHERE type = 'projection_build' ORDER BY created_at LIMIT 1"
    ).first("state");
    assert.equal(task, "needs_attention", `(${binding}) the page parks instead of skipping events`);
  });
});

// A reducer that emits a chosen number of rows of a chosen size, so the
// page-level caps can be probed on an INTERMEDIATE page (not just the last).
function cappedReducer({ rowCount, valueSize }) {
  return {
    ...algorithmReducer,
    buildPage: ({ events, continuation }) => ({
      rowChanges: Array.from({ length: rowCount }, (_, index) => ({
        rowKind: "topic", rowKey: `cap-${index}`, value: { blob: "x".repeat(valueSize) }
      })),
      summary: { counts: { attempts: events.length } },
      continuation: { nextEventSeq: continuation.nextAfterPage, stagedCount: events.length }
    })
  };
}

for (const [label, reducer, note] of [
  ["more than 20 row changes", cappedReducer({ rowCount: 21, valueSize: 8 }), "row count"],
  ["a row value beyond 64 KiB", cappedReducer({ rowCount: 1, valueSize: 64 * 1024 }), "row unit"],
  ["a package beyond 256 KiB", cappedReducer({ rowCount: 20, valueSize: 13 * 1024 }), "package"]
]) {
  test(`R2 an intermediate page with ${label} is refused, never truncated`, async () => {
    await runProjectionTest(async ({ binding, rawDb, io, makeIo }) => {
      await seedEventsThroughAccept(makeIo, rawDb, 2);
      const before = await loadProjectionHead(io.db, SCOPE_A);
      const build = await ensureBuild({ db: rawDb, scope: SCOPE_A, baseRevision: before.revision, now: NOW });
      const pageTask = await rawDb.prepare(
        "SELECT task_id FROM rds2_tasks WHERE type = 'projection_build' AND state = 'pending' LIMIT 1"
      ).first("task_id");
      await dispatchOne({ io: makeIo(), taskId: pageTask, owner: "dispatch", now: NOW });
      await assert.rejects(
        () => continueBuild({ io: makeIo(), taskId: pageTask, owner: "builder", now: NOW, reducer }),
        (error) => error.code === "changes_too_large",
        `(${binding}) the ${note} cap must be a hard refusal`
      );
      const after = await loadProjectionHead(io.db, SCOPE_A);
      assert.equal(after.revision, before.revision, `(${binding}) nothing is committed`);
      const staged = await rawDb.prepare(
        "SELECT COUNT(*) AS n FROM rds2_projection_rows WHERE user_id = ? AND generation = ?"
      ).bind(USER_A, after.activeGeneration + 1).first("n");
      assert.equal(staged, 0, `(${binding}) an oversized page must not be partially staged`);
      const stage = await rawDb.prepare("SELECT stage FROM rds2_projection_builds WHERE build_id = ?")
        .bind(build.build_id).first("stage");
      assert.equal(stage, "scanning", `(${binding}) the build survives for a corrected retry`);
    });
  });
}

// ---------------------------------------------------------------------------
// G2-R3 regression: events already inside the authoritative cursor converge
// their stale tasks without re-applying, and the head cursor can never move
// backwards — enforced by the database, not only by pre-checks.
// ---------------------------------------------------------------------------

test("R3 a stale projection task converges without re-applying its event", async () => {
  await runProjectionTest(async ({ binding, rawDb, io, makeIo, sent }) => {
    // Both events stay pending: the build covers them and advances the cursor.
    await seedEventsThroughAccept(makeIo, rawDb, 2, { project: false });
    const headBefore = await loadProjectionHead(io.db, { userId: USER_A, namespace: "algorithm", projectionName: "learning" });
    const taskIds = await rawDb.prepare(
      "SELECT task_id FROM rds2_tasks WHERE type = 'projection' ORDER BY task_id"
    ).all();
    await ensureBuild({
      db: rawDb, scope: { userId: USER_A, namespace: "algorithm", projectionName: "learning" },
      baseRevision: headBefore.revision, now: NOW
    });
    const last = await drainBuildPages(makeIo, rawDb);
    assert.equal(last.outcome, "completed");
    const attemptsBefore = JSON.parse(await rawDb.prepare(
      `SELECT value_json FROM rds2_projection_rows WHERE user_id = ? AND generation = 1 AND row_kind = 'topic' AND row_key = 't-build'`
    ).bind(USER_A).first("value_json")).attempts;
    assert.equal(attemptsBefore, 2);
    const deltasBefore = await rawDb.prepare(
      "SELECT COUNT(*) AS n FROM rds2_archive_deliveries WHERE object_type = 'projection_delta'"
    ).first("n");
    const revisionAfterBuild = (await loadProjectionHead(io.db, { userId: USER_A, namespace: "algorithm", projectionName: "learning" })).revision;

    // The covered (still pending) projection tasks get dispatched afterwards.
    for (const row of taskIds.results) {
      await dispatchOne({ io: makeIo(), taskId: row.task_id, owner: "d", now: NOW });
      const result = await projectOne({ io: makeIo(), taskId: row.task_id, owner: "c", now: NOW, reducer: algorithmReducer });
      assert.equal(result.outcome, "completed", `(${binding}) the stale task converges`);
      assert.equal(result.code, "already_applied");
    }
    const headAfter = await loadProjectionHead(io.db, { userId: USER_A, namespace: "algorithm", projectionName: "learning" });
    assert.equal(headAfter.lastEventSeq, headBefore.lastEventSeq + 2, `(${binding}) the cursor stays at the build target`);
    assert.equal(headAfter.revision, revisionAfterBuild, `(${binding}) no extra revision`);
    const attemptsAfter = JSON.parse(await rawDb.prepare(
      `SELECT value_json FROM rds2_projection_rows WHERE user_id = ? AND generation = 1 AND row_kind = 'topic' AND row_key = 't-build'`
    ).bind(USER_A).first("value_json")).attempts;
    assert.equal(attemptsAfter, attemptsBefore, `(${binding}) no double counting`);
    const deltasAfter = await rawDb.prepare(
      "SELECT COUNT(*) AS n FROM rds2_archive_deliveries WHERE object_type = 'projection_delta'"
    ).first("n");
    assert.equal(Number(deltasAfter), Number(deltasBefore), `(${binding}) no duplicate delta`);
  });
});
test("R3 the head cursor regression is aborted by the database", async () => {
  await runProjectionTest(async ({ binding, rawDb, io, makeIo, sent }) => {
    await seedEventsThroughAccept(makeIo, rawDb, 2);
    await assert.rejects(
      () => rawDb.prepare(
        `UPDATE rds2_projections SET last_event_seq = 1 WHERE user_id = ?`
      ).bind(USER_A).run(),
      /cursor_regression/,
      `(${binding}) last_event_seq must never move backwards`
    );
  });
});

// ---------------------------------------------------------------------------
// G2-R4 regression: build startup is a transactional CAS on the base
// revision, a base-moved build aborts diagnostically instead of deferring
// forever, page tasks bind their build and converge, and a lost lease never
// reports success.
// ---------------------------------------------------------------------------

test("R4 ensureBuild refuses a stale base revision atomically", async () => {
  await runProjectionTest(async ({ binding, rawDb, io, makeIo, sent }) => {
    await seedEventsThroughAccept(makeIo, rawDb, 2, { project: false });
    // The caller read revision 0, but the head moved before the CAS landed.
    await rawDb.prepare(
      `UPDATE rds2_projections SET revision = 1, last_event_seq = 2 WHERE user_id = ?`
    ).bind(USER_A).run();
    await assert.rejects(
      () => ensureBuild({
        db: rawDb, scope: { userId: USER_A, namespace: "algorithm", projectionName: "learning" },
        baseRevision: 0, now: NOW
      }),
      (error) => error.code === "build_base_moved",
      `(${binding}) a stale base must not create a build`
    );
    const builds = await rawDb.prepare(
      "SELECT COUNT(*) AS n FROM rds2_projection_builds"
    ).first("n");
    assert.equal(Number(builds), 0, `(${binding}) no build row may exist`);
    const head = await loadProjectionHead(io.db, { userId: USER_A, namespace: "algorithm", projectionName: "learning" });
    assert.equal(head.building, 0, `(${binding}) the building flag stays unset`);
  });
});

test("R4 a build whose base moved aborts diagnostically and releases the scope", async () => {
  await runProjectionTest(async ({ binding, rawDb, io, makeIo, sent }) => {
    await seedEventsThroughAccept(makeIo, rawDb, 2, { project: false });
    await ensureBuild({
      db: rawDb, scope: { userId: USER_A, namespace: "algorithm", projectionName: "learning" },
      baseRevision: 0, now: NOW
    });
    // The base moved underneath the running build.
    await rawDb.prepare(
      `UPDATE rds2_projections SET revision = 1, last_event_seq = 2 WHERE user_id = ?`
    ).bind(USER_A).run();
    const nextTask = await rawDb.prepare(
      "SELECT task_id FROM rds2_tasks WHERE type = 'projection_build' AND state = 'pending' LIMIT 1"
    ).first("task_id");
    await dispatchOne({ io: makeIo(), taskId: nextTask, owner: "dispatch", now: NOW });
    const result = await continueBuild({ io: makeIo(), taskId: nextTask, owner: "builder", now: NOW, reducer: algorithmReducer });
    assert.equal(result.outcome, "retry", `(${binding}) the moved build is diagnosable`);
    assert.equal(result.code, "deferred_build_aborted");
    const build = await rawDb.prepare("SELECT stage FROM rds2_projection_builds").first("stage");
    assert.equal(build, "aborted", `(${binding}) the stale build is aborted`);
    const head = await loadProjectionHead(io.db, { userId: USER_A, namespace: "algorithm", projectionName: "learning" });
    assert.equal(head.building, 0, `(${binding}) the building flag is released`);
    const task = await rawDb.prepare("SELECT state FROM rds2_tasks WHERE task_id = ?").bind(nextTask).first("state");
    assert.equal(task, "pending", `(${binding}) the page task waits for a fresh decision`);
  });
});

test("R4 a page task whose build is already settled converges itself", async () => {
  await runProjectionTest(async ({ binding, rawDb, io, makeIo, sent }) => {
    await seedEventsThroughAccept(makeIo, rawDb, 2, { project: false });
    await ensureBuild({
      db: rawDb, scope: { userId: USER_A, namespace: "algorithm", projectionName: "learning" },
      baseRevision: 0, now: NOW
    });
    await drainBuildPages(makeIo, rawDb);
    // A duplicate page task arrives after the build completed.
    await rawDb.prepare(
      `INSERT INTO rds2_tasks (task_id, type, user_id, namespace, projection_name, event_seq, artifact_id,
         state, available_at, payload_json, created_at, updated_at)
       VALUES ('build-dup', 'projection_build', ?, 'algorithm', 'learning', NULL, NULL, 'pending', ?, '{"buildId":"any-build"}', ?, ?)`
    ).bind(USER_A, NOW, NOW, NOW).run();
    await dispatchOne({ io: makeIo(), taskId: "build-dup", owner: "dispatch", now: NOW });
    const result = await continueBuild({ io: makeIo(), taskId: "build-dup", owner: "builder", now: NOW, reducer: algorithmReducer });
    assert.equal(result.outcome, "completed", `(${binding}) the duplicate page task converges`);
    assert.equal(result.code, "build_already_settled");
    const task = await rawDb.prepare("SELECT state FROM rds2_tasks WHERE task_id = ?").bind("build-dup").first("state");
    assert.equal(task, "completed", `(${binding}) the duplicate task must not stay processing`);
  });
});

test("R3 a duplicate queue message for an already applied event converges", async () => {
  await runProjectionTest(async ({ binding, rawDb, io, makeIo }) => {
    await seedEventsThroughAccept(makeIo, rawDb, 2, { project: false });
    const taskIds = (await rawDb.prepare(
      "SELECT task_id, event_seq FROM rds2_tasks WHERE type = 'projection' ORDER BY event_seq"
    ).all()).results;
    const firstTask = taskIds[0].task_id;
    await dispatchOne({ io: makeIo(), taskId: firstTask, owner: "d", now: NOW });
    const applied = await projectOne({ io: makeIo(), taskId: firstTask, owner: "c", now: NOW, reducer: algorithmReducer });
    assert.equal(applied.outcome, "completed", `(${binding}) the first delivery applies`);
    const before = await loadProjectionHead(io.db, SCOPE_A);
    const deltasBefore = await countDeltas(rawDb, USER_A);
    const rowBefore = await rawDb.prepare(
      `SELECT value_json FROM rds2_projection_rows WHERE user_id = ? AND generation = ?
        AND row_kind = 'topic' AND row_key = 't-build'`
    ).bind(USER_A, before.activeGeneration).first("value_json");

    // The queue delivers the very same message again — out of order, after the
    // task already completed. Re-queued explicitly so the consumer really
    // reaches the "already applied" decision instead of merely failing to
    // claim a completed task.
    await rawDb.prepare(
      `UPDATE rds2_tasks SET state = 'pending', lease_owner = NULL, lease_until = NULL,
         lease_epoch = lease_epoch + 1, available_at = ?, updated_at = ? WHERE task_id = ?`
    ).bind(NOW, NOW, firstTask).run();
    await dispatchOne({ io: makeIo(), taskId: firstTask, owner: "d", now: NOW });
    const duplicate = await projectOne({ io: makeIo(), taskId: firstTask, owner: "c", now: NOW, reducer: algorithmReducer });
    assert.equal(duplicate.outcome, "completed",
      `(${binding}) a duplicate message converges to a completed task, got ${JSON.stringify(duplicate)}`);
    assert.equal(duplicate.code, "already_applied",
      `(${binding}) without re-applying the event, got ${JSON.stringify(duplicate)}`);
    const after = await loadProjectionHead(io.db, SCOPE_A);
    assert.equal(after.revision, before.revision, `(${binding}) the revision is unchanged`);
    assert.equal(await countDeltas(rawDb, USER_A), deltasBefore, `(${binding}) no extra delta is archived`);
    const rowAfter = await rawDb.prepare(
      `SELECT value_json FROM rds2_projection_rows WHERE user_id = ? AND generation = ?
        AND row_kind = 'topic' AND row_key = 't-build'`
    ).bind(USER_A, after.activeGeneration).first("value_json");
    assert.equal(rowAfter, rowBefore, `(${binding}) the projected value is untouched`);
  });
});

// ---------------------------------------------------------------------------
// G2 acceptance correction: the probe row "old owner completes after losing
// the lease" needs its own BUILD case. A settled-build task or an archive
// task losing its lease is not the same assertion: here the old owner is
// inside the activation path when the lease moves.
// ---------------------------------------------------------------------------

// Hands the lease to a new owner immediately before the guard batch runs —
// i.e. after the old owner already read the head and staged its page.
function leaseStealingIo(io, rawDb, taskId, newOwner = "new-owner") {
  const inner = io.db;
  return {
    ...io,
    db: {
      prepare: (sql) => inner.prepare(sql),
      batch: async (statements) => {
        await rawDb.prepare(
          `UPDATE rds2_tasks SET lease_owner = ?, lease_epoch = lease_epoch + 1, lease_until = ?, updated_at = ?
           WHERE task_id = ? AND state = 'processing'`
        ).bind(newOwner, "2999-01-01T00:00:00.000Z", NOW, taskId).run();
        return inner.batch(statements);
      }
    }
  };
}

test("R4 an owner that loses the lease before the activation guard commits cannot report success", async () => {
  await runProjectionTest(async ({ binding, rawDb, io, makeIo }) => {
    await seedEventsThroughAccept(makeIo, rawDb, 2);
    const before = await loadProjectionHead(io.db, SCOPE_A);
    const build = await ensureBuild({ db: rawDb, scope: SCOPE_A, baseRevision: before.revision, now: NOW });
    const pageTask = await rawDb.prepare(
      "SELECT task_id FROM rds2_tasks WHERE type = 'projection_build' AND state = 'pending' ORDER BY created_at, task_id LIMIT 1"
    ).first("task_id");
    await dispatchOne({ io: makeIo(), taskId: pageTask, owner: "old-owner", now: NOW });

    const result = await continueBuild({
      io: leaseStealingIo(makeIo(), rawDb, pageTask), taskId: pageTask,
      owner: "old-owner", now: NOW, reducer: algorithmReducer
    });
    assert.notEqual(result.outcome, "completed",
      `(${binding}) losing the lease is never an activation, got ${JSON.stringify(result)}`);
    assert.equal(result.code, "lease_lost", `(${binding}) the loss is diagnosed`);

    // The new owner's lease is intact: the old owner did not complete, defer
    // or overwrite anything behind its back.
    const task = await rawDb.prepare(
      "SELECT state, lease_owner FROM rds2_tasks WHERE task_id = ?"
    ).bind(pageTask).first();
    assert.equal(task.lease_owner, "new-owner", `(${binding}) the new owner still holds the lease`);
    assert.notEqual(task.state, "completed", `(${binding}) the old owner must not complete the task`);

    // No activation residue: head, generation and cursor are unchanged and no
    // activation delta was archived.
    const after = await loadProjectionHead(io.db, SCOPE_A);
    assert.equal(after.revision, before.revision, `(${binding}) the revision did not move`);
    assert.equal(after.activeGeneration, before.activeGeneration, `(${binding}) the generation did not switch`);
    assert.equal(after.lastEventSeq, before.lastEventSeq, `(${binding}) the cursor did not advance`);
    const buildRow = await rawDb.prepare("SELECT stage FROM rds2_projection_builds WHERE build_id = ?")
      .bind(build.build_id).first("stage");
    assert.equal(buildRow, "scanning", `(${binding}) the build is still running, not activated`);
    // The two seeded events each archived their own normal delta; only a delta
    // carrying the build manifest would be an activation.
    const activationDeltas = (await rawDb.prepare(
      "SELECT frozen_json FROM rds2_archive_deliveries WHERE object_type = 'projection_delta'"
    ).all()).results.map((row) => JSON.parse(row.frozen_json)).filter((delta) => delta.build);
    assert.equal(activationDeltas.length, 0, `(${binding}) no activation delta was written by the old owner`);
    const guards = await rawDb.prepare("SELECT COUNT(*) AS n FROM rds2_commit_guards").first("n");
    assert.equal(guards, 0, `(${binding}) the aborted guard left nothing behind`);

    // And the scope is not wedged: once the queue hands the page to the new
    // owner, the very same build still activates on the frozen target.
    await rawDb.prepare(
      `UPDATE rds2_tasks SET state = 'pending', lease_owner = NULL, lease_epoch = lease_epoch + 1,
         lease_until = NULL, available_at = ?, updated_at = ? WHERE task_id = ?`
    ).bind(NOW, NOW, pageTask).run();
    const dispatchResult = await dispatchOne({ io: makeIo(), taskId: pageTask, owner: "new-owner", now: NOW });
    assert.equal(dispatchResult.outcome, "continued",
      `(${binding}) the queue can still hand the page to the new owner, got ${JSON.stringify(dispatchResult)}`);
    const finished = await continueBuild({
      io: makeIo(), taskId: pageTask, owner: "new-owner", now: NOW, reducer: algorithmReducer
    });
    assert.equal(finished.outcome, "completed",
      `(${binding}) the new owner activates the build, got ${JSON.stringify(finished)} after ${JSON.stringify(dispatchResult)}`);
    const settled = await loadProjectionHead(io.db, SCOPE_A);
    assert.equal(settled.lastEventSeq, 2, `(${binding}) and lands on the frozen target`);
  });
});

test("R4 two build starts on one scope leave exactly one running build", async () => {
  await runProjectionTest(async ({ binding, rawDb, io, makeIo }) => {
    await seedEventsThroughAccept(makeIo, rawDb, 2, { project: false });
    const head = await loadProjectionHead(io.db, SCOPE_A);
    const first = await ensureBuild({ db: rawDb, scope: SCOPE_A, baseRevision: head.revision, now: NOW });
    const second = await ensureBuild({ db: rawDb, scope: SCOPE_A, baseRevision: head.revision, now: NOW });
    assert.equal(second.build_id, first.build_id, `(${binding}) a second start joins the running build`);
    const builds = await rawDb.prepare("SELECT COUNT(*) AS n FROM rds2_projection_builds").first("n");
    assert.equal(builds, 1, `(${binding}) never two running builds for one scope`);
    const pages = await rawDb.prepare(
      "SELECT COUNT(*) AS n FROM rds2_tasks WHERE type = 'projection_build'"
    ).first("n");
    assert.equal(pages, 1, `(${binding}) and only one first page task`);
    const after = await loadProjectionHead(io.db, SCOPE_A);
    assert.equal(after.building, 1, `(${binding}) the building flag is set once`);
  });
});

// A transient storage error is neither a stale write nor a deterministic
// contract error: it must go back to the queue, never to a permanent park.
function failingBatchIo(io, message = "storage_unavailable") {
  const inner = io.db;
  return {
    ...io,
    db: {
      prepare: (sql) => inner.prepare(sql),
      batch: async () => { throw new Error(message); }
    }
  };
}

test("R4 a transient storage failure during the build commit defers instead of parking", async () => {
  await runProjectionTest(async ({ binding, rawDb, io, makeIo }) => {
    await seedEventsThroughAccept(makeIo, rawDb, 2);
    const before = await loadProjectionHead(io.db, SCOPE_A);
    const build = await ensureBuild({ db: rawDb, scope: SCOPE_A, baseRevision: before.revision, now: NOW });
    const pageTask = await rawDb.prepare(
      "SELECT task_id FROM rds2_tasks WHERE type = 'projection_build' AND state = 'pending' LIMIT 1"
    ).first("task_id");
    await dispatchOne({ io: makeIo(), taskId: pageTask, owner: "dispatch", now: NOW });
    const result = await continueBuild({
      io: failingBatchIo(makeIo()), taskId: pageTask, owner: "builder", now: NOW, reducer: algorithmReducer
    });
    assert.equal(result.outcome, "retry", `(${binding}) a storage error is retryable, got ${JSON.stringify(result)}`);
    assert.equal(result.code, "deferred_commit_failed");
    const task = await rawDb.prepare("SELECT state FROM rds2_tasks WHERE task_id = ?").bind(pageTask).first("state");
    assert.equal(task, "pending", `(${binding}) the page goes back to the queue, not to needs_attention`);
    const stage = await rawDb.prepare("SELECT stage FROM rds2_projection_builds WHERE build_id = ?")
      .bind(build.build_id).first("stage");
    assert.equal(stage, "scanning", `(${binding}) the build is not abandoned`);
    const after = await loadProjectionHead(io.db, SCOPE_A);
    assert.equal(after.revision, before.revision, `(${binding}) nothing was committed`);
  });
});

// ---------------------------------------------------------------------------
// G2 coverage fix: the "is there an unprocessed predecessor?" question is
// answered by a bounded indexed existence probe over the EVENT TABLE, not by
// counting a range, and the cost must not grow with the backlog.
// ---------------------------------------------------------------------------

// The engine's real statement — the test plans what the engine runs.

// Seeds `count` real event-table rows (D1 caps bound variables at 100, so the
// tuples go in batches) and returns the highest event_seq written.
async function seedEventBacklog(rawDb, userId, count) {
  let highest = 0;
  const batchSize = 9;
  for (let offset = 0; offset < count; offset += batchSize) {
    const size = Math.min(batchSize, count - offset);
    const tuples = Array.from({ length: size }, () =>
      `(?, 'algorithm', 'learning', ?, ?, 'algorithm.learning.completed', 'seed', ?, 'seed-hash', ?)`).join(",");
    const params = [];
    for (let index = 0; index < size; index += 1) {
      const ordinal = offset + index + 1;
      params.push(
        userId,
        `73000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`,
        `${userId}:backlog:${ordinal}`,
        JSON.stringify({
          schemaVersion: "1.2",
          payload: {
            event: {
              schemaVersion: "1.2",
              eventType: "algorithm.learning.completed",
              eventKey: `${userId}:backlog:${ordinal}`,
              userId,
              username: NAME,
              topic: "backlog",
              outcome: "consulted",
              observedAt: NOW
            }
          }
        }),
        NOW
      );
    }
    const result = await rawDb.prepare(
      `INSERT INTO rds2_events (user_id, namespace, projection_name, event_id, event_key, event_type,
         created_by_request, envelope_json, content_hash, created_at) VALUES ${tuples}`
    ).bind(...params).run();
    highest = Number(result.meta.last_row_id);
  }
  return highest;
}

function backlogEnvelope(userId, ordinal) {
  return {
    schemaVersion: "1.2",
    namespace: "algorithm",
    eventType: "algorithm.learning.completed",
    identity: { username: NAME, userId },
    payload: {
      event: {
        schemaVersion: "1.2",
        eventId: `74000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`,
        eventKey: `${userId}:next:${ordinal}`,
        eventType: "algorithm.learning.completed",
        userId,
        username: NAME,
        observedAt: NOW,
        source: "qa",
        topic: "backlog",
        problem: { title: "P", source: "S", url: "" },
        outcome: "consulted",
        evidence: "e",
        tags: [],
        confidence: "medium"
      }
    },
    requestId: `req-backlog-${ordinal}`
  };
}

// A db wrapper that only counts what the statements actually PULLED.
function rowCountingDb(rawDb, stats) {
  const track = (sqlText, result) => {
    if (/^\s*(SELECT|WITH)/i.test(sqlText)) {
      stats.rows += Number(result?.meta?.rows_read ?? result?.results?.length ?? 0);
    }
    return result;
  };
  return {
    prepare: (sql) => {
      const stmt = rawDb.prepare(sql);
      const make = (bound) => {
        const native = bound && bound.length ? stmt.bind(...bound) : stmt;
        return {
          __native: native,
          bind: (...values) => make(values),
          first: async (...args) => {
            const all = track(sql, await native.all());
            const row = all.results[0] ?? null;
            if (row === null || args.length === 0) return row;
            return row[args[0]] ?? null;
          },
          all: async () => track(sql, await native.all()),
          run: async () => track(sql, await native.run())
        };
      };
      return make([]);
    },
    batch: async (statements) => {
      const results = await rawDb.batch(statements.map((statement) => statement.__native));
      statements.forEach((statement, index) => track(statement.__sql ?? "", results[index]));
      return results;
    }
  };
}

test("the predecessor probe is an indexed bounded existence query", async () => {
  await runProjectionTest(async ({ binding, rawDb }) => {
    const plan = await rawDb.prepare(`EXPLAIN QUERY PLAN ${PREDECESSOR_PROBE_SQL}`)
      .bind(USER_A, "algorithm", "learning", 0, 10).all();
    const detail = plan.results.map((row) => String(row.detail)).join(" | ");
    assert.match(detail, /rds2_events_scope_seq_idx/,
      `(${binding}) the probe must use the (user, namespace, projection, seq) index, got ${detail}`);
    assert.doesNotMatch(detail, /\bSCAN\b/,
      `(${binding}) the probe must never scan the event table, got ${detail}`);
  });
});

test("an event-table backlog costs no more rows than a short history", async () => {
  await runProjectionTest(async ({ binding, rawDb, makeIo }) => {
    const measured = [];
    for (const backlog of [50, 400]) {
      const user = `44444444-0000-4000-8000-${String(backlog).padStart(12, "0")}`;
      const highest = await seedEventBacklog(rawDb, user, backlog);
      await rawDb.prepare(
        `INSERT INTO rds2_projections (user_id, namespace, projection_name, revision, last_event_seq,
           active_generation, building, summary_json, updated_at)
         VALUES (?, 'algorithm', 'learning', 0, ?, 0, 0, NULL, ?)`
      ).bind(user, highest, NOW).run();
      const stats = { rows: 0 };
      const countingIo = createInvocationIo({
        db: rowCountingDb(rawDb, stats),
        queues: {
          RDS2_PROJECTION_QUEUE: { send: async () => {} },
          RDS2_ARCHIVE_QUEUE: { send: async () => {} }
        },
        fetchImpl: async () => new Response("{}", { status: 200 }),
        limit: PROJECTION_LIMIT
      });
      await acceptEvent({
        io: makeIo(), principal: { userId: user, username: NAME },
        envelope: backlogEnvelope(user, backlog + 1), now: NOW
      });
      const taskId = await rawDb.prepare(
        `SELECT task_id FROM rds2_tasks WHERE type = 'projection' AND state = 'pending'
           AND user_id = ? ORDER BY created_at DESC, task_id DESC LIMIT 1`
      ).bind(user).first("task_id");
      await dispatchOne({ io: makeIo(), taskId, owner: "d", now: NOW });
      const result = await projectOne({ io: countingIo, taskId, owner: "c", now: NOW, reducer: algorithmReducer });
      assert.equal(result.outcome, "completed", `(${binding}) ${JSON.stringify(result)}`);
      measured.push({ backlog, rows: stats.rows });
    }
    const [small, large] = measured;
    assert.equal(large.rows, small.rows,
      `(${binding}) a ${large.backlog}-event backlog must not read more rows than ${small.backlog}`);
    assert.ok(small.rows <= 16, `(${binding}) a single event stays bounded, got ${small.rows}`);
  });
});

test("a backlogged predecessor defers the newer event instead of skipping it", async () => {
  await runProjectionTest(async ({ binding, rawDb, makeIo }) => {
    const user = "55555555-0000-4000-8000-000000000001";
    await seedEventBacklog(rawDb, user, 20);
    // The head has NOT caught up: every seeded event is still unprocessed.
    await rawDb.prepare(
      `INSERT INTO rds2_projections (user_id, namespace, projection_name, revision, last_event_seq,
         active_generation, building, summary_json, updated_at)
       VALUES (?, 'algorithm', 'learning', 0, 0, 0, 0, NULL, ?)`
    ).bind(user, NOW).run();
    await acceptEvent({
      io: makeIo(), principal: { userId: user, username: NAME },
      envelope: backlogEnvelope(user, 999), now: NOW
    });
    const taskId = await rawDb.prepare(
      `SELECT task_id FROM rds2_tasks WHERE type = 'projection' AND state = 'pending'
         AND user_id = ? ORDER BY created_at DESC, task_id DESC LIMIT 1`
    ).bind(user).first("task_id");
    await dispatchOne({ io: makeIo(), taskId, owner: "d", now: NOW });
    const result = await projectOne({ io: makeIo(), taskId, owner: "c", now: NOW, reducer: algorithmReducer });
    assert.equal(result.outcome, "retry", `(${binding}) ${JSON.stringify(result)}`);
    assert.equal(result.code, "deferred_predecessor",
      `(${binding}) the newer event waits for its predecessor`);
  });
});

test("F2 repeated real storage failures count, back off and park at the threshold", async () => {
  await runProjectionTest(async ({ binding, rawDb, io, makeIo }) => {
    await seedEventsThroughAccept(makeIo, rawDb, 2);
    const before = await loadProjectionHead(io.db, SCOPE_A);
    await ensureBuild({ db: rawDb, scope: SCOPE_A, baseRevision: before.revision, now: NOW });
    const pageTask = await rawDb.prepare(
      "SELECT task_id FROM rds2_tasks WHERE type = 'projection_build' AND state = 'pending' LIMIT 1"
    ).first("task_id");
    assert.ok(pageTask, `(${binding}) the build must have queued its first page`);

    const observed = [];
    let clock = NOW;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const row = await rawDb.prepare(
        "SELECT available_at FROM rds2_tasks WHERE task_id = ?"
      ).bind(pageTask).first();
      // Advance only to the moment the task is actually due: the backoff is
      // what we are measuring, so we must not hand-wave it away.
      if (row?.available_at && row.available_at > clock) clock = row.available_at;
      await rawDb.prepare(
        "UPDATE rds2_tasks SET state = 'queued', available_at = ? WHERE task_id = ?"
      ).bind(clock, pageTask).run();

      const result = await continueBuild({
        io: failingBatchIo(makeIo()),
        taskId: pageTask,
        owner: "builder",
        now: clock,
        reducer: algorithmReducer
      });
      const after = await rawDb.prepare(
        "SELECT state, failure_count, available_at FROM rds2_tasks WHERE task_id = ?"
      ).bind(pageTask).first();
      observed.push({
        attempt,
        outcome: result.outcome,
        code: result.code,
        state: after.state,
        failureCount: Number(after.failure_count),
        backoffSeconds: (Date.parse(after.available_at) - Date.parse(clock)) / 1000
      });
    }

    const detail = `(${binding}) ${JSON.stringify(observed)}`;
    // The pre-F2 behaviour was: every attempt deferred at availableAt = now,
    // failure_count stayed 0 and the task never parked.
    assert.deepEqual(
      observed.map((entry) => entry.failureCount),
      [1, 2, 3, 4, 5],
      `a real failure must be counted every time. ${detail}`
    );
    assert.deepEqual(
      observed.map((entry) => entry.backoffSeconds),
      [30, 60, 120, 240, 480],
      `the backoff schedule must apply. ${detail}`
    );
    assert.deepEqual(
      observed.slice(0, 4).map((entry) => entry.outcome),
      ["retry", "retry", "retry", "retry"],
      `a transient fault retries instead of parking on the first failure. ${detail}`
    );
    assert.equal(observed[4].outcome, "needs_attention",
      `the fifth consecutive failure parks the task for a human. ${detail}`);
    assert.equal(observed[4].state, "needs_attention", detail);
    for (const entry of observed.slice(0, 4)) {
      assert.equal(entry.state, "pending", `${JSON.stringify(entry)} ${detail}`);
    }
  });
});

test("F2 a later success clears the consecutive-failure counter inside the same batch", async () => {
  await runProjectionTest(async ({ binding, rawDb, io, makeIo }) => {
    await seedEventsThroughAccept(makeIo, rawDb, 2);
    const before = await loadProjectionHead(io.db, SCOPE_A);
    await ensureBuild({ db: rawDb, scope: SCOPE_A, baseRevision: before.revision, now: NOW });
    const pageTask = await rawDb.prepare(
      "SELECT task_id FROM rds2_tasks WHERE type = 'projection_build' AND state = 'pending' LIMIT 1"
    ).first("task_id");

    await rawDb.prepare("UPDATE rds2_tasks SET state = 'queued', available_at = ? WHERE task_id = ?")
      .bind(NOW, pageTask).run();
    const failed = await continueBuild({
      io: failingBatchIo(makeIo()), taskId: pageTask, owner: "builder", now: NOW, reducer: algorithmReducer
    });
    assert.equal(failed.outcome, "retry", `(${binding}) ${JSON.stringify(failed)}`);
    const counted = await rawDb.prepare("SELECT failure_count FROM rds2_tasks WHERE task_id = ?")
      .bind(pageTask).first("failure_count");
    assert.equal(Number(counted), 1, `(${binding}) the first failure is counted`);

    // Now let the very same task succeed.
    const row = await rawDb.prepare("SELECT available_at FROM rds2_tasks WHERE task_id = ?")
      .bind(pageTask).first();
    const due = row.available_at > NOW ? row.available_at : NOW;
    await rawDb.prepare("UPDATE rds2_tasks SET state = 'queued', available_at = ? WHERE task_id = ?")
      .bind(due, pageTask).run();
    const succeeded = await continueBuild({
      io: makeIo(), taskId: pageTask, owner: "builder", now: due, reducer: algorithmReducer
    });
    assert.equal(succeeded.outcome, "completed", `(${binding}) ${JSON.stringify(succeeded)}`);

    const after = await rawDb.prepare(
      "SELECT state, failure_count FROM rds2_tasks WHERE task_id = ?"
    ).bind(pageTask).first();
    assert.equal(after.state, "completed");
    assert.equal(Number(after.failure_count), 0,
      `(${binding}) success must clear the counter itself, not wait for an admin replay`);
  });
});

// The reducer drives the failure: with an empty read plan the ONLY batch is
// the commit, so the fault lands exactly where a real commit fault would.
// (Intercepting "write batches" by SQL does not work: bind() returns a new
// statement object, so a SQL-keyed map misses it.)
const readlessReducer = { ...algorithmReducer, reads: () => [] };

test("F2 an incremental projection that keeps failing counts and parks like the build path", async () => {
  await runProjectionTest(async ({ binding, rawDb, io, makeIo }) => {
    // project: false leaves the task pending so we can drive it ourselves.
    await seedEventsThroughAccept(makeIo, rawDb, 1, { topic: "t-inc", project: false });
    const taskId = await rawDb.prepare(
      "SELECT task_id FROM rds2_tasks WHERE type = 'projection' AND user_id = ? AND state = 'pending' ORDER BY created_at DESC, task_id DESC LIMIT 1"
    ).bind(USER_A).first("task_id");
    assert.ok(taskId, `(${binding}) the event must have queued a projection task`);

    const observed = [];
    let clock = NOW;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const row = await rawDb.prepare("SELECT available_at FROM rds2_tasks WHERE task_id = ?")
        .bind(taskId).first();
      if (row?.available_at && row.available_at > clock) clock = row.available_at;
      await rawDb.prepare("UPDATE rds2_tasks SET state = 'queued', available_at = ? WHERE task_id = ?")
        .bind(clock, taskId).run();
      const result = await projectOne({
        io: failingBatchIo(makeIo()), taskId, owner: "projector", now: clock, reducer: readlessReducer
      });
      const after = await rawDb.prepare(
        "SELECT state, failure_count FROM rds2_tasks WHERE task_id = ?"
      ).bind(taskId).first();
      observed.push({
        attempt,
        outcome: result.outcome,
        state: after.state,
        failureCount: Number(after.failure_count)
      });
    }

    const detail = `(${binding}) ${JSON.stringify(observed)}`;
    assert.deepEqual(observed.map((entry) => entry.failureCount), [1, 2, 3, 4, 5],
      `a real failure must be counted on the incremental path too. ${detail}`);
    assert.equal(observed[4].outcome, "needs_attention",
      `the fifth consecutive failure parks the task. ${detail}`);
    assert.equal(observed[4].state, "needs_attention", detail);
  });
});

// G2-F1: the continuation must not carry the whole accumulated dictionary.
// 35 events, each with its OWN long topic — the reproduction from the review.
test("F1 a build over a long multi-topic history completes instead of wedging the scope", async () => {
  await runProjectionTest(async ({ binding, rawDb, io, makeIo }) => {
    for (let index = 1; index <= 35; index += 1) {
      await seedEventsThroughAccept(makeIo, rawDb, 1, {
        topic: `t${index}-${"x".repeat(1000)}`,
        idOffset: 1000 + index,
        project: false
      });
    }
    const before = await loadProjectionHead(io.db, SCOPE_A);
    assert.equal(before.revision, 0, `(${binding}) seeding must not project`);
    await ensureBuild({ db: rawDb, scope: SCOPE_A, baseRevision: 0, now: NOW });

    const result = await drainBuildPages(makeIo, rawDb);
    assert.equal(result.outcome, "completed",
      `(${binding}) a legal history must build to completion, got ${JSON.stringify(result)}`);

    const after = await loadProjectionHead(io.db, SCOPE_A);
    assert.equal(after.revision, 1, `(${binding}) the build must activate`);
    assert.equal(after.building, 0, `(${binding}) the scope must be released`);
    const topics = await rawDb.prepare(
      "SELECT COUNT(*) AS n FROM rds2_projection_rows WHERE user_id = ? AND generation = ? AND row_kind = 'topic'"
    ).bind(USER_A, after.activeGeneration).first("n");
    assert.equal(Number(topics), 35, `(${binding}) every distinct topic must be projected`);
  });
});

// The continuation must hold bounded scalars only: no accumulated dictionary,
// so its size no longer depends on how much history has been folded.
test("F1 the continuation carries no accumulated topic or problem dictionary", async () => {
  await runProjectionTest(async ({ binding, rawDb, io, makeIo }) => {
    for (let index = 1; index <= 12; index += 1) {
      await seedEventsThroughAccept(makeIo, rawDb, 1, {
        topic: `shared-${index}-${"y".repeat(400)}`,
        idOffset: 3000 + index,
        project: false
      });
    }
    await ensureBuild({ db: rawDb, scope: SCOPE_A, baseRevision: 0, now: NOW });
    const first = await runOneBuildPage(makeIo, rawDb);
    assert.equal(first.outcome, "continued", `(${binding}) ${JSON.stringify(first)}`);

    const row = await rawDb.prepare(
      "SELECT continuation_json FROM rds2_projection_builds LIMIT 1"
    ).first("continuation_json");
    assert.ok(row, `(${binding}) a continuation must have been written`);
    const bytes = Buffer.byteLength(row, "utf8");
    assert.ok(bytes <= 65536, `(${binding}) continuation must respect the 64 KiB unit, got ${bytes}`);
    // Per-topic state must not accumulate. The ONE seeded topic that may
    // legitimately appear is the elected head carried by `summary` (a single,
    // bounded string) — anything more would mean a dictionary survived. The
    // assertion therefore counts how many seeded topics appear, and requires
    // any survivor to live inside `summary`.
    const present = [];
    for (let index = 1; index <= 12; index += 1) {
      if (row.includes(`shared-${index}-`)) present.push(index);
    }
    const parsed = JSON.parse(row);
    assert.ok(present.length <= 1,
      `(${binding}) the continuation must not accumulate per-topic state; ` +
      `found ${present.length} seeded topics [${present}] in ${JSON.stringify(parsed)}`);
    if (present.length === 1) {
      assert.ok(JSON.stringify(parsed.summary ?? null).includes(`shared-${present[0]}-`),
        `(${binding}) the only seeded topic in the continuation must be the elected ` +
        `head inside summary, got ${JSON.stringify(parsed)}`);
    }
    for (const key of Object.keys(parsed)) {
      assert.ok(
        ["nextEventSeq", "stagedCount", "page", "firstEventSeq", "summary",
          "counts", "latest", "headIdentity", "lastReceivedEventId"].includes(key),
        `(${binding}) unexpected continuation field: ${key}`
      );
    }
  });
});

test("F1 a topic repeated inside one page accumulates against the page's own value", async () => {
  await runProjectionTest(async ({ binding, rawDb, io, makeIo }) => {
    // Same topic, six events, all inside one page: the second event must see
    // what the first wrote, not the pre-read snapshot.
    for (let index = 1; index <= 6; index += 1) {
      await seedEventsThroughAccept(makeIo, rawDb, 1, {
        topic: "repeated",
        idOffset: 4000 + index,
        project: false
      });
    }
    await ensureBuild({ db: rawDb, scope: SCOPE_A, baseRevision: 0, now: NOW });
    const result = await drainBuildPages(makeIo, rawDb);
    assert.equal(result.outcome, "completed", `(${binding}) ${JSON.stringify(result)}`);

    const after = await loadProjectionHead(io.db, SCOPE_A);
    const topicRow = await rawDb.prepare(
      "SELECT value_json FROM rds2_projection_rows WHERE user_id = ? AND generation = ? AND row_kind = 'topic' AND row_key = ?"
    ).bind(USER_A, after.activeGeneration, "repeated").first("value_json");
    assert.ok(topicRow, `(${binding}) the topic must be projected`);
    const value = JSON.parse(topicRow);
    assert.equal(Number(value.attempts), 6,
      `(${binding}) every repeat inside the page must be counted, got ${topicRow}`);
    const evidence = await rawDb.prepare(
      "SELECT COUNT(*) AS n FROM rds2_projection_rows WHERE user_id = ? AND generation = ? AND row_kind = 'evidence'"
    ).bind(USER_A, after.activeGeneration).first("n");
    assert.equal(Number(evidence), 6, `(${binding}) each event keeps its own evidence row`);
  });
});

test("F1 staged reads never cross a user or a generation", async () => {
  await runProjectionTest(async ({ binding, rawDb, io, makeIo }) => {
    const topic = "shared-topic";
    for (let index = 1; index <= 3; index += 1) {
      await seedEventsThroughAccept(makeIo, rawDb, 1, {
        topic, idOffset: 5000 + index, project: false
      });
    }
    await ensureBuild({ db: rawDb, scope: SCOPE_A, baseRevision: 0, now: NOW });
    const build = await rawDb.prepare(
      "SELECT build_id, staging_generation FROM rds2_projection_builds LIMIT 1"
    ).first();
    // A different user, same key, and a stale generation, same key.
    await rawDb.prepare(
      `INSERT INTO rds2_projection_rows (user_id, namespace, projection_name, generation,
         row_kind, row_key, member_key, sort_key, value_json, updated_at)
       VALUES (?, ?, ?, ?, 'topic', ?, NULL, ?, ?, ?)`
    ).bind("u-other", "algorithm", "learning", build.staging_generation, topic, topic,
      JSON.stringify({ attempts: 999 }), NOW).run();
    await rawDb.prepare(
      `INSERT INTO rds2_projection_rows (user_id, namespace, projection_name, generation,
         row_kind, row_key, member_key, sort_key, value_json, updated_at)
       VALUES (?, ?, ?, ?, 'topic', ?, NULL, ?, ?, ?)`
    ).bind(USER_A, "algorithm", "learning", build.staging_generation + 7, topic, topic,
      JSON.stringify({ attempts: 888 }), NOW).run();

    const result = await drainBuildPages(makeIo, rawDb);
    assert.equal(result.outcome, "completed", `(${binding}) ${JSON.stringify(result)}`);
    const after = await loadProjectionHead(io.db, SCOPE_A);
    const topicRow = await rawDb.prepare(
      "SELECT value_json FROM rds2_projection_rows WHERE user_id = ? AND generation = ? AND row_kind = 'topic' AND row_key = ?"
    ).bind(USER_A, after.activeGeneration, topic).first("value_json");
    const value = JSON.parse(topicRow);
    assert.equal(Number(value.attempts), 3,
      `(${binding}) only this user's events may accumulate, got ${topicRow}`);
  });
});

test("F1 a build over a 200-event multi-topic history still completes", async () => {
  await runProjectionTest(async ({ binding, rawDb, io, makeIo }) => {
    for (let index = 1; index <= 200; index += 1) {
      await seedEventsThroughAccept(makeIo, rawDb, 1, {
        topic: `big-${index}-${"z".repeat(300)}`,
        idOffset: 9000 + index,
        project: false
      });
    }
    await ensureBuild({ db: rawDb, scope: SCOPE_A, baseRevision: 0, now: NOW });
    const result = await drainBuildPages(makeIo, rawDb, { rounds: 120 });
    assert.equal(result.outcome, "completed", `(${binding}) ${JSON.stringify(result)}`);
    const after = await loadProjectionHead(io.db, SCOPE_A);
    const topics = await rawDb.prepare(
      "SELECT COUNT(*) AS n FROM rds2_projection_rows WHERE user_id = ? AND generation = ? AND row_kind = 'topic'"
    ).bind(USER_A, after.activeGeneration).first("n");
    assert.equal(Number(topics), 200, `(${binding}) every distinct topic must be projected`);
  });
});

test("F2 a stage that would leave no room to book a failure waits instead of spending the reserve", async () => {
  await runProjectionTest(async ({ binding, rawDb, io, makeIo }) => {
    await seedEventsThroughAccept(makeIo, rawDb, 2);
    const before = await loadProjectionHead(io.db, SCOPE_A);
    const build = await ensureBuild({ db: rawDb, scope: SCOPE_A, baseRevision: before.revision, now: NOW });
    const pageTask = await rawDb.prepare(
      "SELECT task_id FROM rds2_tasks WHERE type = 'projection_build' AND state = 'pending' LIMIT 1"
    ).first("task_id");

    const ioWithLimit = (limit) => createInvocationIo({
      db: rawDb,
      queues: {
        RDS2_PROJECTION_QUEUE: { send: async () => {} },
        RDS2_ARCHIVE_QUEUE: { send: async () => {} }
      },
      fetchImpl: async () => new Response("{}", { status: 200 }),
      limit
    });

    // load(4) + reserve(4): the load fits, the FIRST PAGE query does not.
    const tight = ioWithLimit(8);
    await rawDb.prepare("UPDATE rds2_tasks SET state = 'queued', available_at = ? WHERE task_id = ?")
      .bind(NOW, pageTask).run();
    const firstResult = await continueBuild({
      io: tight, taskId: pageTask, owner: "builder", now: NOW, reducer: algorithmReducer
    });
    assert.equal(firstResult.outcome, "retry", `(${binding}) ${JSON.stringify(firstResult)}`);
    assert.equal(firstResult.code, "budget_reserve_insufficient");

    // load(4) + firstPage(1) + reserve(4): one stage further along.
    const looser = ioWithLimit(9);
    await rawDb.prepare("UPDATE rds2_tasks SET state = 'queued', available_at = ? WHERE task_id = ?")
      .bind(NOW, pageTask).run();
    const secondResult = await continueBuild({
      io: looser, taskId: pageTask, owner: "builder", now: NOW, reducer: algorithmReducer
    });
    assert.equal(secondResult.outcome, "retry", `(${binding}) ${JSON.stringify(secondResult)}`);
    assert.equal(secondResult.code, "budget_reserve_insufficient");

    // The gate must actually be at the stage boundary, not just at the entry:
    // the larger budget got one statement further before it stopped.
    const usedTight = tight.budget.snapshot().used;
    const usedLooser = looser.budget.snapshot().used;
    assert.equal(usedLooser, usedTight + 1,
      `(${binding}) the larger budget must consume exactly one more statement (${usedTight} vs ${usedLooser})`);

    // A class-A wait: no real failure is counted and nothing was written.
    const task = await rawDb.prepare("SELECT state, failure_count FROM rds2_tasks WHERE task_id = ?")
      .bind(pageTask).first();
    assert.equal(task.state, "pending", `(${binding}) the task simply goes back to the queue`);
    assert.equal(Number(task.failure_count), 0,
      `(${binding}) running out of room is not a real failure`);
    const stage = await rawDb.prepare("SELECT stage FROM rds2_projection_builds WHERE build_id = ?")
      .bind(build.build_id).first("stage");
    assert.equal(stage, "scanning", `(${binding}) the build is untouched`);
    assert.equal(await countRows(rawDb, { userId: USER_A, generation: build.staging_generation }), 0,
      `(${binding}) no page was staged`);
  });
});

test("F2 a lease conflict during the commit is never counted as a real failure", async () => {
  await runProjectionTest(async ({ binding, rawDb, io, makeIo }) => {
    await seedEventsThroughAccept(makeIo, rawDb, 2);
    const before = await loadProjectionHead(io.db, SCOPE_A);
    await ensureBuild({ db: rawDb, scope: SCOPE_A, baseRevision: before.revision, now: NOW });
    const pageTask = await rawDb.prepare(
      "SELECT task_id FROM rds2_tasks WHERE type = 'projection_build' AND state = 'pending' LIMIT 1"
    ).first("task_id");

    // The measured shape of rds2_guard_task aborting (SQLite binding).
    const guardError = new Error("stale_task_write");
    guardError.code = "ERR_SQLITE_ERROR";
    guardError.errcode = 1811;
    await rawDb.prepare(
      "UPDATE rds2_tasks SET state = 'queued', available_at = ? WHERE task_id = ?"
    ).bind(NOW, pageTask).run();
    const stealingIo = (() => {
      const inner = makeIo();
      return { ...inner, db: { ...inner.db, batch: async () => { throw guardError; } } };
    })();

    const result = await continueBuild({
      io: stealingIo, taskId: pageTask, owner: "builder", now: NOW, reducer: algorithmReducer
    });
    const after = await rawDb.prepare(
      "SELECT state, failure_count FROM rds2_tasks WHERE task_id = ?"
    ).bind(pageTask).first();
    assert.equal(result.outcome, "noop",
      `(${binding}) a lost lease is not success and not a failure, got ${JSON.stringify(result)}`);
    assert.equal(result.code, "lease_lost");
    assert.equal(Number(after.failure_count), 0,
      `(${binding}) a recognised race must not raise the real failure count`);
    // The task still holds a processing lease, so the state is untouched here;
    // what matters is that neither a backoff nor a count was written.
    assert.equal(Number(after.failure_count), 0);
  });
});

// The counter-clearing exists on BOTH success paths: the build activation's
// inline UPDATE and the repository's completeTask (the settled-build path).
// This pins the second copy — a mutation of the first copy must not be the
// only thing standing between a stale counter and a completed task.
test("F2 completeTask clears the counter on the settled-build path too", async () => {
  await runProjectionTest(async ({ binding, rawDb }) => {
    await rawDb.prepare(
      `INSERT INTO rds2_tasks (task_id, type, user_id, namespace, projection_name, event_seq,
         state, available_at, attempt, failure_count, lease_owner, lease_until, lease_epoch,
         payload_json, created_at, updated_at)
       VALUES ('t-clear', 'projection', 'u-clear', 'algorithm', 'learning', 1,
         'processing', ?, 4, 2, 'o1', ?, 3, '{}', ?, ?)`
    ).bind(NOW, FUTURE_LEASE, NOW, NOW).run();

    const lease = {
      taskId: "t-clear", owner: "o1", epoch: 3, leaseUntil: FUTURE_LEASE,
      scope: { userId: "u-clear", namespace: "algorithm", projectionName: "learning" }
    };
    // The class-C close-out ran earlier in this task's life; completing now
    // must clear what it counted, in the same write.
    const counted = await failTask({ db: rawDb, lease, now: NOW, code: "probe" });
    assert.equal(counted.rowsWritten, 1, `(${binding}) the probe failure is counted`);
    assert.equal(Number((await rawDb.prepare(
      "SELECT failure_count FROM rds2_tasks WHERE task_id = 't-clear'"
    ).first("failure_count"))), 3, `(${binding}) counter sits at three`);

    // Hand the lease back so completeTask's predicate can match again.
    await rawDb.prepare(
      "UPDATE rds2_tasks SET state = 'processing', lease_owner = 'o1', lease_until = ?, lease_epoch = 4 WHERE task_id = 't-clear'"
    ).bind(FUTURE_LEASE).run();
    const done = await completeTask({
      db: rawDb, lease: { ...lease, epoch: 4 }, now: NOW
    });
    assert.equal(done.rowsWritten, 1, `(${binding}) the completion is authoritative`);
    const after = await rawDb.prepare(
      "SELECT state, failure_count FROM rds2_tasks WHERE task_id = 't-clear'"
    ).first();
    assert.equal(after.state, "completed", `(${binding}) ${JSON.stringify(after)}`);
    assert.equal(Number(after.failure_count), 0,
      `(${binding}) the settled path clears the counter itself, not an admin replay`);
  });
});

// ---------------------------------------------------------------------------
// G2-F2 (§5.3): the budget account is MEASURED, not estimated. These tests
// trace budget.snapshot() of a real build-page invocation on both bindings and
// pin the exact numbers the design account (plan §5.1) predicted.
// ---------------------------------------------------------------------------
test("F2 the measured build-page budget account matches the design account", async () => {
  await runProjectionTest(async ({ binding, rawDb, io, makeIo }) => {
    // Three learning events produce 12 row changes (topic/evidence/problem/
    // topic_problem each), safely inside the 20-row commit bound — so this
    // page consumes everything and activates in place.
    await seedEventsThroughAccept(makeIo, rawDb, 3);
    const before = await loadProjectionHead(io.db, SCOPE_A);
    await ensureBuild({ db: rawDb, scope: SCOPE_A, baseRevision: before.revision, now: NOW });
    const pageTask = await rawDb.prepare(
      "SELECT task_id FROM rds2_tasks WHERE type = 'projection_build' AND state = 'pending' LIMIT 1"
    ).first("task_id");

    // --- the activation page: one invocation, fully traced
    const pageIo = makeIo();
    await dispatchOne({ io: makeIo(), taskId: pageTask, owner: "dispatch", now: NOW });
    const result = await continueBuild({
      io: pageIo, taskId: pageTask, owner: "builder", now: NOW, reducer: algorithmReducer
    });
    assert.equal(result.outcome, "completed", `(${binding}) ${JSON.stringify(result)}`);
    const snapshot = pageIo.budget.snapshot();
    console.log(`BUDGET-TRACE[${binding}] activation used=${snapshot.used} ` +
      `entries=${JSON.stringify(snapshot.entries)}`);
    // Every sub-request of a build page is a D1 execution: no queue send and
    // no HTTP fetch happens inside continueBuild.
    assert.ok(snapshot.entries.every((entry) => entry.category === "d1"),
      `(${binding}) a build page only spends D1 sub-requests: ${JSON.stringify(snapshot.entries)}`);
    // Measured (plan §5.3): load 4 (claim + task + build row + head)
    //   + firstPage 1 (MIN) + pageRead 1 + stagedReads 2 (topic chunk + problem
    //   chunk for three distinct keys each) + commit 1 = 9.
    assert.equal(snapshot.used, 9,
      `(${binding}) the measured activation-page account changed — re-derive §5.1`);

    // --- the failure close-out, measured against the SAME business account.
    // Two builds seeded with the same event shape, differing ONLY in whether
    // the commit batch succeeds: the difference is exactly the close-out.
    await seedEventsThroughAccept(makeIo, rawDb, 2, { idOffset: 900, project: false });
    const laterHead = await loadProjectionHead(io.db, SCOPE_A);
    await ensureBuild({ db: rawDb, scope: SCOPE_A, baseRevision: laterHead.revision, now: NOW });
    const firstBuildTask = await rawDb.prepare(
      "SELECT task_id FROM rds2_tasks WHERE type = 'projection_build' AND state = 'pending' " +
      "ORDER BY created_at, task_id LIMIT 1"
    ).first("task_id");
    await dispatchOne({ io: makeIo(), taskId: firstBuildTask, owner: "dispatch", now: NOW });
    const healthyIo = makeIo();
    const healthy = await continueBuild({
      io: healthyIo, taskId: firstBuildTask, owner: "builder", now: NOW, reducer: algorithmReducer
    });
    assert.equal(healthy.outcome, "completed", `(${binding}) ${JSON.stringify(healthy)}`);
    const healthyUsed = healthyIo.budget.snapshot().used;

    await seedEventsThroughAccept(makeIo, rawDb, 2, { idOffset: 950, project: false });
    const secondHead = await loadProjectionHead(io.db, SCOPE_A);
    const failingBuild = await ensureBuild({
      db: rawDb, scope: SCOPE_A, baseRevision: secondHead.revision, now: NOW
    });
    const failingTask = await rawDb.prepare(
      "SELECT task_id FROM rds2_tasks WHERE type = 'projection_build' AND state = 'pending' " +
      "ORDER BY created_at DESC, task_id LIMIT 1"
    ).first("task_id");
    const probeIo = makeIo();
    const probeInner = probeIo.db;
    let usedAtCommit = null;
    const failingIo = {
      ...probeIo,
      db: {
        prepare: (sql) => probeInner.prepare(sql),
        batch: async () => {
          // Mimic wrapD1 exactly: the sub-request is consumed BEFORE the call
          // is issued, so a FAILING commit still spends its statement.
          usedAtCommit = probeIo.budget.snapshot().used;
          probeIo.budget.consume("d1");
          throw new Error("storage_unavailable");
        }
      }
    };
    await dispatchOne({ io: makeIo(), taskId: failingTask, owner: "dispatch", now: NOW });
    const failed = await continueBuild({
      io: failingIo, taskId: failingTask, owner: "builder", now: NOW, reducer: algorithmReducer
    });
    assert.equal(failed.outcome, "retry", `(${binding}) ${JSON.stringify(failed)}`);
    assert.equal(failed.code, "deferred_commit_failed", `(${binding}) ${JSON.stringify(failed)}`);
    const failedUsed = failingIo.budget.snapshot().used;
    // The failed commit STILL spent its sub-request (consume before issue):
    // the business account up to and including the commit matches the healthy
    // invocation exactly.
    assert.equal(usedAtCommit + 1, healthyUsed,
      `(${binding}) a failed commit is still accounted: ${usedAtCommit}+1 vs ${healthyUsed}`);
    // failTask = getTask (1) + conditional UPDATE (1): the reserved two
    // statements are exactly what the class-C close-out spends.
    assert.equal(failedUsed, healthyUsed + 2,
      `(${binding}) the class-C close-out must cost exactly the reserved two statements ` +
      `(${failedUsed} vs ${healthyUsed})`);
    assert.ok(failedUsed <= 24,
      `(${binding}) even with the close-out the invocation stays inside the quota`);
    const booked = await rawDb.prepare(
      "SELECT state, failure_count, available_at FROM rds2_tasks WHERE task_id = ?"
    ).bind(failingTask).first();
    assert.equal(booked.state, "pending", `(${binding}) a real failure goes back to the queue`);
    assert.equal(Number(booked.failure_count), 1, `(${binding}) and it IS counted`);
    assert.ok(booked.available_at > NOW,
      `(${binding}) the retry is backed off, not immediate: ${booked.available_at}`);
    assert.equal(failingBuild.stage, "scanning", `(${binding}) the build survives for the retry`);
  });
});
