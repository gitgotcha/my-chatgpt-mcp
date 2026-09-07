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
import { continueBuild, ensureBuild } from "../src/rds2/projection/builds.js";
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
function fakeDriveFetch({ files = new Map(), nextId = { n: 0 }, fail = {}, listBody } = {}) {
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
      if (listBody !== undefined) return new Response(listBody, { status: 200 });
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

// ---------------------------------------------------------------------------
// P1-2 (2026-09-07 review): a counted failure followed by a successful retry
// must complete with the consecutive-failure counter CLEARED. The guarded
// completion UPDATE owns that, matching the completeTask contract in
// tasks/repository.js.
// ---------------------------------------------------------------------------

test("P1-2 a retried archive success completes with a cleared failure count", async () => {
  await runArchiveTest(async ({ binding, rawDb }) => {
    // First pass: the readback 503s after a successful upload — a real
    // (counted) failure. The bytes are already in Drive.
    const files = new Map();
    const failingDrive = fakeDriveFetch({ files, fail: { readback: 503 } });
    const makeIo = (fetchImpl) => createInvocationIo({
      db: rawDb,
      queues: { RDS2_PROJECTION_QUEUE: { send: async () => {} }, RDS2_ARCHIVE_QUEUE: { send: async () => {} } },
      fetchImpl, limit: ARCHIVE_LIMIT
    });
    const { taskId } = await seedArtifact(rawDb, {
      objectName: "artifact-p12-retry.json", frozenJson: '{"p12":true}', taskId: "arch-p12"
    });
    await dispatchOne({ io: makeIo(failingDrive.fetchImpl), taskId, owner: "d", now: NOW });
    const firstClient = createArchiveClient({ env: {}, io: makeIo(failingDrive.fetchImpl), folderId: FOLDER_ID, tokenProvider: async () => "t" });
    const first = await archiveOne({ io: makeIo(failingDrive.fetchImpl), taskId, owner: "c", now: NOW, client: firstClient });
    assert.equal(first.outcome, "retry", `(${binding}) a failed readback is a budgeted failure`);
    const afterFail = await rawDb.prepare(
      "SELECT state, failure_count FROM rds2_tasks WHERE task_id = ?"
    ).bind(taskId).first();
    assert.equal(Number(afterFail.failure_count), 1, `(${binding}) the failed pass counts`);
    assert.equal(afterFail.state, "pending", `(${binding}) the task waits out its backoff`);

    // The backoff window passes and the retry succeeds against the SAME Drive
    // bucket: the uploaded object is found by exact lookup, never re-uploaded.
    const later = new Date(Date.parse(NOW) + 31000).toISOString();
    const goodDrive = fakeDriveFetch({ files });
    await dispatchOne({ io: makeIo(goodDrive.fetchImpl), taskId, owner: "d2", now: later });
    const secondClient = createArchiveClient({ env: {}, io: makeIo(goodDrive.fetchImpl), folderId: FOLDER_ID, tokenProvider: async () => "t" });
    const second = await archiveOne({ io: makeIo(goodDrive.fetchImpl), taskId, owner: "c2", now: later, client: secondClient });
    assert.equal(second.outcome, "completed", `(${binding}) ${JSON.stringify(second)}`);
    const done = await rawDb.prepare(
      "SELECT state, failure_count FROM rds2_tasks WHERE task_id = ?"
    ).bind(taskId).first();
    assert.equal(done.state, "completed", `(${binding}) the retry completes the task`);
    assert.equal(Number(done.failure_count), 0,
      `(${binding}) a successful completion clears the consecutive-failure counter`);
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

// ---------------------------------------------------------------------------
// G2-R5 regression: every build page freezes a bounded build package with its
// own archive task, the activation delta carries the build manifest plus the
// final summary, and offline replay reconstructs the active generation
// completely — including summary — refusing missing or foreign packages.
// ---------------------------------------------------------------------------

async function acceptEvents(makeIo, rawDb, count = 8, topic = "r5-topic") {
  for (let index = 1; index <= count; index += 1) {
    const envelope = {
      schemaVersion: "1.2",
      namespace: "algorithm",
      eventType: "algorithm.learning.completed",
      identity: { username: NAME, userId: USER },
      payload: {
        event: {
          schemaVersion: "1.2",
          eventId: `72000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          eventKey: `r5-k-${index}`,
          eventType: "algorithm.learning.completed",
          userId: USER,
          username: NAME,
          observedAt: `2026-09-06T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
          source: "qa",
          topic,
          problem: { title: "P", source: "S", url: "" },
          outcome: index % 2 === 0 ? "correct" : "consulted",
          evidence: "e",
          tags: [],
          confidence: "medium"
        }
      },
      requestId: `req-r5-${index}`
    };
    await acceptEvent({ io: makeIo(), principal: { userId: USER, username: NAME }, envelope, now: NOW });
    const taskId = await rawDb.prepare(
      "SELECT task_id FROM rds2_tasks WHERE type = 'projection' AND state = 'pending' ORDER BY created_at DESC, task_id DESC LIMIT 1"
    ).first("task_id");
    await dispatchOne({ io: makeIo(), taskId, owner: "dispatch", now: NOW });
    await projectOne({ io: makeIo(), taskId, owner: "consumer", now: NOW, reducer: algorithmReducer });
  }
}

test("R5 a multi-page build freezes every page and the activation references them", async () => {
  await runArchiveTest(async ({ binding, rawDb }) => {
    const drive = fakeDriveFetch();
    const makeIo = (limit = 24) => createInvocationIo({
      db: rawDb,
      queues: { RDS2_PROJECTION_QUEUE: { send: async () => {} }, RDS2_ARCHIVE_QUEUE: { send: async () => {} } },
      fetchImpl: drive.fetchImpl, limit
    });
    await acceptEvents(makeIo, rawDb, 8);
    const buildBase = await rawDb.prepare(
      "SELECT revision FROM rds2_projections WHERE user_id = ?"
    ).bind(USER).first("revision");
    await ensureBuild({
      db: rawDb, scope: { userId: USER, namespace: "algorithm", projectionName: "learning" },
      baseRevision: Number(buildBase), now: NOW
    });
    let completed = false;
    for (let guard = 0; guard < 6 && !completed; guard += 1) {
      const nextTask = await rawDb.prepare(
        "SELECT task_id FROM rds2_tasks WHERE type = 'projection_build' AND state = 'pending' LIMIT 1"
      ).first("task_id");
      if (!nextTask) break;
      await dispatchOne({ io: makeIo(), taskId: nextTask, owner: "dispatch", now: NOW });
      const result = await continueBuild({
        io: makeIo(), taskId: nextTask, owner: "builder", now: NOW, reducer: algorithmReducer
      });
      completed = result.outcome === "completed";
    }
    assert.equal(completed, true, `(${binding}) the build activated`);
    const packages = await rawDb.prepare(
      `SELECT object_name, frozen_json, artifact_hash FROM rds2_archive_deliveries WHERE object_type = 'build_package'`
    ).all();
    assert.equal(packages.results.length, 2, `(${binding}) both pages froze a build package`);
    for (const pkg of packages.results) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pkg.frozen_json));
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      assert.equal(pkg.artifact_hash, hex, `(${binding}) the package hash covers its bytes`);
    }
    const deltas = await rawDb.prepare(
      `SELECT frozen_json FROM rds2_archive_deliveries WHERE object_type = 'projection_delta'`
    ).all();
    const activation = deltas.results
      .map((row) => JSON.parse(row.frozen_json))
      .find((delta) => delta.build);
    assert.ok(activation, `(${binding}) the activation delta carries the manifest`);
    assert.equal(activation.build.generation, 1, `(${binding}) the activation names the generation`);
    assert.equal(activation.build.pages, 2, `(${binding}) the activation lists its pages`);
    assert.ok(activation.summary, `(${binding}) the activation carries the final summary`);
    const head = await rawDb.prepare("SELECT summary_json FROM rds2_projections WHERE user_id = ?").bind(USER).first("summary_json");
    assert.equal(JSON.parse(head).counts.attempts, 8, `(${binding}) the built summary counts all events`);
  });
});

test("R5 offline replay needs every build package and reproduces the live projection", async () => {
  await runArchiveTest(async ({ binding, rawDb }) => {
    const drive = fakeDriveFetch();
    const makeIo = (limit = 24) => createInvocationIo({
      db: rawDb,
      queues: { RDS2_PROJECTION_QUEUE: { send: async () => {} }, RDS2_ARCHIVE_QUEUE: { send: async () => {} } },
      fetchImpl: drive.fetchImpl, limit
    });
    await acceptEvents(makeIo, rawDb, 8);
    const buildBase = await rawDb.prepare(
      "SELECT revision FROM rds2_projections WHERE user_id = ?"
    ).bind(USER).first("revision");
    await ensureBuild({
      db: rawDb, scope: { userId: USER, namespace: "algorithm", projectionName: "learning" },
      baseRevision: Number(buildBase), now: NOW
    });
    let completed = false;
    for (let guard = 0; guard < 6 && !completed; guard += 1) {
      const nextTask = await rawDb.prepare(
        "SELECT task_id FROM rds2_tasks WHERE type = 'projection_build' AND state = 'pending' LIMIT 1"
      ).first("task_id");
      if (!nextTask) break;
      await dispatchOne({ io: makeIo(), taskId: nextTask, owner: "dispatch", now: NOW });
      const result = await continueBuild({
        io: makeIo(), taskId: nextTask, owner: "builder", now: NOW, reducer: algorithmReducer
      });
      completed = result.outcome === "completed";
    }
    const deliveries = await rawDb.prepare(
      "SELECT object_type, object_name, frozen_json, artifact_hash FROM rds2_archive_deliveries WHERE user_id = ?"
    ).bind(USER).all();
    const artifacts = deliveries.results.map((row) => ({
      objectType: row.object_type, objectName: row.object_name,
      frozenJson: row.frozen_json, hash: row.artifact_hash
    }));
    const replay = await replayProjection(artifacts);
    // Eight normal commits (revisions 1..8) plus the build activation (9).
    assert.equal(replay.revision, 9);
    const liveRows = await rawDb.prepare(
      "SELECT row_kind, row_key, value_json FROM rds2_projection_rows WHERE user_id = ? AND generation = 1"
    ).bind(USER).all();
    assert.equal(Object.keys(replay.rows).length, liveRows.results.length,
      `(${binding}) replay covers every live row`);
    for (const row of liveRows.results) {
      assert.equal(replay.rows[`${row.row_kind}:${row.row_key}`], row.value_json,
        `(${binding}) replayed row ${row.row_key} matches`);
    }
    const headRow = await rawDb.prepare(
      "SELECT revision, last_event_seq FROM rds2_projections WHERE user_id = ?"
    ).bind(USER).first();
    assert.equal(Number(headRow.last_event_seq), 8,
      `(${binding}) the cursor advanced to the frozen build target`);
    assert.equal(replay.revision, Number(headRow.revision),
      `(${binding}) replay ends on the live revision`);
    const head = await rawDb.prepare("SELECT summary_json FROM rds2_projections WHERE user_id = ?").bind(USER).first("summary_json");
    assert.equal(replay.summary, head, `(${binding}) replay reproduces the summary`);

    // A missing build package must be refused, not silently partial.
    const missingOne = artifacts.filter((artifact) => !(artifact.objectType === "build_package"
      && JSON.parse(artifact.frozenJson).page === 1));
    await assert.rejects(
      () => replayProjection(missingOne),
      (error) => error.code === "replay_missing_page",
      `(${binding}) a missing page must be refused`
    );
    // A package from a foreign scope must be refused as well: the attacker
    // re-signs the hash correctly, so the SCOPE check is what refuses it.
    const foreign = [];
    for (const artifact of artifacts) {
      if (artifact.objectType !== "build_package" || JSON.parse(artifact.frozenJson).page !== 2) {
        foreign.push(artifact);
        continue;
      }
      const data = JSON.parse(artifact.frozenJson);
      data.scope = { userId: "99999999-9999-4999-8999-999999999999", namespace: "algorithm", projectionName: "learning" };
      const tamperedJson = JSON.stringify(data);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tamperedJson));
      const resignedHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      foreign.push({ ...artifact, frozenJson: tamperedJson, hash: resignedHash });
    }
    await assert.rejects(
      () => replayProjection(foreign),
      (error) => error.code === "replay_scope_mismatch",
      `(${binding}) foreign-scope packages must be refused`
    );
  });
});

