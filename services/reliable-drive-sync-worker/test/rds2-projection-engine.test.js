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
import { deferTask } from "../src/rds2/tasks/repository.js";
import { dispatchOne } from "../src/rds2/tasks/dispatcher.js";

const MIGRATION_SQL = readFileSync(fileURLToPath(
  new URL("../migrations/0006_rds2_v2_tables.sql", import.meta.url)
), "utf8");
const NOW = "2026-09-06T00:00:00.000Z";
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
            `INSERT INTO rds2_tasks (task_id, type, user_id, namespace, projection_name, event_seq, state, available_at, created_at, updated_at)
             VALUES ('fault', 'bogus-type', 'u', 'n', 'p', 1, 'pending', '${NOW}', '${NOW}', '${NOW}')`
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
    assert.equal(task.failure_count, 0, `(${binding}) an infra failure is not a business failure`);
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

async function seedEventsThroughAccept(makeIo, rawDb, count, { topic = "t-build", idOffset = 0, allowDeferred = false, project = true } = {}) {
  for (let index = 1; index <= count; index += 1) {
    const eventIdNumber = idOffset + index;
    const envelope = {
      schemaVersion: "1.2",
      namespace: "algorithm",
      eventType: "algorithm.learning.completed",
      identity: { username: NAME, userId: USER_A },
      payload: {
        event: {
          schemaVersion: "1.2",
          eventId: `71000000-0000-4000-8000-${String(eventIdNumber).padStart(12, "0")}`,
          eventKey: `r2-${topic}-${eventIdNumber}`,
          eventType: "algorithm.learning.completed",
          userId: USER_A,
          username: NAME,
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
    const receipt = await acceptEvent({ io: makeIo(), principal: { userId: USER_A, username: NAME }, envelope, now: NOW });
    assert.equal(receipt.disposition, "accepted");
    const taskId = await rawDb.prepare(
      "SELECT task_id FROM rds2_tasks WHERE type = 'projection' AND state = 'pending' ORDER BY created_at DESC, task_id DESC LIMIT 1"
    ).first("task_id");
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

async function drainBuildPages(makeIo, rawDb, { rounds = 8, pageSize } = {}) {
  let last = null;
  for (let round = 0; round < rounds; round += 1) {
    const nextTask = await rawDb.prepare(
      "SELECT task_id FROM rds2_tasks WHERE type = 'projection_build' AND state = 'pending' LIMIT 1"
    ).first("task_id");
    if (!nextTask) break;
    await dispatchOne({ io: makeIo(), taskId: nextTask, owner: "dispatch", now: NOW });
    last = await continueBuild({
      io: makeIo(), taskId: nextTask, owner: "builder", now: NOW,
      reducer: algorithmReducer, ...(pageSize === undefined ? {} : { pageSize })
    });
  }
  return last;
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
