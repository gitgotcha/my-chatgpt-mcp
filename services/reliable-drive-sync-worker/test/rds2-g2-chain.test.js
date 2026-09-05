import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withD1, applySchema } from "./support/rds2-d1.js";
import { createInvocationIo } from "../src/rds2/io/invocation-io.js";
import { acceptEvent } from "../src/rds2/events/accept.js";
import { dispatchOne } from "../src/rds2/tasks/dispatcher.js";
import { recoverOnce as recoverPass } from "../src/rds2/tasks/recovery.js";
import { projectOne } from "../src/rds2/projection/engine.js";
import { algorithmReducer } from "../src/rds2/projection/algorithm.js";
import { createArchiveClient } from "../src/rds2/archive/drive-client.js";
import { archiveOne } from "../src/rds2/archive/archiver.js";

const MIGRATION_SQL = readFileSync(fileURLToPath(
  new URL("../migrations/0006_rds2_v2_tables.sql", import.meta.url)
), "utf8");
const NOW = "2026-09-06T00:00:00.000Z";
const USER = "11111111-1111-4111-8111-111111111111";
const NAME = "乔炳源";
const FOLDER_ID = "folder-archive-root";

// G2 acceptance: one synthetic algorithm event travels the entire local chain
// — accept (D1) -> dispatch -> projection -> dispatch -> Drive archive — with
// every state dimension observable and the retry windows covered.
function fakeDriveFetch() {
  const files = new Map();
  let n = 0;
  const parseMultipart = (body) => {
    const parts = body.split("--drive-mcp-boundary");
    const metadata = JSON.parse(parts[1].split("\r\n\r\n")[1]);
    const content = parts[2].split("\r\n\r\n")[1].replace(/\r\n$/, "");
    return { name: metadata.name, content };
  };
  return {
    files,
    fetchImpl: async (input, init = {}) => {
      const url = String(input);
      if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files")) {
        const { name, content } = parseMultipart(init.body);
        const id = `file-${++n}`;
        files.set(id, { id, name, content, parent: FOLDER_ID });
        return new Response(JSON.stringify({ id, name }), { status: 200 });
      }
      if (url.startsWith("https://www.googleapis.com/drive/v3/files?")) {
        const q = new URL(url).searchParams.get("q") ?? "";
        const nameMatch = q.match(/name = '([^']+)'/);
        const parentMatch = q.match(/'([^']+)' in parents/);
        const matches = [...files.values()].filter((file) =>
          file.name === nameMatch?.[1] && file.parent === parentMatch?.[1]);
        return new Response(JSON.stringify({ files: matches.map(({ id, name }) => ({ id, name })) }), { status: 200 });
      }
      const media = url.match(/drive\/v3\/files\/([^?]+)/);
      if (media) {
        const file = files.get(media[1]);
        return new Response(file ? file.content : "nf", { status: file ? 200 : 404 });
      }
      return new Response("unexpected", { status: 500 });
    }
  };
}

async function runChain(body) {
  await withD1(async (binding, rawDb) => {
    await applySchema(rawDb, MIGRATION_SQL);
    const drive = fakeDriveFetch();
    const sent = [];
    const makeIo = (limit = 24) => createInvocationIo({
      db: rawDb,
      queues: {
        RDS2_PROJECTION_QUEUE: { send: async (m) => { sent.push({ queue: "projection", message: m }); } },
        RDS2_ARCHIVE_QUEUE: { send: async (m) => { sent.push({ queue: "archive", message: m }); } }
      },
      fetchImpl: drive.fetchImpl,
      limit
    });
    const client = createArchiveClient({
      env: {}, io: makeIo(16), folderId: FOLDER_ID, tokenProvider: async () => "token"
    });
    await body({ binding, rawDb, makeIo, sent, drive });
  });
}

function learningEnvelope({ requestId, eventId, topic, outcome, observedAt }) {
  return {
    schemaVersion: "1.2",
    namespace: "algorithm",
    eventType: "algorithm.learning.completed",
    identity: { username: NAME, userId: USER },
    payload: {
      event: {
        schemaVersion: "1.2",
        eventId,
        eventKey: `${USER}:algorithm-learning:${topic}:${observedAt}`,
        eventType: "algorithm.learning.completed",
        userId: USER,
        username: NAME,
        observedAt,
        source: "qa",
        topic,
        problem: { title: "Two Sum", source: "Hot100", url: "" },
        outcome,
        evidence: "用户请求讲解两数之和。",
        tags: ["hash-map"],
        confidence: "medium"
      }
    },
    requestId
  };
}

