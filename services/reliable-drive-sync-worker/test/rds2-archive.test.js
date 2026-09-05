import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withD1, applySchema } from "./support/rds2-d1.js";
import { createInvocationIo } from "../src/rds2/io/invocation-io.js";
import { acceptEvent } from "../src/rds2/events/accept.js";
import { dispatchOne } from "../src/rds2/tasks/dispatcher.js";
import { projectOne } from "../src/rds2/projection/engine.js";
import { algorithmReducer } from "../src/rds2/projection/algorithm.js";
import { createArchiveClient } from "../src/rds2/archive/drive-client.js";
import { archiveOne, replayProjection } from "../src/rds2/archive/archiver.js";
import { hashText } from "../src/rds2/identity/hashing.js";

const MIGRATION_SQL = readFileSync(fileURLToPath(
  new URL("../migrations/0006_rds2_v2_tables.sql", import.meta.url)
), "utf8");
const NOW = "2026-09-06T00:00:00.000Z";
const USER = "11111111-1111-4111-8111-111111111111";
const NAME = "乔炳源";
const FOLDER_ID = "folder-archive-root";
const ARCHIVE_LIMIT = 16;

// In-memory Drive speaking the real Google REST surface the client uses.
function fakeDriveFetch({ files = new Map(), nextId = { n: 0 }, fail = {} } = {}) {
  const state = { uploads: 0, reads: 0, lists: 0 };
  const parseMultipart = (body) => {
    const parts = body.split("--drive-mcp-boundary");
    const metadata = JSON.parse(parts[1].split("\r\n\r\n")[1]);
    const content = parts[2].split("\r\n\r\n")[1].replace(/\r\n$/, "");
    return { name: metadata.name, content };
  };
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (fail.beforeFetch) throw new Error(fail.beforeFetch);
    if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files")) {
      state.uploads += 1;
      if (fail.upload) throw new Error(fail.upload);
      const { name, content } = parseMultipart(init.body);
      const id = `file-${++nextId.n}`;
      files.set(id, { id, name, content, parent: FOLDER_ID });
      return new Response(JSON.stringify({ id, name }), { status: 200 });
    }
    if (url.startsWith("https://www.googleapis.com/drive/v3/files?")) {
      state.lists += 1;
      if (fail.list) throw new Error(fail.list);
      const q = new URL(url).searchParams.get("q") ?? "";
      const nameMatch = q.match(/name = '([^']+)'/);
      const parentMatch = q.match(/'([^']+)' in parents/);
      const trashedOk = q.includes("trashed = false");
      assert.ok(nameMatch && parentMatch && trashedOk,
        `the list query must pin name, parent and trashed=false, got ${q}`);
      const matches = [...files.values()].filter((file) =>
        file.name === nameMatch[1] && file.parent === parentMatch[1]);
      return new Response(JSON.stringify({ files: matches.map(({ id, name }) => ({ id, name })) }), { status: 200 });
    }
    const mediaMatch = url.match(/https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^?]+)(\?.*)?$/);
    if (mediaMatch) {
      state.reads += 1;
      if (fail.readback) return new Response("drive unavailable", { status: fail.readback });
      const file = files.get(mediaMatch[1]);
      if (!file || file.parent !== FOLDER_ID) return new Response("not found", { status: 404 });
      return new Response(file.content, { status: 200 });
    }
    return new Response("unexpected call", { status: 500 });
  };
  return { fetchImpl, state, files };
}

function seedArtifact(rawDb, { objectName, frozenJson, taskId, type = "archive_event" }) {
  return hashText(frozenJson).then((artifactHash) =>
    rawDb.batch([
      rawDb.prepare(
        `INSERT INTO rds2_archive_deliveries (artifact_id, user_id, namespace, projection_name, object_type,
           object_name, frozen_json, artifact_hash, created_at)
         VALUES (?, ?, 'algorithm', 'learning', ?, ?, ?, ?, ?)`
      ).bind(`artifact-${taskId}`, USER, type === "archive_event" ? "event" : "projection_delta",
        objectName, frozenJson, artifactHash, NOW),
      rawDb.prepare(
        `INSERT INTO rds2_tasks (task_id, type, user_id, namespace, projection_name, event_seq, artifact_id,
           state, available_at, created_at, updated_at)
         VALUES (?, ?, ?, 'algorithm', 'learning', NULL, ?, 'pending', ?, ?, ?)`
      ).bind(taskId, type, USER, `artifact-${taskId}`, NOW, NOW, NOW)
    ]).then(() => ({ artifactId: `artifact-${taskId}`, artifactHash, taskId }))
  );
}