test("R5 a single-page build freezes exactly one package and replays in any order", async () => {
  await runArchiveTest(async ({ binding, rawDb }) => {
    const drive = fakeDriveFetch();
    const makeIo = (limit = 24) => createInvocationIo({
      db: rawDb,
      queues: { RDS2_PROJECTION_QUEUE: { send: async () => {} }, RDS2_ARCHIVE_QUEUE: { send: async () => {} } },
      fetchImpl: drive.fetchImpl, limit
    });
    // Three events fit in the default page, so the build is one page wide.
    await acceptEvents(makeIo, rawDb, 3);
    const buildBase = await rawDb.prepare(
      "SELECT revision FROM rds2_projections WHERE user_id = ?"
    ).bind(USER).first("revision");
    await ensureBuild({
      db: rawDb, scope: { userId: USER, namespace: "algorithm", projectionName: "learning" },
      baseRevision: Number(buildBase), now: NOW
    });
    let completed = false;
    for (let guard = 0; guard < 6 && !completed; guard += 1) {
      const nextTask = await rawDb.prepare(
        "SELECT task_id FROM rds2_tasks WHERE type = 'projection_build' AND state = 'pending' LIMIT 1"
      ).first("task_id");
      if (!nextTask) break;
      await dispatchOne({ io: makeIo(), taskId: nextTask, owner: "dispatch", now: NOW });
      const result = await continueBuild({
        io: makeIo(), taskId: nextTask, owner: "builder", now: NOW, reducer: algorithmReducer
      });
      completed = result.outcome === "completed";
    }
    assert.equal(completed, true, `(${binding}) the single-page build activated`);
    const packages = await rawDb.prepare(
      "SELECT frozen_json FROM rds2_archive_deliveries WHERE object_type = 'build_package'"
    ).all();
    assert.equal(packages.results.length, 1, `(${binding}) a one-page build freezes exactly one package`);
    const activation = (await rawDb.prepare(
      "SELECT frozen_json FROM rds2_archive_deliveries WHERE object_type = 'projection_delta'"
    ).all()).results.map((row) => JSON.parse(row.frozen_json)).find((delta) => delta.build);
    assert.equal(activation.build.pages, 1, `(${binding}) the manifest lists one page`);
    assert.ok(activation.summary, `(${binding}) the single-page activation keeps the summary`);

    const deliveries = await rawDb.prepare(
      "SELECT object_type, object_name, frozen_json, artifact_hash FROM rds2_archive_deliveries WHERE user_id = ?"
    ).bind(USER).all();
    const artifacts = deliveries.results.map((row) => ({
      objectType: row.object_type, objectName: row.object_name,
      frozenJson: row.frozen_json, hash: row.artifact_hash
    }));
    const forward = await replayProjection(artifacts);
    const shuffled = await replayProjection([...artifacts].reverse());
    assert.deepEqual(shuffled.rows, forward.rows,
      `(${binding}) package order never changes the rebuilt generation`);
    assert.equal(shuffled.summary, forward.summary, `(${binding}) package order never changes the summary`);
    const liveRows = await rawDb.prepare(
      "SELECT row_kind, row_key, value_json FROM rds2_projection_rows WHERE user_id = ? AND generation = 1"
    ).bind(USER).all();
    assert.equal(Object.keys(forward.rows).length, liveRows.results.length,
      `(${binding}) a single page still rebuilds every live row`);
  });
});