async function drainTasks({ rawDb, makeIo, rounds = 6 }) {
  for (let round = 0; round < rounds; round += 1) {
    const rows = await rawDb.prepare(
      "SELECT task_id, type FROM rds2_tasks WHERE state IN ('pending', 'dispatching', 'queued') ORDER BY task_id"
    ).all();
    if (!rows.results.length) break;
    for (const row of rows.results) {
      await dispatchOne({ io: makeIo(), taskId: row.task_id, owner: `dispatch-${row.task_id}`, now: NOW });
      if (row.type === "projection") {
        await projectOne({ io: makeIo(), taskId: row.task_id, owner: "consumer", now: NOW, reducer: algorithmReducer });
      } else {
        // One archive invocation = one fresh budget holding both the D1 and
        // the Drive calls, exactly like the real entry point.
        const io = makeIo(16);
        const client = createArchiveClient({
          env: {}, io, folderId: FOLDER_ID, tokenProvider: async () => "token"
        });
        await archiveOne({ io, taskId: row.task_id, owner: "consumer", now: NOW, client });
      }
    }
  }
}

test("G2: a synthetic algorithm event completes the full local chain", async () => {
  await runChain(async ({ binding, rawDb, makeIo, sent, drive }) => {
    const principal = { userId: USER, username: NAME };
    const receipt = await acceptEvent({
      io: makeIo(), principal, now: NOW,
      envelope: learningEnvelope({
        requestId: "req-g2-1",
        eventId: "44444444-4444-4444-8444-444444444444",
        topic: "two-sum",
        outcome: "consulted",
        observedAt: "2026-09-06T10:00:00.000Z"
      })
    });
    assert.equal(receipt.disposition, "accepted");
    assert.equal(receipt.cloudPersistence, "d1_committed");
    assert.ok(receipt.jobId, "the receipt names its projection task");

    await drainTasks({ rawDb, makeIo });

    // Persistence dimension: exactly one event and one request.
    const ledger = await rawDb.prepare(
      `SELECT (SELECT COUNT(*) FROM rds2_events) AS events,
              (SELECT COUNT(*) FROM rds2_requests) AS requests`
    ).first();
    assert.equal(Number(ledger.events), 1);
    assert.equal(Number(ledger.requests), 1);

    // Projection dimension: the head moved and the summary is real.
    const head = await rawDb.prepare(
      "SELECT revision, last_event_seq, building, summary_json FROM rds2_projections WHERE user_id = ?"
    ).bind(USER).first();
    assert.equal(head.revision, 1);
    assert.equal(head.building, 0);
    const summary = JSON.parse(head.summary_json);
    assert.equal(summary.currentTopic, "two-sum");
    assert.equal(summary.counts.neutral, 1);

    // Archive dimension: both frozen objects delivered, verified by readback.
    const deliveries = await rawDb.prepare(
      `SELECT object_type, delivered_at, drive_file_id FROM rds2_archive_deliveries WHERE user_id = ?`
    ).bind(USER).all();
    assert.equal(deliveries.results.length, 2, `(${binding}) the event and its delta are both archived`);
    for (const delivery of deliveries.results) {
      assert.ok(delivery.delivered_at, `(${binding}) ${delivery.object_type} is delivered`);
      assert.ok(delivery.drive_file_id);
    }
    assert.equal(drive.files.size, 2, `(${binding}) Drive holds exactly the two objects`);
    const taskStates = await rawDb.prepare(
      "SELECT state, COUNT(*) AS n FROM rds2_tasks GROUP BY state"
    ).all();
    const nonCompleted = taskStates.results.filter((row) => row.state !== "completed");
    assert.deepEqual(nonCompleted, [], `(${binding}) every task completed`);

    // A retry of the same request changes nothing anywhere.
    const replay = await acceptEvent({
      io: makeIo(), principal, now: NOW,
      envelope: learningEnvelope({
        requestId: "req-g2-1",
        eventId: "44444444-4444-4444-8444-444444444444",
        topic: "two-sum",
        outcome: "consulted",
        observedAt: "2026-09-06T10:00:00.000Z"
      })
    });
    assert.deepEqual(replay, receipt, `(${binding}) the replay returns the identical receipt`);
    const driveSize = drive.files.size;
    await drainTasks({ rawDb, makeIo });
    assert.equal(drive.files.size, driveSize, `(${binding}) the replay archives nothing new`);
  });
});