async function runArchiveTest(body) {
  await withD1(async (binding, rawDb) => {
    await applySchema(rawDb, MIGRATION_SQL);
    await body({ binding, rawDb });
  });
}

test("a missing object is uploaded once and verified by a content readback", async () => {
  await runArchiveTest(async ({ binding, rawDb }) => {
    const drive = fakeDriveFetch();
    let tokenCalls = 0;
    const frozen = JSON.stringify({ hello: NAME });
    const makeIo = () => createInvocationIo({ db: rawDb, queues: { RDS2_PROJECTION_QUEUE: { send: async () => {} }, RDS2_ARCHIVE_QUEUE: { send: async () => {} } }, fetchImpl: drive.fetchImpl, limit: ARCHIVE_LIMIT });
    const { taskId } = await seedArtifact(rawDb, { objectName: "artifact-test-event.json", frozenJson: frozen, taskId: "arch-1" });
    await dispatchOne({ io: makeIo(), taskId, owner: "d", now: NOW });
    const client = createArchiveClient({
      env: {}, io: makeIo(), folderId: FOLDER_ID,
      tokenProvider: async () => { tokenCalls += 1; return "token"; }
    });
    const result = await archiveOne({ io: makeIo(), taskId, owner: "c", now: NOW, client });
    assert.equal(result.outcome, "completed", `(${binding}) ${JSON.stringify(result)}`);
    assert.equal(drive.state.uploads, 1, `(${binding}) exactly one upload`);
    assert.equal(tokenCalls, 1, `(${binding}) OAuth is cached for the invocation`);
    const delivery = await rawDb.prepare(
      "SELECT drive_file_id, delivered_at FROM rds2_archive_deliveries WHERE artifact_id = ?"
    ).bind("artifact-arch-1").first();
    assert.ok(delivery.drive_file_id, `(${binding}) the drive file id is recorded`);
    assert.ok(delivery.delivered_at, `(${binding}) delivered_at is set`);
    const task = await rawDb.prepare("SELECT state FROM rds2_tasks WHERE task_id = ?").bind(taskId).first("state");
    assert.equal(task, "completed");
    const guards = await rawDb.prepare("SELECT COUNT(*) AS n FROM rds2_commit_guards").first("n");
    assert.equal(guards, 0, `(${binding}) the completion guard is cleaned up`);
    const stored = [...drive.files.values()][0];
    assert.equal(stored.content, frozen, `(${binding}) the frozen bytes are stored verbatim`);
  });
});

test("an existing object is read back, never re-uploaded", async () => {
  await runArchiveTest(async ({ binding, rawDb }) => {
    const frozen = JSON.stringify({ hello: NAME });
    const artifactHash = await hashText(frozen);
    const drive = fakeDriveFetch();
    drive.files.set("file-pre", { id: "file-pre", name: "artifact-existing.json", content: frozen, parent: FOLDER_ID });
    const makeIo = () => createInvocationIo({ db: rawDb, queues: { RDS2_PROJECTION_QUEUE: { send: async () => {} }, RDS2_ARCHIVE_QUEUE: { send: async () => {} } }, fetchImpl: drive.fetchImpl, limit: ARCHIVE_LIMIT });
    const { taskId } = await seedArtifact(rawDb, { objectName: "artifact-existing.json", frozenJson: frozen, taskId: "arch-2" });
    await dispatchOne({ io: makeIo(), taskId, owner: "d", now: NOW });
    const client = createArchiveClient({ env: {}, io: makeIo(), folderId: FOLDER_ID, tokenProvider: async () => "token" });
    const result = await archiveOne({ io: makeIo(), taskId, owner: "c", now: NOW, client });
    assert.equal(result.outcome, "completed");
    assert.equal(drive.state.uploads, 0, `(${binding}) an existing object is never uploaded again`);
    const delivery = await rawDb.prepare(
      "SELECT drive_file_id, delivered_at FROM rds2_archive_deliveries WHERE artifact_id = ?"
    ).bind("artifact-arch-2").first();
    assert.equal(delivery.drive_file_id, "file-pre");
    void artifactHash;
  });
});