// A pure replay test: no database, so the generation switch is checked
// directly against hand-frozen artifacts.
test("R5 replay switches generation and drops rows the superseded generation owned", async () => {
  const scope = { userId: USER, namespace: "algorithm", projectionName: "learning" };
  const freeze = async (data) => {
    const frozenJson = JSON.stringify(data);
    return { objectType: data.kind, objectName: `${data.kind}-${data.revision ?? data.page}.json`, frozenJson, hash: await hashText(frozenJson) };
  };
  const staleDelta = await freeze({
    storageVersion: 2, kind: "projection_delta", scope,
    baseRevision: 0, revision: 1, eventSeq: 1, summary: null, build: null,
    changes: [{ rowKind: "topic", rowKey: "old-topic", value: { name: "old-topic" } }]
  });
  const activation = await freeze({
    storageVersion: 2, kind: "projection_delta", scope,
    baseRevision: 1, revision: 2, eventSeq: 4,
    summary: { counts: { attempts: 4 } },
    build: { buildId: "build-1", generation: 1, pages: 2, firstEventSeq: 1, lastEventSeq: 4 },
    changes: []
  });
  const packageOne = await freeze({
    storageVersion: 2, kind: "build_package", scope,
    buildId: "build-1", generation: 1, page: 1,
    // G2-F3 (R9): the consumed range plus both scan cursors, so replay can
    // prove the windows tile.
    firstEventSeq: 1, lastEventSeq: 2, consumedCount: 2,
    scanFirstCursor: 1, scanCursorAfter: 3, summary: null,
    rowChanges: [{ rowKind: "topic", rowKey: "new-a", value: { name: "new-a" } }]
  });
  const packageTwo = await freeze({
    storageVersion: 2, kind: "build_package", scope,
    buildId: "build-1", generation: 1, page: 2,
    firstEventSeq: 3, lastEventSeq: 4, consumedCount: 2,
    scanFirstCursor: 3, scanCursorAfter: 5,
    summary: { counts: { attempts: 4 } },
    rowChanges: [{ rowKind: "topic", rowKey: "new-b", value: { name: "new-b" } }]
  });
  const replay = await replayProjection([staleDelta, activation, packageTwo, packageOne]);
  assert.equal(replay.revision, 2);
  assert.deepEqual(Object.keys(replay.rows).sort(), ["topic:new-a", "topic:new-b"],
    "replay keeps only the active generation's rows");
  assert.ok(!("topic:old-topic" in replay.rows), "superseded generation rows must not leak");
  assert.equal(JSON.parse(replay.summary).counts.attempts, 4, "the summary survives the activation");

  // A package carrying a foreign generation is not the manifest's page.
  const wrongGeneration = await freeze({ ...JSON.parse(packageOne.frozenJson), generation: 2 });
  await assert.rejects(
    () => replayProjection([staleDelta, activation, wrongGeneration, packageTwo]),
    (error) => error.code === "replay_manifest_invalid",
    "a package from another generation must be refused"
  );
  // A package carrying a foreign buildId is gathered under its OWN buildId,
  // so at manifest level it is indistinguishable from a missing page — and
  // both leave the manifest unprovable.
  const wrongBuild = await freeze({ ...JSON.parse(packageOne.frozenJson), buildId: "build-other" });
  await assert.rejects(
    () => replayProjection([staleDelta, activation, wrongBuild, packageTwo]),
    (error) => error.code === "replay_missing_page",
    "a package from another build must be refused"
  );
  // A duplicate page number leaves the manifest unprovable. The fixture keeps
  // the package COUNT equal to `pages` (three packages, pages = 3) so the
  // count check cannot mask the duplicate: only the page-tiling rule sees it.
  const activationThree = await freeze({
    ...JSON.parse(activation.frozenJson),
    build: { buildId: "build-1", generation: 1, pages: 3, firstEventSeq: 1, lastEventSeq: 4 }
  });
  const duplicatePage = await freeze(JSON.parse(packageTwo.frozenJson));
  await assert.rejects(
    () => replayProjection([staleDelta, activationThree, packageOne, packageTwo, duplicatePage]),
    (error) => error.code === "replay_missing_page",
    "a duplicated page number must be refused"
  );
  // A malformed artifact is never "not found".
  const malformed = { objectType: "build_package", objectName: "bad.json", frozenJson: "{not json", hash: await hashText("{not json") };
  await assert.rejects(
    () => replayProjection([staleDelta, activation, malformed, packageOne, packageTwo]),
    (error) => error.code === "replay_artifact_invalid",
    "an unparseable artifact is a hard failure"
  );
});

// ---------------------------------------------------------------------------
// G2-R5 (验收调整): the "empty terminator page" requirement is replaced by the
// in-place activation contract — when the last NON-EMPTY page consumes up to
// the frozen target, that same call activates; no extra page task is created
// and the summary plus the archive manifest stay complete. The zero-event
// build is a separate path and stays covered.
// ---------------------------------------------------------------------------