test("G2: a task lost between dispatch and projection is recovered by the recovery pass", async () => {
  await runChain(async ({ binding, rawDb, makeIo }) => {
    const principal = { userId: USER, username: NAME };
    await acceptEvent({
      io: makeIo(), principal, now: NOW,
      envelope: learningEnvelope({
        requestId: "req-g2-2",
        eventId: "44444444-4444-4444-8444-444444444445",
        topic: "three-sum",
        outcome: "correct",
        observedAt: "2026-09-06T11:00:00.000Z"
      })
    });
    // Simulate a crash right after the dispatch claim: the task sits in
    // dispatching with an expired lease and the queue send never happened.
    const taskId = await rawDb.prepare(
      "SELECT task_id FROM rds2_tasks WHERE type = 'projection' AND state = 'pending' LIMIT 1"
    ).first("task_id");
    const { claimForDispatch } = await import("../src/rds2/tasks/repository.js");
    await claimForDispatch({ db: rawDb, taskId, owner: "dead-worker", now: NOW });
    await rawDb.prepare("UPDATE rds2_tasks SET lease_until = ? WHERE task_id = ?")
      .bind("2026-09-05T23:00:00.000Z", taskId).run();

    const recoveryIo = makeIo(32);
    const stats = await recoverPass({ io: recoveryIo, now: NOW, limit: 4 });
    assert.equal(stats.reclaimed, 1, `(${binding}) the stale task is reclaimed`);
    assert.equal(stats.dispatched, 1);
    await projectOne({ io: makeIo(), taskId, owner: "consumer", now: NOW, reducer: algorithmReducer });
    const head = await rawDb.prepare(
      "SELECT revision, summary_json FROM rds2_projections WHERE user_id = ?"
    ).bind(USER).first();
    assert.equal(head.revision, 1, `(${binding}) the recovered event is applied exactly once`);
    const summary = JSON.parse(head.summary_json);
    assert.equal(summary.counts.positive, 1);
  });
});

test("G2: three events project in order with interleaved per-user scopes", async () => {
  await runChain(async ({ binding, rawDb, makeIo }) => {
    const principal = { userId: USER, username: NAME };
    const events = [
      learningEnvelope({ requestId: "req-g2-3a", eventId: "44444444-4444-4444-8444-444444444446", topic: "two-sum", outcome: "incorrect", observedAt: "2026-09-06T01:00:00.000Z" }),
      learningEnvelope({ requestId: "req-g2-3b", eventId: "44444444-4444-4444-8444-444444444447", topic: "two-sum", outcome: "correct", observedAt: "2026-09-06T02:00:00.000Z" }),
      learningEnvelope({ requestId: "req-g2-3c", eventId: "44444444-4444-4444-8444-444444444448", topic: "dp", outcome: "consulted", observedAt: "2026-09-06T03:00:00.000Z" })
    ];
    for (const envelope of events) {
      await acceptEvent({ io: makeIo(), principal, envelope, now: NOW });
    }
    // Process every task through the full chain until nothing is left.
    await drainTasks({ rawDb, makeIo, rounds: 8 });
    const head = await rawDb.prepare(
      "SELECT revision, summary_json FROM rds2_projections WHERE user_id = ?"
    ).bind(USER).first();
    assert.equal(head.revision, 3, `(${binding}) all three events applied in order`);
    const summary = JSON.parse(head.summary_json);
    assert.deepEqual(summary.counts, { attempts: 3, negative: 1, positive: 1, neutral: 1 });
    const topic = await rawDb.prepare(
      `SELECT value_json FROM rds2_projection_rows WHERE user_id = ? AND row_kind = 'topic' AND row_key = 'two-sum'`
    ).bind(USER).first("value_json");
    const topicValue = JSON.parse(topic);
    assert.equal(topicValue.lastOutcome, "correct", `(${binding}) the latest outcome wins`);
    const deliveries = await rawDb.prepare(
      "SELECT COUNT(*) AS n FROM rds2_archive_deliveries WHERE delivered_at IS NOT NULL"
    ).first("n");
    assert.equal(Number(deliveries), 6, `(${binding}) 3 events + 3 deltas all archived`);
    const openTasks = await rawDb.prepare(
      "SELECT COUNT(*) AS n FROM rds2_tasks WHERE state <> 'completed'"
    ).first("n");
    assert.equal(Number(openTasks), 0, `(${binding}) the chain drains completely`);
  });
});