test("two same-name objects park the task as ambiguous without overwriting", async () => {
  await runArchiveTest(async ({ binding, rawDb }) => {
    const drive = fakeDriveFetch();
    drive.files.set("f1", { id: "f1", name: "artifact-dup.json", content: "{}", parent: FOLDER_ID });
    drive.files.set("f2", { id: "f2", name: "artifact-dup.json", content: "{}", parent: FOLDER_ID });
    const makeIo = () => createInvocationIo({ db: rawDb, queues: { RDS2_PROJECTION_QUEUE: { send: async () => {} }, RDS2_ARCHIVE_QUEUE: { send: async () => {} } }, fetchImpl: drive.fetchImpl, limit: ARCHIVE_LIMIT });
    const { taskId } = await seedArtifact(rawDb, { objectName: "artifact-dup.json", frozenJson: "{}", taskId: "arch-3" });
    await dispatchOne({ io: makeIo(), taskId, owner: "d", now: NOW });
    const client = createArchiveClient({ env: {}, io: makeIo(), folderId: FOLDER_ID, tokenProvider: async () => "t" });
    const result = await archiveOne({ io: makeIo(), taskId, owner: "c", now: NOW, client });
    assert.equal(result.outcome, "needs_attention", `(${binding}) ambiguity must surface`);
    const task = await rawDb.prepare("SELECT state FROM rds2_tasks WHERE task_id = ?").bind(taskId).first("state");
    assert.equal(task, "needs_attention");
    const delivery = await rawDb.prepare(
      "SELECT delivered_at FROM rds2_archive_deliveries WHERE artifact_id = ?"
    ).bind("artifact-arch-3").first("delivered_at");
    assert.equal(delivery, null, `(${binding}) an ambiguous object is never marked delivered`);
  });
});

test("a content hash mismatch stops without overwriting", async () => {
  await runArchiveTest(async ({ binding, rawDb }) => {
    const drive = fakeDriveFetch();
    drive.files.set("f1", { id: "f1", name: "artifact-mismatch.json", content: '{"tampered":true}', parent: FOLDER_ID });
    const makeIo = () => createInvocationIo({ db: rawDb, queues: { RDS2_PROJECTION_QUEUE: { send: async () => {} }, RDS2_ARCHIVE_QUEUE: { send: async () => {} } }, fetchImpl: drive.fetchImpl, limit: ARCHIVE_LIMIT });
    const { taskId } = await seedArtifact(rawDb, { objectName: "artifact-mismatch.json", frozenJson: '{"original":true}', taskId: "arch-4" });
    await dispatchOne({ io: makeIo(), taskId, owner: "d", now: NOW });
    const client = createArchiveClient({ env: {}, io: makeIo(), folderId: FOLDER_ID, tokenProvider: async () => "t" });
    const result = await archiveOne({ io: makeIo(), taskId, owner: "c", now: NOW, client });
    assert.equal(result.outcome, "needs_attention", `(${binding}) a hash mismatch must stop`);
    assert.equal(drive.state.uploads, 0, `(${binding}) the mismatched object is never overwritten`);
    const delivery = await rawDb.prepare(
      "SELECT delivered_at, drive_file_id FROM rds2_archive_deliveries WHERE artifact_id = ?"
    ).bind("artifact-arch-4").first();
    assert.equal(delivery.delivered_at, null, `(${binding}) not marked delivered`);
    const task = await rawDb.prepare("SELECT state FROM rds2_tasks WHERE task_id = ?").bind(taskId).first("state");
    assert.equal(task, "needs_attention", `(${binding}) an integrity mismatch parks immediately`);
  });
});