const SCOPE = { userId: USER, namespace: "algorithm", projectionName: "learning" };

// Explicit-cap build driver: every business call gets its own invocation io,
// and a build that has not activated when the cap is spent FAILS the test
// instead of silently returning a half-built projection.
async function drainBuild({ binding, makeIo, rawDb, pageSize, maxPages = 8, reducer = algorithmReducer }) {
  const outcomes = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const nextTask = await rawDb.prepare(
      "SELECT task_id FROM rds2_tasks WHERE type = 'projection_build' AND state = 'pending' ORDER BY created_at, task_id LIMIT 1"
    ).first("task_id");
    if (!nextTask) break;
    await dispatchOne({ io: makeIo(), taskId: nextTask, owner: "dispatch", now: NOW });
    const result = await continueBuild({
      io: makeIo(), taskId: nextTask, owner: "builder", now: NOW, reducer,
      ...(pageSize === undefined ? {} : { pageSize })
    });
    outcomes.push({ taskId: nextTask, outcome: result.outcome, code: result.code });
    if (result.outcome === "completed") return outcomes;
  }
  assert.fail(`(${binding}) the build must activate within ${maxPages} page invocations, got ${JSON.stringify(outcomes)}`);
}

test("R5 the last non-empty page reaching the frozen target activates in place", async () => {
  await runArchiveTest(async ({ binding, rawDb }) => {
    const drive = fakeDriveFetch();
    const makeIo = (limit = 24) => createInvocationIo({
      db: rawDb,
      queues: { RDS2_PROJECTION_QUEUE: { send: async () => {} }, RDS2_ARCHIVE_QUEUE: { send: async () => {} } },
      fetchImpl: drive.fetchImpl, limit
    });
    await acceptEvents(makeIo, rawDb, 4);
    const base = await rawDb.prepare(
      "SELECT revision FROM rds2_projections WHERE user_id = ?"
    ).bind(USER).first("revision");
    await ensureBuild({ db: rawDb, scope: SCOPE, baseRevision: Number(base), now: NOW });

    const outcomes = await drainBuild({ binding, makeIo, rawDb, pageSize: 2, maxPages: 6 });
    assert.equal(outcomes.length, 2, `(${binding}) four events at page size 2 take exactly two pages`);

    // Every non-empty page froze a package, and only those two exist.
    const packages = (await rawDb.prepare(
      "SELECT frozen_json FROM rds2_archive_deliveries WHERE object_type = 'build_package'"
    ).all()).results.map((row) => JSON.parse(row.frozen_json));
    assert.equal(packages.length, 2, `(${binding}) both pages froze a build package`);
    assert.deepEqual(packages.map((pkg) => pkg.page).sort((a, b) => a - b), [1, 2],
      `(${binding}) the packages are pages 1 and 2`);

    // Exactly one activation, and its manifest is complete.
    const activations = (await rawDb.prepare(
      "SELECT frozen_json FROM rds2_archive_deliveries WHERE object_type = 'projection_delta'"
    ).all()).results.map((row) => JSON.parse(row.frozen_json)).filter((delta) => delta.build);
    assert.equal(activations.length, 1, `(${binding}) exactly one activation delta`);
    assert.equal(activations[0].build.pages, 2, `(${binding}) the manifest lists both pages`);
    assert.equal(activations[0].build.generation, 1, `(${binding}) the manifest names the generation`);
    assert.equal(activations[0].build.lastEventSeq, 4, `(${binding}) the manifest ends on the frozen target`);

    // No third page task: activation happens in the call that finished the work.
    const buildTasks = await rawDb.prepare(
      "SELECT COUNT(*) AS n FROM rds2_tasks WHERE type = 'projection_build'"
    ).first("n");
    assert.equal(buildTasks, 2, `(${binding}) no extra paging task is created after the final page`);

    // Offline replay reproduces content, summary, cursor and revision.
    const artifacts = (await rawDb.prepare(
      "SELECT object_type, object_name, frozen_json, artifact_hash FROM rds2_archive_deliveries WHERE user_id = ?"
    ).bind(USER).all()).results.map((row) => ({
      objectType: row.object_type, objectName: row.object_name,
      frozenJson: row.frozen_json, hash: row.artifact_hash
    }));
    const replay = await replayProjection(artifacts);
    const head = await rawDb.prepare(
      "SELECT revision, last_event_seq, summary_json FROM rds2_projections WHERE user_id = ?"
    ).bind(USER).first();
    assert.equal(replay.revision, Number(head.revision), `(${binding}) replay ends on the live revision`);
    assert.equal(replay.summary, head.summary_json, `(${binding}) replay reproduces the summary`);
    const liveRows = (await rawDb.prepare(
      "SELECT row_kind, row_key, value_json FROM rds2_projection_rows WHERE user_id = ? AND generation = ?"
    ).bind(USER, 1).all()).results;
    assert.equal(Object.keys(replay.rows).length, liveRows.length, `(${binding}) replay covers every live row`);
    for (const row of liveRows) {
      assert.equal(replay.rows[`${row.row_kind}:${row.row_key}`], row.value_json,
        `(${binding}) replayed row ${row.row_key} matches`);
    }
    assert.equal(Number(head.last_event_seq), 4, `(${binding}) the cursor is the frozen target`);
  });
});

test("R5 a zero-event build activates with an empty manifest and still replays", async () => {
  await runArchiveTest(async ({ binding, rawDb }) => {
    const drive = fakeDriveFetch();
    const makeIo = (limit = 24) => createInvocationIo({
      db: rawDb,
      queues: { RDS2_PROJECTION_QUEUE: { send: async () => {} }, RDS2_ARCHIVE_QUEUE: { send: async () => {} } },
      fetchImpl: drive.fetchImpl, limit
    });
    // A legal, empty projection head: no events, revision 0, nothing building.
    await rawDb.prepare(
      `INSERT INTO rds2_projections (user_id, namespace, projection_name, revision, last_event_seq,
         active_generation, building, summary_json, updated_at)
       VALUES (?, 'algorithm', 'learning', 0, 0, 0, 0, NULL, ?)`
    ).bind(USER, NOW).run();

    await ensureBuild({ db: rawDb, scope: SCOPE, baseRevision: 0, now: NOW });
    const outcomes = await drainBuild({ binding, makeIo, rawDb, maxPages: 4 });
    assert.equal(outcomes.length, 1, `(${binding}) an empty build is one activation call`);

    const packages = (await rawDb.prepare(
      "SELECT COUNT(*) AS n FROM rds2_archive_deliveries WHERE object_type = 'build_package'"
    ).first("n"));
    assert.equal(packages, 0, `(${binding}) there is no non-empty page to freeze`);

    const activations = (await rawDb.prepare(
      "SELECT frozen_json FROM rds2_archive_deliveries WHERE object_type = 'projection_delta'"
    ).all()).results.map((row) => JSON.parse(row.frozen_json)).filter((delta) => delta.build);
    assert.equal(activations.length, 1, `(${binding}) the empty build still activates once`);
    assert.equal(activations[0].build.pages, 0, `(${binding}) the manifest declares zero pages`);
    assert.equal(activations[0].build.lastEventSeq, 0, `(${binding}) the frozen target is zero`);

    const head = await rawDb.prepare(
      "SELECT revision, last_event_seq, active_generation FROM rds2_projections WHERE user_id = ?"
    ).bind(USER).first();
    assert.equal(Number(head.revision), 1, `(${binding}) the revision advanced exactly once`);
    assert.equal(Number(head.last_event_seq), 0, `(${binding}) the cursor stays at zero`);
    assert.equal(Number(head.active_generation), 1, `(${binding}) the generation switched`);

    const artifacts = (await rawDb.prepare(
      "SELECT object_type, object_name, frozen_json, artifact_hash FROM rds2_archive_deliveries WHERE user_id = ?"
    ).bind(USER).all()).results.map((row) => ({
      objectType: row.object_type, objectName: row.object_name,
      frozenJson: row.frozen_json, hash: row.artifact_hash
    }));
    const replay = await replayProjection(artifacts);
    assert.equal(replay.revision, 1, `(${binding}) replay reaches the activated revision`);
    assert.deepEqual(replay.rows, {}, `(${binding}) an empty build replays to no rows`);
  });
});