test("a lost upload response recovers by exact find, never a blind second upload", async () => {
  await runArchiveTest(async ({ binding, rawDb }) => {
    let failing = true;
    const drive = fakeDriveFetch();
    const originalFetch = drive.fetchImpl;
    const flakyFetch = async (input, init) => {
      const url = String(input);
      if (failing && url.startsWith("https://www.googleapis.com/upload/drive/v3/files")) {
        // Drive stored the object but the response was lost.
        const result = await originalFetch(input, init);
        failing = false;
        throw new Error("response_lost");
      }
      return originalFetch(input, init);
    };
    const makeIo = () => createInvocationIo({ db: rawDb, queues: { RDS2_PROJECTION_QUEUE: { send: async () => {} }, RDS2_ARCHIVE_QUEUE: { send: async () => {} } }, fetchImpl: flakyFetch, limit: ARCHIVE_LIMIT });
    const frozen = JSON.stringify({ recover: true });
    const { taskId } = await seedArtifact(rawDb, { objectName: "artifact-lost.json", frozenJson: frozen, taskId: "arch-5" });
    const client = createArchiveClient({ env: {}, io: makeIo(), folderId: FOLDER_ID, tokenProvider: async () => "t" });
    await dispatchOne({ io: makeIo(), taskId, owner: "d", now: NOW });
    const first = await archiveOne({ io: makeIo(), taskId, owner: "c", now: NOW, client });
    assert.equal(first.outcome, "retry", `(${binding}) a lost response is retryable`);
    const uploadsAfterFirst = drive.state.uploads;
    const later = new Date(Date.parse(NOW) + 31000).toISOString();
    await dispatchOne({ io: makeIo(), taskId, owner: "d2", now: later });
    const second = await archiveOne({ io: makeIo(), taskId, owner: "c2", now: later, client });
    assert.equal(second.outcome, "completed", `(${binding}) the retry finds the stored object`);
    assert.equal(drive.state.uploads, uploadsAfterFirst, `(${binding}) no blind second upload`);
    assert.equal(drive.files.size, 1, `(${binding}) exactly one object exists in Drive`);
  });
});

test("a failed readback never marks the delivery", async () => {
  await runArchiveTest(async ({ binding, rawDb }) => {
    const drive = fakeDriveFetch({ fail: { readback: 503 } });
    const makeIo = () => createInvocationIo({ db: rawDb, queues: { RDS2_PROJECTION_QUEUE: { send: async () => {} }, RDS2_ARCHIVE_QUEUE: { send: async () => {} } }, fetchImpl: drive.fetchImpl, limit: ARCHIVE_LIMIT });
    const { taskId } = await seedArtifact(rawDb, { objectName: "artifact-failread.json", frozenJson: "{}", taskId: "arch-6" });
    await dispatchOne({ io: makeIo(), taskId, owner: "d", now: NOW });
    const client = createArchiveClient({ env: {}, io: makeIo(), folderId: FOLDER_ID, tokenProvider: async () => "t" });
    const result = await archiveOne({ io: makeIo(), taskId, owner: "c", now: NOW, client });
    assert.equal(result.outcome, "retry", `(${binding}) a 503 readback is a budgeted failure`);
    const delivery = await rawDb.prepare(
      "SELECT delivered_at FROM rds2_archive_deliveries WHERE artifact_id = ?"
    ).bind("artifact-arch-6").first("delivered_at");
    assert.equal(delivery, null, `(${binding}) the delivery stays unmarked`);
  });
});