// ---------------------------------------------------------------------------
// G2-R7 regression: an exact Drive lookup must PROVE its result is complete
// before anybody may conclude "there is no such object" and upload.
// ---------------------------------------------------------------------------

// A Drive stub that answers files.list with exactly the given body; the upload
// endpoint is counted so "no upload happened" stays observable.
function findExactClient(listBody) {
  const state = { uploads: 0, lists: 0, listUrls: [] };
  const io = createInvocationIo({
    db: { prepare: () => { throw new Error("this lookup test never touches D1"); } },
    queues: {},
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.includes("/drive/v3/files?")) {
        state.lists += 1;
        state.listUrls.push(url);
        return new Response(listBody, { status: 200 });
      }
      if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files")) {
        state.uploads += 1;
        return new Response(JSON.stringify({ id: "uploaded-file", name: "a.json" }), { status: 200 });
      }
      return new Response("unexpected call", { status: 500 });
    },
    limit: ARCHIVE_LIMIT
  });
  return {
    state,
    client: createArchiveClient({ env: {}, io, folderId: FOLDER_ID, tokenProvider: async () => "t" })
  };
}

test("R7 the lookup asks Drive to prove completeness", async () => {
  const { client, state } = findExactClient(JSON.stringify({ files: [] }));
  await client.findExact("a.json");
  const url = state.listUrls[0];
  assert.ok(url.includes("nextPageToken"), "the request must ask for nextPageToken");
  assert.ok(url.includes("incompleteSearch"), "the request must ask for incompleteSearch");
  assert.ok(/pageSize=\d+/.test(url), "the request must pin an explicit small pageSize");
});

test("R7 an empty page that carries nextPageToken is refused, never 'not found'", async () => {
  const { client, state } = findExactClient(JSON.stringify({ files: [], nextPageToken: "more" }));
  await assert.rejects(
    () => client.findExact("a.json"),
    (error) => error.code === "drive_search_incomplete",
    "a truncated result set must fail closed"
  );
  assert.equal(state.uploads, 0, "nothing may be uploaded on an incomplete search");
});

test("R7 a single hit that carries nextPageToken is refused too", async () => {
  const { client, state } = findExactClient(JSON.stringify({
    files: [{ id: "f1", name: "a.json" }], nextPageToken: "more"
  }));
  await assert.rejects(
    () => client.findExact("a.json"),
    (error) => error.code === "drive_search_incomplete"
  );
  assert.equal(state.uploads, 0);
});

test("R7 incompleteSearch is refused even without a page token", async () => {
  const { client, state } = findExactClient(JSON.stringify({ files: [], incompleteSearch: true }));
  await assert.rejects(
    () => client.findExact("a.json"),
    (error) => error.code === "drive_search_incomplete"
  );
  assert.equal(state.uploads, 0);
});

test("R7 a malformed or shapeless response is never 'not found'", async () => {
  const bodies = ["{not json", JSON.stringify({ files: "nope" }),
    JSON.stringify({ files: [{ name: "a.json" }] }), JSON.stringify([])];
  for (const body of bodies) {
    const { client, state } = findExactClient(body);
    await assert.rejects(
      () => client.findExact("a.json"),
      (error) => error.code === "drive_response_invalid",
      "a malformed response must not degrade to 'not found'"
    );
    assert.equal(state.uploads, 0);
  }
});

test("R7 a complete single hit is still returned unchanged", async () => {
  const { client, state } = findExactClient(JSON.stringify({ files: [{ id: "f1", name: "a.json" }] }));
  const found = await client.findExact("a.json");
  assert.deepEqual(found, [{ id: "f1", name: "a.json" }]);
  assert.equal(state.uploads, 0);
});

test("R7 an incomplete search never uploads and never marks an artifact delivered", async () => {
  await runArchiveTest(async ({ binding, rawDb }) => {
    const drive = fakeDriveFetch({ listBody: JSON.stringify({ files: [], nextPageToken: "more" }) });
    const makeIo = () => createInvocationIo({
      db: rawDb,
      queues: { RDS2_PROJECTION_QUEUE: { send: async () => {} }, RDS2_ARCHIVE_QUEUE: { send: async () => {} } },
      fetchImpl: drive.fetchImpl, limit: ARCHIVE_LIMIT
    });
    const { taskId } = await seedArtifact(rawDb, {
      objectName: "artifact-r7-incomplete.json", frozenJson: '{"r7":true}', taskId: "arch-r7"
    });
    await dispatchOne({ io: makeIo(), taskId, owner: "d", now: NOW });
    const client = createArchiveClient({
      env: {}, io: makeIo(), folderId: FOLDER_ID, tokenProvider: async () => "t"
    });
    const result = await archiveOne({ io: makeIo(), taskId, owner: "c", now: NOW, client });
    assert.equal(result.code, "drive_search_incomplete", `(${binding}) ${JSON.stringify(result)}`);
    assert.equal(drive.state.uploads, 0, `(${binding}) an incomplete search must not upload`);
    const delivery = await rawDb.prepare(
      "SELECT delivered_at, drive_file_id FROM rds2_archive_deliveries WHERE artifact_id = ?"
    ).bind("artifact-arch-r7").first();
    assert.equal(delivery.delivered_at, null, `(${binding}) nothing is reported as delivered`);
    assert.equal(delivery.drive_file_id, null);
    const task = await rawDb.prepare("SELECT state FROM rds2_tasks WHERE task_id = ?").bind(taskId).first("state");
    assert.notEqual(task, "completed", `(${binding}) the task must not converge on success`);
  });
});

// ---------------------------------------------------------------------------
// G2 coverage fix: one invocation shares ONE budget. A spent budget must stop
// further outbound calls — swapping in a fresh io/client inside the same call
// is not a way around it. A genuinely separate invocation gets its own budget.
// ---------------------------------------------------------------------------

test("R7 two same-name objects park the whole archive task as ambiguous_artifact", async () => {
  await runArchiveTest(async ({ binding, rawDb }) => {
    const frozen = JSON.stringify({ ambiguous: NAME, n: 1 });
    const drive = fakeDriveFetch();
    // Same folder, same name, two different ids — and the lookup is complete:
    // no nextPageToken, no incompleteSearch, so "two hits" is the truth.
    drive.files.set("dup-a", { id: "dup-a", name: "artifact-ambiguous.json", content: '{"someone":"else"}', parent: FOLDER_ID });
    drive.files.set("dup-b", { id: "dup-b", name: "artifact-ambiguous.json", content: '{"another":"owner"}', parent: FOLDER_ID });
    const makeIo = (limit = ARCHIVE_LIMIT) => createInvocationIo({
      db: rawDb,
      queues: { RDS2_PROJECTION_QUEUE: { send: async () => {} }, RDS2_ARCHIVE_QUEUE: { send: async () => {} } },
      fetchImpl: drive.fetchImpl, limit
    });
    const { artifactHash } = await seedArtifact(rawDb, {
      objectName: "artifact-ambiguous.json", frozenJson: frozen, taskId: "arch-amb"
    });
    await dispatchOne({ io: makeIo(), taskId: "arch-amb", owner: "d", now: NOW });
    const client = createArchiveClient({
      env: {}, io: makeIo(), folderId: FOLDER_ID, tokenProvider: async () => "t"
    });
    const result = await archiveOne({ io: makeIo(), taskId: "arch-amb", owner: "c", now: NOW, client });

    assert.equal(result.outcome, "needs_attention", `(${binding}) ${JSON.stringify(result)}`);
    assert.equal(result.code, "ambiguous_artifact", `(${binding}) the ambiguity is named`);
    assert.equal(drive.state.uploads, 0, `(${binding}) neither object is overwritten`);
    assert.equal(drive.state.reads, 0, `(${binding}) neither object is read back — no winner is guessed`);
    const task = await rawDb.prepare("SELECT state FROM rds2_tasks WHERE task_id = ?").bind("arch-amb").first("state");
    assert.equal(task, "needs_attention", `(${binding}) the task parks instead of completing`);
    const delivery = await rawDb.prepare(
      "SELECT delivered_at, drive_file_id, frozen_json, artifact_hash FROM rds2_archive_deliveries WHERE artifact_id = ?"
    ).bind("artifact-arch-amb").first();
    assert.equal(delivery.delivered_at, null, `(${binding}) no successful delivery time is filled in`);
    assert.equal(delivery.drive_file_id, null, `(${binding}) no file id is claimed`);
    assert.equal(delivery.frozen_json, frozen, `(${binding}) the frozen bytes are untouched`);
    assert.equal(delivery.artifact_hash, artifactHash, `(${binding}) the frozen hash is untouched`);
  });
});

test("C5 a spent invocation budget stops Drive calls and only a new invocation gets a fresh one", async () => {
  await runArchiveTest(async ({ binding, rawDb }) => {
    const drive = fakeDriveFetch();
    const makeIo = (limit) => createInvocationIo({
      db: rawDb,
      queues: { RDS2_PROJECTION_QUEUE: { send: async () => {} }, RDS2_ARCHIVE_QUEUE: { send: async () => {} } },
      fetchImpl: drive.fetchImpl, limit
    });
    await seedArtifact(rawDb, {
      objectName: "artifact-budget.json", frozenJson: '{"budget":true}', taskId: "arch-c5"
    });
    const spentIo = makeIo(1);
    await spentIo.db.prepare("SELECT 1").first();
    const spentClient = createArchiveClient({
      env: {}, io: spentIo, folderId: FOLDER_ID, tokenProvider: async () => "t"
    });
    await assert.rejects(
      () => spentClient.findExact("artifact-budget.json"),
      (error) => error.code === "budget_exhausted",
      `(${binding}) the spent budget must stop the Drive call`
    );
    assert.equal(drive.state.lists, 0, `(${binding}) no outbound call was made`);
    assert.equal(drive.state.uploads, 0);
    const freshClient = createArchiveClient({
      env: {}, io: makeIo(16), folderId: FOLDER_ID, tokenProvider: async () => "t"
    });
    assert.deepEqual(await freshClient.findExact("artifact-budget.json"), [],
      `(${binding}) a separate invocation starts from a fresh budget`);
    assert.equal(drive.state.lists, 1, `(${binding}) and counts its own call`);
    // A NEW client handed the SAME exhausted io must not restore anything:
    // swapping clients inside one invocation is not a budget reset.
    const rewrappedClient = createArchiveClient({
      env: {}, io: spentIo, folderId: FOLDER_ID, tokenProvider: async () => "t"
    });
    await assert.rejects(
      () => rewrappedClient.findExact("artifact-budget.json"),
      (error) => error.code === "budget_exhausted",
      `(${binding}) a new client over the same invocation io stays exhausted`
    );
    assert.equal(drive.state.lists, 1, `(${binding}) and no further call went out`);
  });
});

// ---------------------------------------------------------------------------
// G2-F3: a correct hash proves the bytes, not the contract. Replay refuses
// any artifact whose structure or range cannot be proven, and never returns
// a partial result as a complete recovery. Single-failure cases assert the
// EXACT code; nothing here depends on trigger order.
// ---------------------------------------------------------------------------
const F3_SCOPE = { userId: "u-f3", namespace: "algorithm", projectionName: "learning" };
const F3_SCOPE_REORDERED = { projectionName: "learning", namespace: "algorithm", userId: "u-f3" };

async function f3Freeze(data) {
  const frozenJson = JSON.stringify(data);
  return {
    objectType: data.kind,
    objectName: `${data.kind}-${data.revision ?? data.page ?? "x"}.json`,
    frozenJson,
    hash: await hashText(frozenJson)
  };
}

const F3_BASE_DELTA = {
  storageVersion: 2, kind: "projection_delta", scope: F3_SCOPE,
  baseRevision: 0, revision: 1, eventSeq: 1, summary: null, build: null,
  changes: [{ rowKind: "topic", rowKey: "f3-topic", memberKey: null, sortKey: null, value: { n: 1 } }]
};
const F3_ACTIVATION = {
  storageVersion: 2, kind: "projection_delta", scope: F3_SCOPE,
  baseRevision: 1, revision: 2, eventSeq: 4,
  summary: { counts: { attempts: 2 } },
  build: { buildId: "b-f3", generation: 1, pages: 2, firstEventSeq: 1, lastEventSeq: 4 },
  changes: []
};
const F3_PACKAGE_ONE = {
  storageVersion: 2, kind: "build_package", scope: F3_SCOPE,
  buildId: "b-f3", generation: 1, page: 1,
  firstEventSeq: 1, lastEventSeq: 2, consumedCount: 2,
  scanFirstCursor: 1, scanCursorAfter: 3, summary: null,
  rowChanges: [{ rowKind: "topic", rowKey: "f3-a", value: { n: 1 } }]
};
const F3_PACKAGE_TWO = {
  storageVersion: 2, kind: "build_package", scope: F3_SCOPE,
  buildId: "b-f3", generation: 1, page: 2,
  firstEventSeq: 3, lastEventSeq: 4, consumedCount: 2,
  scanFirstCursor: 3, scanCursorAfter: 5, summary: { counts: { attempts: 2 } },
  rowChanges: [{ rowKind: "topic", rowKey: "f3-b", value: { n: 2 } }]
};