test("a stale owner's completion writes zero rows and is not acknowledged", async () => {
  await runArchiveTest(async ({ binding, rawDb }) => {
    const frozen = JSON.stringify({ stale: true });
    const drive = fakeDriveFetch();
    drive.files.set("f1", { id: "f1", name: "artifact-stale.json", content: frozen, parent: FOLDER_ID });
    const makeIo = () => createInvocationIo({ db: rawDb, queues: { RDS2_PROJECTION_QUEUE: { send: async () => {} }, RDS2_ARCHIVE_QUEUE: { send: async () => {} } }, fetchImpl: drive.fetchImpl, limit: ARCHIVE_LIMIT });
    const { taskId } = await seedArtifact(rawDb, { objectName: "artifact-stale.json", frozenJson: frozen, taskId: "arch-7" });
    await dispatchOne({ io: makeIo(), taskId, owner: "d", now: NOW });
    const client = createArchiveClient({ env: {}, io: makeIo(), folderId: FOLDER_ID, tokenProvider: async () => "t" });
    // Simulate a lease takeover between the readback and the completion.
    const clientWithTakeover = {
      ...client,
      readContent: client.readContent,
      findExact: client.findExact
    };
    const lease = await (async () => {
      const { claimForProcessing } = await import("../src/rds2/tasks/repository.js");
      return claimForProcessing({ db: rawDb, taskId, owner: "old-owner", now: NOW });
    })();
    assert.ok(lease, `(${binding}) the archive task is claimable`);
    const { reclaimStale } = await import("../src/rds2/tasks/repository.js");
    await rawDb.prepare(
      "UPDATE rds2_tasks SET lease_until = ? WHERE task_id = ?"
    ).bind("2026-09-05T23:00:00.000Z", taskId).run();
    await reclaimStale({ db: rawDb, taskId, now: NOW });
    const result = await archiveOne({ io: makeIo(), taskId, owner: "old-owner", now: NOW, client: clientWithTakeover, lease });
    assert.equal(result.outcome, "retry", `(${binding}) the stale owner must not report success`);
    assert.equal(result.code, "completion_lost_lease", `(${binding}) zero completion rows surface as retry`);
    const delivery = await rawDb.prepare(
      "SELECT delivered_at, drive_file_id FROM rds2_archive_deliveries WHERE artifact_id = ?"
    ).bind("artifact-arch-7").first();
    assert.equal(delivery.delivered_at, null, `(${binding}) the stale owner must not mark delivery`);
    assert.equal(delivery.drive_file_id, null);
  });
});

test("a 429 from Drive is a budgeted retryable failure", async () => {
  await runArchiveTest(async ({ binding, rawDb }) => {
    const drive = fakeDriveFetch({ fail: { list: undefined } });
    let calls = 0;
    const throttled = async (input, init) => {
      calls += 1;
      if (String(input).startsWith("https://www.googleapis.com/drive/v3/files?")) {
        return new Response("rate limited", { status: 429 });
      }
      return drive.fetchImpl(input, init);
    };
    const makeIo = () => createInvocationIo({ db: rawDb, queues: { RDS2_PROJECTION_QUEUE: { send: async () => {} }, RDS2_ARCHIVE_QUEUE: { send: async () => {} } }, fetchImpl: throttled, limit: ARCHIVE_LIMIT });
    const { taskId } = await seedArtifact(rawDb, { objectName: "artifact-429.json", frozenJson: "{}", taskId: "arch-8" });
    await dispatchOne({ io: makeIo(), taskId, owner: "d", now: NOW });
    const client = createArchiveClient({ env: {}, io: makeIo(), folderId: FOLDER_ID, tokenProvider: async () => "t" });
    const result = await archiveOne({ io: makeIo(), taskId, owner: "c", now: NOW, client });
    assert.equal(result.outcome, "retry", `(${binding}) a 429 is retryable`);
    const row = await rawDb.prepare("SELECT failure_count FROM rds2_tasks WHERE task_id = ?").bind(taskId).first("failure_count");
    assert.equal(row, 1, `(${binding}) the 429 counts as a real failure`);
    assert.ok(calls >= 1);
  });
});

test("archiveOne reuses the delivered artifact idempotently", async () => {
  await runArchiveTest(async ({ binding, rawDb }) => {
    const frozen = JSON.stringify({ done: true });
    const drive = fakeDriveFetch();
    const makeIo = () => createInvocationIo({ db: rawDb, queues: { RDS2_PROJECTION_QUEUE: { send: async () => {} }, RDS2_ARCHIVE_QUEUE: { send: async () => {} } }, fetchImpl: drive.fetchImpl, limit: ARCHIVE_LIMIT });
    const { taskId } = await seedArtifact(rawDb, { objectName: "artifact-done.json", frozenJson: frozen, taskId: "arch-9" });
    await dispatchOne({ io: makeIo(), taskId, owner: "d", now: NOW });
    const client = createArchiveClient({ env: {}, io: makeIo(), folderId: FOLDER_ID, tokenProvider: async () => "t" });
    await archiveOne({ io: makeIo(), taskId, owner: "c", now: NOW, client });
    const uploadsAfterFirst = drive.state.uploads;
    const again = await archiveOne({ io: makeIo(), taskId, owner: "c2", now: NOW, client });
    assert.equal(again.outcome, "noop", `(${binding}) a completed archive task is a no-op`);
    assert.equal(drive.state.uploads, uploadsAfterFirst);
  });
});

test("offline replay rebuilds the projection from archived artifacts and rejects missing pages", async () => {
  await runArchiveTest(async ({ binding, rawDb }) => {
    const makeIo = () => createInvocationIo({ db: rawDb, queues: { RDS2_PROJECTION_QUEUE: { send: async () => {} }, RDS2_ARCHIVE_QUEUE: { send: async () => {} } }, fetchImpl: async () => new Response("{}", { status: 200 }), limit: 24 });
    for (let index = 1; index <= 3; index += 1) {
      const outcome = await acceptAndProjectOnce(makeIo, rawDb, index);
      assert.equal(outcome, "completed");
    }
    const deliveries = await rawDb.prepare(
      "SELECT object_type, object_name, frozen_json, artifact_hash FROM rds2_archive_deliveries WHERE user_id = ?"
    ).bind(USER).all();
    const artifacts = deliveries.results.map((row) => ({
      objectType: row.object_type, objectName: row.object_name,
      frozenJson: row.frozen_json, hash: row.artifact_hash
    }));
    const replay = await replayProjection(artifacts);
    assert.equal(replay.revision, 3, `(${binding}) replay reaches the same revision`);
    const liveRows = await rawDb.prepare(
      "SELECT row_kind, row_key, value_json FROM rds2_projection_rows WHERE user_id = ? AND generation = 0"
    ).bind(USER).all();
    for (const row of liveRows.results) {
      const key = `${row.row_kind}:${row.row_key}`;
      assert.equal(replay.rows[key], row.value_json,
        `(${binding}) replayed row ${key} matches the live projection`);
    }
    const withoutPage2 = artifacts.filter((artifact) => !(artifact.objectType === "projection_delta"
      && JSON.parse(artifact.frozenJson).revision === 2));
    await assert.rejects(
      () => replayProjection(withoutPage2),
      (error) => error.code === "replay_missing_page",
      `(${binding}) a missing delta page must be rejected`
    );
    const tampered = artifacts.map((artifact) => ({ ...artifact,
      frozenJson: artifact.frozenJson.replace("topic", "topicX") }));
    await assert.rejects(
      () => replayProjection(tampered),
      (error) => error.code === "replay_hash_mismatch",
      `(${binding}) tampered archived bytes must be rejected`
    );
  });
});
async function acceptAndProjectOnce(makeIo, rawDb, index) {
  const envelope = {
    schemaVersion: "1.2",
    namespace: "algorithm",
    eventType: "algorithm.learning.completed",
    identity: { username: NAME, userId: USER },
    payload: {
      event: {
        schemaVersion: "1.2",
        eventId: `70000000-0000-4000-8000-00000000000${index}`,
        eventKey: `replay-k-${index}`,
        eventType: "algorithm.learning.completed",
        userId: USER,
        username: NAME,
        observedAt: `2026-09-06T0${index}:00:00.000Z`,
        source: "qa",
        topic: `topic-${index}`,
        problem: { title: `P${index}`, source: "S", url: "" },
        outcome: index === 1 ? "incorrect" : "correct",
        evidence: "e",
        tags: [],
        confidence: "medium"
      }
    },
    requestId: `req-replay-${index}`
  };
  const io = makeIo();
  await acceptEvent({ io, principal: { userId: USER, username: NAME }, envelope, now: NOW });
  const taskId = await rawDb.prepare(
    "SELECT task_id FROM rds2_tasks WHERE type = 'projection' AND state = 'pending' ORDER BY created_at DESC, task_id DESC LIMIT 1"
  ).first("task_id");
  await dispatchOne({ io: makeIo(), taskId, owner: "d", now: NOW });
  const result = await projectOne({ io: makeIo(), taskId, owner: "c", now: NOW, reducer: algorithmReducer });
  return result.outcome;
}

function canonical(value) {
  return JSON.stringify(JSON.parse(value));
}
function normalized(value) {
  return JSON.stringify(JSON.parse(value));
}