async function f3Chain(...datas) {
  const artifacts = [];
  for (const data of datas) artifacts.push(await f3Freeze(data));
  return replayProjection(artifacts);
}

test("F3 replay refuses a delta or package without a complete scope", async () => {
  for (const mutate of [
    (data) => ({ ...data, scope: undefined }),
    (data) => ({ ...data, scope: { ...data.scope, userId: "" } }),
    (data) => ({ ...data, scope: { ...data.scope, namespace: null } }),
    (data) => ({ ...data, scope: { ...data.scope, projectionName: 7 } })
  ]) {
    await assert.rejects(
      () => f3Chain(mutate(F3_BASE_DELTA), F3_ACTIVATION, F3_PACKAGE_ONE, F3_PACKAGE_TWO),
      (error) => error.code === "replay_scope_missing",
      "an artifact without a complete scope must be refused"
    );
  }
});

test("F3 replay refuses a revision that does not chain from its base", async () => {
  await assert.rejects(
    () => f3Chain({ ...F3_BASE_DELTA, revision: 99 }, F3_ACTIVATION),
    (error) => error.code === "replay_revision_not_chained",
    "a revision that skips its base must be refused"
  );
  await assert.rejects(
    () => f3Chain({ ...F3_BASE_DELTA, revision: 1.5 }),
    (error) => error.code === "replay_artifact_invalid",
    "a non-integer revision must be refused"
  );
});

test("F3 replay refuses a replayed cursor that rewinds", async () => {
  // The base delta ends at cursor 5; the activation claims cursor 4.
  await assert.rejects(
    () => f3Chain({ ...F3_BASE_DELTA, eventSeq: 5 }, F3_ACTIVATION),
    (error) => error.code === "replay_revision_not_chained",
    "a rewinding cursor must be refused"
  );
});

test("F3 replay refuses malformed change collections", async () => {
  for (const mutate of [
    (data) => ({ ...data, changes: "not-an-array" }),
    (data) => ({ ...data, changes: [{ rowKind: "topic" }] }),
    (data) => ({ ...data, changes: [{ rowKind: "topic", rowKey: "k", value: undefined }] })
  ]) {
    await assert.rejects(
      () => f3Chain(mutate(F3_BASE_DELTA)),
      (error) => error.code === "replay_artifact_invalid",
      "malformed changes must be refused"
    );
  }
  await assert.rejects(
    () => f3Chain({ ...F3_PACKAGE_ONE, rowChanges: { 0: "x" } }),
    (error) => error.code === "replay_artifact_invalid",
    "a non-array rowChanges must be refused"
  );
});

test("F3 replay refuses a manifest whose pages do not match its range", async () => {
  for (const mutate of [
    (data) => ({ ...data, build: { ...data.build, pages: 0 } }),
    (data) => ({ ...data, build: { ...data.build, pages: 0, firstEventSeq: null, lastEventSeq: null } })
  ]) {
    await assert.rejects(
      () => f3Chain(mutate(F3_ACTIVATION)),
      (error) => error.code === "replay_range_inconsistent",
      "a manifest that cannot prove its range must be refused"
    );
  }
});

test("F3 replay refuses a package whose range and scan window disagree", async () => {
  for (const mutate of [
    (data) => ({ ...data, lastEventSeq: 1 }),
    (data) => ({ ...data, scanCursorAfter: data.scanFirstCursor }),
    (data) => ({ ...data, consumedCount: 0 })
  ]) {
    await assert.rejects(
      () => f3Chain(F3_BASE_DELTA, mutate(F3_PACKAGE_ONE), F3_PACKAGE_TWO, F3_ACTIVATION),
      (error) => error.code === "replay_range_inconsistent",
      "a package whose range contradicts its window must be refused"
    );
  }
});

test("F3 replay refuses windows that do not tile the manifest range", async () => {
  await assert.rejects(
    () => f3Chain(F3_BASE_DELTA, F3_PACKAGE_ONE, { ...F3_PACKAGE_TWO, scanFirstCursor: 4 }, F3_ACTIVATION),
    (error) => error.code === "replay_range_inconsistent",
    "a window seam that does not close must be refused"
  );
  await assert.rejects(
    () => f3Chain(F3_BASE_DELTA, F3_PACKAGE_ONE,
      { ...F3_PACKAGE_TWO, lastEventSeq: 3, scanCursorAfter: 4 }, F3_ACTIVATION),
    (error) => error.code === "replay_range_inconsistent",
    "a window that stops short of the target must be refused"
  );
});

test("F3 replay accepts the legal empty build, reordered scopes and gapped windows", async () => {
  // The zero-event build has exactly one encoding and replays fine.
  const empty = await f3Chain({
    storageVersion: 2, kind: "projection_delta", scope: F3_SCOPE,
    baseRevision: 0, revision: 1, eventSeq: 0, summary: null,
    build: { buildId: "b-empty", generation: 1, pages: 0, firstEventSeq: null, lastEventSeq: 0 },
    changes: []
  });
  assert.deepEqual(empty.rows, {}, "an empty build replays to no rows");
  assert.equal(empty.revision, 1);

  // Key order inside the scope object is irrelevant: comparison is field-wise.
  const ok = await f3Chain(F3_BASE_DELTA, { ...F3_PACKAGE_ONE, scope: F3_SCOPE_REORDERED },
    F3_PACKAGE_TWO, F3_ACTIVATION);
  assert.equal(ok.revision, 2, "a reordered scope object must not be refused");

  // Cross-user sequence gaps INSIDE a window are legal: the windows tile even
  // though the consumed sequence numbers are not contiguous. The activation
  // sits exactly on the manifest's last event (10), not on "the next integer
  // after the last delta" — F3-R1 pins that identity.
  const withGaps = await f3Chain(F3_BASE_DELTA, F3_PACKAGE_ONE,
    { ...F3_PACKAGE_TWO, firstEventSeq: 9, lastEventSeq: 10, consumedCount: 2,
      scanFirstCursor: 3, scanCursorAfter: 11 },
    { ...F3_ACTIVATION, eventSeq: 10,
      build: { buildId: "b-f3", generation: 1, pages: 2, firstEventSeq: 1, lastEventSeq: 10 } });
  assert.equal(withGaps.revision, 2, "windows over gapped sequence numbers still tile");
});

test("F3 replay accepts a partially consumed page", async () => {
  // Page 1 read three events but consumed only the first; page 2 starts at
  // the cursor page 1 ended on. The windows still tile.
  const replay = await f3Chain(F3_BASE_DELTA,
    { ...F3_PACKAGE_ONE, firstEventSeq: 1, lastEventSeq: 1, consumedCount: 1,
      scanFirstCursor: 1, scanCursorAfter: 2 },
    { ...F3_PACKAGE_TWO, firstEventSeq: 2, lastEventSeq: 4, consumedCount: 3,
      scanFirstCursor: 2, scanCursorAfter: 5 },
    F3_ACTIVATION);
  assert.deepEqual(Object.keys(replay.rows).sort(), ["topic:f3-a", "topic:f3-b"],
    "a partially consumed page still replays completely");
});

// ---------------------------------------------------------------------------
// G2 F3-R1 (2026-09-07 implementation review): cross-field consistency the
// validators still missed. A correct hash proves the bytes, not the content:
// an activation whose eventSeq contradicts its manifest, a package claiming
// events before its own scan window, an impossible consumption count and a
// repeated incremental cursor were ALL accepted.
// ---------------------------------------------------------------------------

const F3_ZERO_ACTIVATION = {
  storageVersion: 2, kind: "projection_delta", scope: F3_SCOPE,
  baseRevision: 0, revision: 1, eventSeq: 0, summary: null,
  build: { buildId: "b-empty", generation: 1, pages: 0, firstEventSeq: null, lastEventSeq: 0 },
  changes: []
};

test("F3-R1 replay refuses an activation whose eventSeq contradicts its manifest", async () => {
  // The review's counter-example: a zero-event manifest (pages=0, last=0)
  // with an activation claiming eventSeq=999 was accepted wholesale.
  await assert.rejects(
    () => f3Chain({ ...F3_ZERO_ACTIVATION, eventSeq: 999 }),
    (error) => error.code === "replay_range_inconsistent",
    "an activation must sit exactly on its manifest's last event (0 for an empty build)"
  );
  // The same rule for a non-empty manifest.
  await assert.rejects(
    () => f3Chain(F3_BASE_DELTA, F3_PACKAGE_ONE, F3_PACKAGE_TWO,
      { ...F3_ACTIVATION, eventSeq: 5 }),
    (error) => error.code === "replay_range_inconsistent",
    "a non-empty activation must sit exactly on its manifest target"
  );
});

test("F3-R1 replay refuses a package claiming events before its own scan window", async () => {
  // The review's counter-example: manifest [5,5], package window [5,6) but
  // firstEventSeq=1 — the page claims events it was never handed — and
  // consumedCount=999, which no window of that width could hold.
  const pkg = {
    storageVersion: 2, kind: "build_package", scope: F3_SCOPE,
    buildId: "b-f3", generation: 1, page: 1,
    firstEventSeq: 1, lastEventSeq: 5, consumedCount: 999,
    scanFirstCursor: 5, scanCursorAfter: 6, summary: { counts: { attempts: 9 } },
    rowChanges: [{ rowKind: "topic", rowKey: "f3-x", value: { n: 9 } }]
  };
  const activation = {
    storageVersion: 2, kind: "projection_delta", scope: F3_SCOPE,
    baseRevision: 1, revision: 2, eventSeq: 5, summary: null,
    build: { buildId: "b-f3", generation: 1, pages: 1, firstEventSeq: 5, lastEventSeq: 5 },
    changes: []
  };
  await assert.rejects(
    () => f3Chain(F3_BASE_DELTA, pkg, activation),
    (error) => error.code === "replay_range_inconsistent",
    "a package's consumed range must start at or after its scan window"
  );
  // The impossible count is caught even when the range sits inside the window.
  await assert.rejects(
    () => f3Chain(F3_BASE_DELTA, { ...pkg, firstEventSeq: 5 }, activation),
    (error) => error.code === "replay_range_inconsistent",
    "a consumption count larger than the window's span is impossible"
  );
});

test("F3-R1 replay refuses a count of one whose first and last differ", async () => {
  await assert.rejects(
    () => f3Chain(F3_BASE_DELTA,
      { ...F3_PACKAGE_ONE, firstEventSeq: 1, lastEventSeq: 2, consumedCount: 1,
        scanCursorAfter: 3 },
      { ...F3_PACKAGE_TWO, scanFirstCursor: 3 },
      F3_ACTIVATION),
    (error) => error.code === "replay_range_inconsistent",
    "one consumed event cannot span two sequence numbers"
  );
});

test("F3-R1 replay refuses an incremental delta that repeats its cursor", async () => {
  // Two ordinary deltas claiming the SAME eventSeq would apply one event's
  // effect twice. (An activation restating the target is the sanctioned
  // exception — covered by the positive case below.)
  await assert.rejects(
    () => f3Chain(F3_BASE_DELTA,
      { ...F3_BASE_DELTA, baseRevision: 1, revision: 2, eventSeq: 1 }),
    (error) => error.code === "replay_revision_not_chained",
    "an incremental cursor must strictly advance"
  );
});

test("F3-R1 the first page's first event must be the manifest's first event", async () => {
  // Page 1 scans from the manifest's first event, which the build proved to
  // exist (MIN(event_seq)); a first consumed event after it means the prefix
  // rule was broken somewhere.
  await assert.rejects(
    () => f3Chain(F3_BASE_DELTA,
      { ...F3_PACKAGE_ONE, firstEventSeq: 2, lastEventSeq: 2, consumedCount: 1 },
      { ...F3_PACKAGE_TWO, firstEventSeq: 3, lastEventSeq: 4, consumedCount: 2 },
      F3_ACTIVATION),
    (error) => error.code === "replay_range_inconsistent",
    "the first page must start consuming at the manifest's first event"
  );
});

test("F3-R1 an activation may restate its target while increments must advance", async () => {
  // The rebuild exception: an ordinary incremental delta consumes event 4,
  // and the paged rebuild then ACTIVATES at the same target — the activation
  // replays the identical range, so its cursor may equal the last delta's.
  // (The reverse order — an ordinary delta restating an activation's cursor —
  // would consume one event twice and stays refused.)
  const replay = await f3Chain(F3_BASE_DELTA,
    {
      storageVersion: 2, kind: "projection_delta", scope: F3_SCOPE,
      baseRevision: 1, revision: 2, eventSeq: 4, summary: { counts: { attempts: 2 } },
      build: null,
      changes: [
        { rowKind: "topic", rowKey: "f3-a", memberKey: null, sortKey: null, value: { n: 2 } },
        { rowKind: "topic", rowKey: "f3-b", memberKey: null, sortKey: null, value: { n: 2 } }
      ]
    },
    F3_PACKAGE_ONE, F3_PACKAGE_TWO,
    { ...F3_ACTIVATION, baseRevision: 2, revision: 3 });
  assert.equal(replay.revision, 3,
    "an activation restating the target of the last ordinary delta is legal");
});
