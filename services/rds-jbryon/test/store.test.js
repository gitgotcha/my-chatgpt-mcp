// RDS-JBryon D1 store integration tests (design §15: J01, J02, J03, J07/J08,
// J09, J11, J13, J14/J15, J16, J17, J20, J21, J24, J31, J34 + a partial J23
// paged-deletion check).
//
// Every test runs the SAME callback twice through withD1: once against the
// node:sqlite D1 simulator and once against a real Miniflare/workerd D1
// binding. Both runs apply the shipped migrations/0001_rds_jbryon.sql, so the
// schema and its triggers are part of what is verified.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { withD1, applySchema } from "./support/d1.js";
import { createRdsStore, initWorkspace, DELETE_PAGE_SIZE } from "../src/store.js";
import { API_VERSION, PROTOCOL, RdsError } from "../src/contracts.js";

const SQL = readFileSync(new URL("../migrations/0001_rds_jbryon.sql", import.meta.url), "utf8");
const EPOCH = "0123456789abcdef0123456789abcdef";
const OTHER_EPOCH = "fedcba9876543210fedcba9876543210";
const T0 = "2026-10-26T00:00:00.000Z";

const clock = (start = T0) => {
  let current = start;
  const now = () => current;
  now.advance = (seconds) => {
    current = new Date(Date.parse(current) + seconds * 1000).toISOString();
    return current;
  };
  return now;
};

let requestSeq = 0;
const nextRequestId = () => `req-${String((requestSeq += 1)).padStart(8, "0")}`;

const request = (overrides = {}) => ({
  protocol: PROTOCOL,
  apiVersion: API_VERSION,
  workspaceEpoch: EPOCH,
  requestId: overrides.requestId ?? nextRequestId(),
  operation: "directory.create",
  target: { path: ["project"], kind: "domain" },
  ...overrides
});

async function setup(db) {
  await applySchema(db, SQL);
  await initWorkspace(db, { epoch: EPOCH });
  const now = clock();
  const store = createRdsStore({ db, now, epoch: EPOCH });
  return { db, store, now };
}

const withStore = (callback) => withD1(async (backend, db) => {
  const ctx = await setup(db);
  ctx.backend = backend;
  await callback(ctx);
});

async function rejectedCode(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof RdsError, `expected RdsError, got ${error?.constructor?.name}: ${error?.message}`);
    return error.code;
  }
  return null;
}

async function failureMessage(promise) {
  try {
    await promise;
  } catch (error) {
    return String(error?.message ?? error);
  }
  return null;
}

async function countRows(db, table, where = "", ...args) {
  const row = await db.prepare(`SELECT COUNT(1) AS n FROM ${table} ${where}`).bind(...args).first();
  return Number(row?.n ?? 0);
}

async function oneRow(db, sql, ...args) {
  return (await db.prepare(sql).bind(...args).first()) ?? null;
}

async function acceptProjected(ctx, overrides) {
  const envelope = request(overrides);
  const accepted = await ctx.store.accept(envelope);
  const run = await ctx.store.projectAll({ owner: "worker-1" });
  const own = run.results.find((result) => result.requestId === envelope.requestId);
  assert.ok(own, `no projection result for ${envelope.requestId}`);
  assert.equal(own.ok, true, `projection failed: ${JSON.stringify(own)}`);
  return { envelope, accepted, result: own, effect: own.effect };
}

async function seedProjectTree(ctx) {
  const project = await acceptProjected(ctx, {
    operation: "directory.create",
    target: { path: ["project"], kind: "domain" }
  });
  const project12306 = await acceptProjected(ctx, {
    operation: "directory.create",
    target: { path: ["project", "12306"], kind: "directory" }
  });
  const unit = await acceptProjected(ctx, {
    operation: "directory.create",
    target: { parentId: project12306.accepted.targetNodeId, name: "余票展示", kind: "directory" }
  });
  const snapshot = await acceptProjected(ctx, {
    operation: "snapshot.create",
    target: { parentId: unit.accepted.targetNodeId, name: "学习快照.json" },
    changes: [
      { op: "set", path: ["title"], value: "12306 学习快照" },
      { op: "set", path: ["nextUnit"], value: "锁" }
    ]
  });
  return { project, project12306, unit, snapshot };
}

const effectOf = async (ctx, requestId) => (await ctx.store.requestStatus({ requestId })).effect;

// ---------------------------------------------------------------------------
test("J01 single-user workspace: fixed product, epoch and no user/Drive schema", async () => {
  await withStore(async (ctx) => {
    const capabilities = await ctx.store.capabilities();
    assert.deepEqual(capabilities, {
      product: "RDS-JBryon",
      protocol: PROTOCOL,
      apiVersion: API_VERSION,
      workspaceEpoch: EPOCH,
      catalogRevision: 0
    });

    const tables = (await ctx.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all())
      .results.map((row) => row.name);
    for (const required of [
      "workspace_meta", "nodes", "requests", "events", "tasks", "snapshots",
      "snapshot_versions", "conflicts", "deletion_gates", "commit_guards"
    ]) {
      assert.ok(tables.includes(required), `missing table ${required}`);
    }
    assert.ok(
      !tables.some((name) => /user|account|credential|register|drive|archive/i.test(name)),
      `single-user schema must not contain user/Drive tables: ${tables.join(",")}`
    );

    // No username/userId is accepted anywhere in the protocol envelope.
    assert.equal(await rejectedCode(ctx.store.accept(request({ user: "乔炳源" }))), "invalid_request");
    // An old workspace epoch is refused instead of being replayed.
    assert.equal(
      await rejectedCode(ctx.store.accept(request({ workspaceEpoch: OTHER_EPOCH }))),
      "workspace_epoch_mismatch"
    );
    // Read operations never enter the write path.
    assert.equal(
      await rejectedCode(ctx.store.accept(request({ operation: "directory.list" }))),
      "unsupported_operation"
    );
    assert.equal(await countRows(ctx.db, "requests"), 0);
    assert.equal(await countRows(ctx.db, "events"), 0);
  });
});

// ---------------------------------------------------------------------------
test("J02 Chinese multi-level directories: create, resolve, page, invalid and duplicate names", async () => {
  await withStore(async (ctx) => {
    await acceptProjected(ctx, { operation: "directory.create", target: { path: ["project"], kind: "domain" } });
    await acceptProjected(ctx, { operation: "directory.create", target: { path: ["project", "12306"], kind: "directory" } });
    const unit = await acceptProjected(ctx, {
      operation: "directory.create",
      target: { parentId: (await ctx.store.resolvePath(["project", "12306"])).nodeId, name: "余票展示", kind: "directory" }
    });
    await acceptProjected(ctx, { operation: "directory.create", target: { path: ["knowledge"], kind: "domain" } });
    await acceptProjected(ctx, { operation: "directory.create", target: { path: ["knowledge", "java"], kind: "directory" } });

    const resolved = await ctx.store.resolvePath(["project", "12306", "余票展示"]);
    assert.equal(resolved.nodeId, unit.accepted.targetNodeId);
    assert.equal(resolved.name, "余票展示");
    assert.deepEqual(resolved.path, ["project", "12306", "余票展示"]);

    const parentId = (await ctx.store.resolvePath(["project", "12306"])).nodeId;
    const listed = await ctx.store.listDirectory({ parentId });
    assert.deepEqual(listed.nodes.map((node) => node.name), ["余票展示"]);
    assert.equal(listed.nodes[0].kind, "directory");
    assert.equal(listed.complete, true);
    assert.ok(listed.rowsRead >= 1);

    const page0 = await ctx.store.listDirectory({ limit: 1 });
    assert.deepEqual(page0.nodes.map((node) => node.name), ["knowledge"]);
    assert.equal(page0.complete, false);
    assert.ok(page0.cursor);
    const page1 = await ctx.store.listDirectory({ limit: 1, cursor: page0.cursor });
    assert.deepEqual(page1.nodes.map((node) => node.name), ["project"]);

    for (const badName of ["a/b", "a\\b", ".", "..", ""]) {
      assert.equal(
        await rejectedCode(ctx.store.accept(request({
          operation: "directory.create",
          target: { parentId, name: badName, kind: "directory" }
        }))),
        "invalid_name",
        `accepted bad name ${JSON.stringify(badName)}`
      );
    }
    assert.equal(
      await rejectedCode(ctx.store.accept(request({
        operation: "directory.create",
        target: { path: "project/12306", kind: "directory" }
      }))),
      "invalid_path"
    );

    // Same sibling name after NFC normalization is refused.
    await acceptProjected(ctx, {
      operation: "directory.create",
      target: { parentId, name: "e\u0301", kind: "directory" }
    });
    assert.equal(
      await rejectedCode(ctx.store.accept(request({
        operation: "directory.create",
        target: { parentId, name: "\u00e9", kind: "directory" }
      }))),
      "name_conflict"
    );

    assert.equal(await rejectedCode(ctx.store.resolvePath(["project", "missing"])), "target_not_found");
    assert.equal(
      await rejectedCode(ctx.store.accept(request({
        operation: "snapshot.patch",
        target: { path: ["project", "missing.json"] },
        baseRevision: 0,
        changes: [{ op: "set", path: ["x"], value: 1 }]
      }))),
      "target_not_found"
    );
  });
});

// ---------------------------------------------------------------------------
test("J03 snapshot.query reads only subtree metadata, never unrelated bodies", async () => {
  await withStore(async (ctx) => {
    const tree = await seedProjectTree(ctx);
    await acceptProjected(ctx, {
      operation: "snapshot.create",
      target: { parentId: tree.project12306.accepted.targetNodeId, name: "项目概览.json" },
      changes: [{ op: "set", path: ["secret"], value: "UNRELATED-BODY-MARKER" }]
    });
    const snapshotNodeId = tree.snapshot.accepted.targetNodeId;

    const queried = await ctx.store.snapshotQuery({ nodeId: snapshotNodeId });
    assert.equal(queried.contentRead, false);
    assert.equal(queried.contentBytesRead, 0);
    assert.equal(queried.root.nodeId, snapshotNodeId);
    assert.deepEqual(queried.nodes.map((node) => node.nodeId), [snapshotNodeId]);
    assert.ok(!JSON.stringify(queried).includes("UNRELATED-BODY-MARKER"));
    assert.ok(!JSON.stringify(queried).includes("12306 学习快照"));
    assert.ok(queried.rowsRead >= 1);

    const unitQuery = await ctx.store.snapshotQuery({ nodeId: tree.unit.accepted.targetNodeId });
    assert.deepEqual(
      unitQuery.nodes.map((node) => node.name).sort(),
      ["余票展示", "学习快照.json"].sort()
    );
    assert.ok(!JSON.stringify(unitQuery).includes("UNRELATED-BODY-MARKER"));
    assert.ok(!JSON.stringify(unitQuery).includes("12306 学习快照"));
  });
});

// ---------------------------------------------------------------------------
test("J07/J08 requestId idempotency: one effect, request_id_conflict, replay after lost response", async () => {
  await withStore(async (ctx) => {
    const domain = await acceptProjected(ctx, {
      operation: "directory.create",
      target: { path: ["project"], kind: "domain" }
    });
    const envelope = request({
      operation: "snapshot.create",
      target: { parentId: domain.accepted.targetNodeId, name: "学习快照.json" },
      changes: [{ op: "set", path: ["title"], value: "第一版" }]
    });
    const first = await ctx.store.accept(envelope);
    const second = await ctx.store.accept(envelope);
    assert.equal(second.duplicate, true);
    assert.equal(second.effect, "pending");
    assert.equal(second.eventId, first.eventId);
    assert.equal(second.taskId, first.taskId);
    assert.equal(await countRows(ctx.db, "events", "WHERE request_id = ?", envelope.requestId), 1);
    assert.equal(
      await countRows(ctx.db, "tasks", "WHERE event_seq IN (SELECT event_seq FROM events WHERE request_id = ?)", envelope.requestId),
      1
    );

    const run = await ctx.store.projectAll({ owner: "worker-1" });
    assert.ok(run.results.some((result) => result.requestId === envelope.requestId && result.effect === "applied"));

    const replay = await ctx.store.accept(envelope);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.effect, "applied");
    assert.equal(replay.eventId, first.eventId);
    assert.equal(await countRows(ctx.db, "events", "WHERE request_id = ?", envelope.requestId), 1);

    assert.equal(
      await rejectedCode(ctx.store.accept({ ...envelope, changes: [{ op: "set", path: ["title"], value: "第二版" }] })),
      "request_id_conflict"
    );
    assert.equal(await effectOf(ctx, envelope.requestId), "applied");
  });
});

// ---------------------------------------------------------------------------
test("J09 a failing accept or projection batch leaves no orphan or partial rows", async () => {
  await withStore(async (ctx) => {
    // The poison statement is valid SQL that fails at execution time (CHECK),
    // so every earlier statement in the same batch must be rolled back.
    const poison = ctx.db.prepare(
      "INSERT INTO nodes (node_id, lifecycle, created_at, updated_at) VALUES ('poison', 'bogus', 'x', 'x')"
    );
    const failingDb = {
      prepare: (sql) => ctx.db.prepare(sql),
      exec: (sql) => ctx.db.exec(sql),
      batch: async (statements) => ctx.db.batch([...statements, poison])
    };
    const failingStore = createRdsStore({ db: failingDb, now: ctx.now, epoch: EPOCH });
    const acceptFailure = await failureMessage(
      failingStore.accept(request({ target: { path: ["project"], kind: "domain" } }))
    );
    assert.match(acceptFailure, /CHECK constraint failed/i);
    assert.equal(await countRows(ctx.db, "requests"), 0);
    assert.equal(await countRows(ctx.db, "events"), 0);
    assert.equal(await countRows(ctx.db, "tasks"), 0);
    assert.equal(await countRows(ctx.db, "deletion_gates"), 0);

    // A failing projection batch must not partially write snapshot/version/effect.
    const tree = await seedProjectTree(ctx);
    const snapshotNodeId = tree.snapshot.accepted.targetNodeId;
    const envelope = request({
      operation: "snapshot.patch",
      target: { nodeId: snapshotNodeId },
      baseRevision: 1,
      changes: [{ op: "set", path: ["nextUnit"], value: "令牌桶" }]
    });
    await ctx.store.accept(envelope);
    const lease = await ctx.store.claimTask({ owner: "worker-x" });
    const failingProjectionStore = createRdsStore({ db: failingDb, now: ctx.now, epoch: EPOCH });
    const outcome = await failingProjectionStore.applyOne({
      taskId: lease.taskId, owner: "worker-x", epoch: lease.epoch
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, "commit_failed");
    assert.equal(await effectOf(ctx, envelope.requestId), "pending");
    const snapshotRow = await oneRow(ctx.db, "SELECT revision FROM snapshots WHERE node_id = ?", snapshotNodeId);
    assert.equal(Number(snapshotRow.revision), 1);
    assert.equal(await countRows(ctx.db, "snapshot_versions", "WHERE node_id = ?", snapshotNodeId), 1);
    const taskRow = await oneRow(ctx.db, "SELECT state, failure_count FROM tasks WHERE task_id = ?", lease.taskId);
    assert.equal(taskRow.state, "pending");
    assert.equal(Number(taskRow.failure_count), 1);
  });
});

// ---------------------------------------------------------------------------
test("J11/J17 a dependency needs a real applied effect; unrelated work is not blocked", async () => {
  await withStore(async (ctx) => {
    const a = request({ operation: "directory.create", target: { path: ["project"], kind: "domain" } });
    const acceptedA = await ctx.store.accept(a);
    const b = request({
      operation: "snapshot.create",
      target: { parentId: acceptedA.targetNodeId, name: "学习快照.json" },
      dependsOn: [a.requestId],
      changes: [{ op: "set", path: ["title"], value: "等待父目录" }]
    });
    const acceptedB = await ctx.store.accept(b);
    const frozenEvent = await oneRow(ctx.db, "SELECT depends_on_json FROM events WHERE request_id = ?", b.requestId);
    assert.deepEqual(JSON.parse(frozenEvent.depends_on_json), [a.requestId]);
    const c = request({ operation: "directory.create", target: { path: ["knowledge"], kind: "domain" } });
    await ctx.store.accept(c);

    const statusB = await ctx.store.requestStatus({ requestId: b.requestId });
    assert.equal(statusB.effect, "pending");
    assert.equal(statusB.dependency.ready, false);
    assert.equal(statusB.dependency.code, "dependency_pending");

    const leaseA = await ctx.store.claimTask({ owner: "worker-1" });
    assert.equal(leaseA.taskId, acceptedA.taskId);
    // B is skipped while A is only accepted; C is independent and claimable.
    const leaseC = await ctx.store.claimTask({ owner: "worker-1" });
    const taskC = await oneRow(
      ctx.db,
      "SELECT task_id FROM tasks WHERE event_seq = (SELECT event_seq FROM events WHERE request_id = ?)",
      c.requestId
    );
    assert.equal(leaseC.taskId, taskC.task_id);

    await ctx.store.applyOne({ taskId: leaseA.taskId, owner: "worker-1", epoch: leaseA.epoch });
    await ctx.store.applyOne({ taskId: leaseC.taskId, owner: "worker-1", epoch: leaseC.epoch });
    assert.equal(await effectOf(ctx, a.requestId), "applied");
    assert.equal(await effectOf(ctx, c.requestId), "applied");
    assert.equal(await effectOf(ctx, b.requestId), "pending");
    assert.equal((await ctx.store.requestStatus({ requestId: b.requestId })).dependency.ready, true);

    const leaseB = await ctx.store.claimTask({ owner: "worker-1" });
    assert.equal(leaseB.taskId, acceptedB.taskId);
    await ctx.store.applyOne({ taskId: leaseB.taskId, owner: "worker-1", epoch: leaseB.epoch });
    assert.equal(await effectOf(ctx, b.requestId), "applied");

    assert.equal(
      await rejectedCode(ctx.store.accept(request({
        operation: "directory.create",
        target: { path: ["other"], kind: "domain" },
        dependsOn: ["req-missing-0001"]
      }))),
      "dependency_missing"
    );
  });
});

test("J18 a persisted dependency on a conflicted request requires a new plan", async () => {
  await withStore(async (ctx) => {
    const tree = await seedProjectTree(ctx);
    const snapshotId = tree.snapshot.accepted.targetNodeId;
    const first = request({
      operation: "snapshot.patch", target: { nodeId: snapshotId }, baseRevision: 1,
      changes: [{ op: "set", path: ["answer"], value: "A" }]
    });
    const competing = request({
      operation: "snapshot.patch", target: { nodeId: snapshotId }, baseRevision: 1,
      changes: [{ op: "set", path: ["answer"], value: "B" }]
    });
    await ctx.store.accept(first);
    await ctx.store.accept(competing);
    await ctx.store.projectAll({ owner: "worker-1" });
    assert.equal(await effectOf(ctx, first.requestId), "applied");
    assert.equal(await effectOf(ctx, competing.requestId), "conflict");

    const dependent = request({
      operation: "snapshot.patch", target: { nodeId: snapshotId }, baseRevision: 2,
      dependsOn: [competing.requestId],
      changes: [{ op: "set", path: ["nextUnit"], value: "锁座" }]
    });
    await ctx.store.accept(dependent);
    const event = await oneRow(ctx.db, "SELECT depends_on_json FROM events WHERE request_id = ?", dependent.requestId);
    assert.deepEqual(JSON.parse(event.depends_on_json), [competing.requestId]);
    const status = await ctx.store.requestStatus({ requestId: dependent.requestId });
    assert.equal(status.effect, "pending");
    assert.equal(status.dependency.ready, false);
    assert.equal(status.dependency.code, "dependency_replan_required");
  });
});

// ---------------------------------------------------------------------------
test("J13 a stale owner/epoch commit is rejected atomically", async () => {
  await withStore(async (ctx) => {
    const tree = await seedProjectTree(ctx);
    const snapshotNodeId = tree.snapshot.accepted.targetNodeId;
    const envelope = request({
      operation: "snapshot.patch",
      target: { nodeId: snapshotNodeId },
      baseRevision: 1,
      changes: [{ op: "set", path: ["nextUnit"], value: "令牌桶" }]
    });
    await ctx.store.accept(envelope);

    const leaseA = await ctx.store.claimTask({ owner: "worker-a" });
    assert.equal(leaseA.owner, "worker-a");
    ctx.now.advance(400); // the lease expires
    const leaseB = await ctx.store.claimTask({ owner: "worker-b" });
    assert.equal(leaseB.taskId, leaseA.taskId);
    assert.equal(leaseB.epoch, leaseA.epoch + 1);
    assert.equal(leaseB.owner, "worker-b");

    const stale = await ctx.store.applyOne({
      taskId: leaseA.taskId, owner: "worker-a", epoch: leaseA.epoch
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, "stale_commit");

    // Nothing from the stale attempt landed: no content, no version, no effect,
    // no completed task.
    const snapshotNow = await ctx.store.readSnapshot({ nodeId: snapshotNodeId });
    assert.equal(snapshotNow.revision, 1);
    assert.deepEqual(snapshotNow.content, { title: "12306 学习快照", nextUnit: "锁" });
    assert.equal(await countRows(ctx.db, "snapshot_versions", "WHERE node_id = ?", snapshotNodeId), 1);
    assert.equal(await effectOf(ctx, envelope.requestId), "pending");
    const taskRow = await oneRow(ctx.db, "SELECT state, lease_owner, lease_epoch FROM tasks WHERE task_id = ?", leaseA.taskId);
    assert.equal(taskRow.state, "processing");
    assert.equal(taskRow.lease_owner, "worker-b");
    assert.equal(Number(taskRow.lease_epoch), leaseB.epoch);

    const applied = await ctx.store.applyOne({ taskId: leaseB.taskId, owner: "worker-b", epoch: leaseB.epoch });
    assert.equal(applied.ok, true);
    assert.equal(applied.effect, "applied");
    assert.equal((await ctx.store.readSnapshot({ nodeId: snapshotNodeId })).revision, 2);
    assert.equal(await countRows(ctx.db, "snapshot_versions", "WHERE node_id = ?", snapshotNodeId), 2);
  });
});

// ---------------------------------------------------------------------------
test("J14/J15 independent fields and itemIds merge; same-field conflicts keep both sides", async () => {
  await withStore(async (ctx) => {
    const tree = await seedProjectTree(ctx);
    const nodeId = tree.snapshot.accepted.targetNodeId;
    const itemPatch = (itemId, answer, baseRevision) => ({
      operation: "snapshot.patch",
      target: { nodeId },
      baseRevision,
      changes: [{ op: "item_set", field: "attempts", itemId, value: { answer } }]
    });

    const first = await acceptProjected(ctx, itemPatch("attempt-A", "首答", 1));
    assert.equal(first.effect, "applied");
    // Different itemId on the same base merges automatically.
    const second = await acceptProjected(ctx, itemPatch("attempt-B", "复答", 1));
    assert.equal(second.effect, "applied");
    const afterItems = await ctx.store.readSnapshot({ nodeId });
    assert.deepEqual(afterItems.content.attempts["attempt-A"], { answer: "首答" });
    assert.deepEqual(afterItems.content.attempts["attempt-B"], { answer: "复答" });
    assert.equal(afterItems.revision, 3);

    // Independent field merges against a base that is no longer the head.
    const independent = await acceptProjected(ctx, {
      operation: "snapshot.patch",
      target: { nodeId },
      baseRevision: 1,
      changes: [{ op: "set", path: ["owner"], value: "乔炳源" }]
    });
    assert.equal(independent.effect, "applied");
    const merged = await ctx.store.readSnapshot({ nodeId });
    assert.equal(merged.content.owner, "乔炳源");
    assert.deepEqual(merged.content.attempts["attempt-A"], { answer: "首答" });

    // Same field: the second writer gets a conflict; both values are kept.
    const headRevision = merged.revision;
    const winner = await acceptProjected(ctx, {
      operation: "snapshot.patch",
      target: { nodeId },
      baseRevision: headRevision,
      changes: [{ op: "set", path: ["nextUnit"], value: "选座锁座" }]
    });
    assert.equal(winner.effect, "applied");
    const conflictEnvelope = request({
      operation: "snapshot.patch",
      target: { nodeId },
      baseRevision: headRevision,
      changes: [{ op: "set", path: ["nextUnit"], value: "令牌桶" }]
    });
    await ctx.store.accept(conflictEnvelope);
    await ctx.store.projectAll({ owner: "worker-1" });
    assert.equal(await effectOf(ctx, conflictEnvelope.requestId), "conflict");
    const conflicted = await ctx.store.readSnapshot({ nodeId });
    assert.equal(conflicted.content.nextUnit, "选座锁座");

    const open = await ctx.store.conflictList({ nodeId });
    assert.equal(open.conflicts.length, 1);
    assert.equal(open.conflicts[0].status, "open");
    assert.equal(open.conflicts[0].requestId, conflictEnvelope.requestId);
    assert.deepEqual(open.conflicts[0].details.path, ["nextUnit"]);
    assert.equal(open.conflicts[0].details.base, "锁");
    assert.equal(open.conflicts[0].details.current, "选座锁座");
    assert.equal(open.conflicts[0].details.proposed, "令牌桶");

    // Only a new request resolves the conflict; the old one stays conflict and
    // is linked through resolvedBy (it is never replayed as applied).
    const resolution = await acceptProjected(ctx, {
      operation: "conflict.resolve",
      target: { nodeId },
      changes: [{ op: "set", path: ["nextUnit"], value: "令牌桶" }]
    });
    assert.equal(resolution.effect, "applied");
    assert.equal((await ctx.store.readSnapshot({ nodeId })).content.nextUnit, "令牌桶");
    assert.equal((await ctx.store.conflictList({ nodeId })).conflicts.length, 0);
    const resolved = await ctx.store.conflictList({ nodeId, status: "resolved" });
    assert.equal(resolved.conflicts[0].resolvedBy, resolution.envelope.requestId);
    const originalStatus = await ctx.store.requestStatus({ requestId: conflictEnvelope.requestId });
    assert.equal(originalStatus.effect, "conflict");
    assert.equal(originalStatus.resolvedBy, resolution.envelope.requestId);
  });
});

// ---------------------------------------------------------------------------
test("J16 an open conflict does not block later independent writes to the same file", async () => {
  await withStore(async (ctx) => {
    const tree = await seedProjectTree(ctx);
    const nodeId = tree.snapshot.accepted.targetNodeId;
    const base = 1;

    await acceptProjected(ctx, {
      operation: "snapshot.patch",
      target: { nodeId },
      baseRevision: base,
      changes: [{ op: "set", path: ["nextUnit"], value: "选座锁座" }]
    });
    const loser = request({
      operation: "snapshot.patch",
      target: { nodeId },
      baseRevision: base,
      changes: [{ op: "set", path: ["nextUnit"], value: "令牌桶" }]
    });
    await ctx.store.accept(loser);
    await ctx.store.projectAll({ owner: "worker-1" });
    assert.equal(await effectOf(ctx, loser.requestId), "conflict");

    // A later event that does not depend on the conflicted request projects.
    const independent = await acceptProjected(ctx, {
      operation: "snapshot.patch",
      target: { nodeId },
      baseRevision: base + 1,
      changes: [{ op: "set", path: ["title"], value: "冲突后的独立修改" }]
    });
    assert.equal(independent.effect, "applied");
    assert.equal((await ctx.store.readSnapshot({ nodeId })).content.title, "冲突后的独立修改");

    // A dependent request however stays blocked with an explicit replan code.
    const dependent = await ctx.store.accept(request({
      operation: "snapshot.patch",
      target: { nodeId },
      baseRevision: base + 1,
      dependsOn: [loser.requestId],
      changes: [{ op: "set", path: ["note"], value: "依赖冲突请求" }]
    }));
    const dependentStatus = await ctx.store.requestStatus({ requestId: dependent.requestId });
    assert.equal(dependentStatus.dependency.ready, false);
    assert.equal(dependentStatus.dependency.code, "dependency_replan_required");
    assert.equal(await ctx.store.claimTask({ owner: "worker-1" }), null);
    assert.equal(await effectOf(ctx, dependent.requestId), "pending");
  });
});

// ---------------------------------------------------------------------------
test("J04 (partial) rename/move keep node identity and reject cycles or duplicates", async () => {
  await withStore(async (ctx) => {
    const tree = await seedProjectTree(ctx);
    const unitId = tree.unit.accepted.targetNodeId;
    const projectId = tree.project.accepted.targetNodeId;
    const project12306Id = tree.project12306.accepted.targetNodeId;
    const snapshotId = tree.snapshot.accepted.targetNodeId;
    await acceptProjected(ctx, { operation: "directory.create", target: { path: ["knowledge"], kind: "domain" } });
    const java = await acceptProjected(ctx, {
      operation: "directory.create",
      target: { path: ["knowledge", "java"], kind: "directory" }
    });
    const alpha = await acceptProjected(ctx, {
      operation: "directory.create",
      target: { parentId: projectId, name: "alpha", kind: "directory" }
    });
    // A same-named directory already inside 12306 blocks moving alpha there.
    await acceptProjected(ctx, {
      operation: "directory.create",
      target: { parentId: project12306Id, name: "alpha", kind: "directory" }
    });

    const renamed = await acceptProjected(ctx, {
      operation: "directory.rename",
      target: { nodeId: unitId, name: "余票展示-改名" }
    });
    assert.equal(renamed.effect, "applied");
    assert.equal((await ctx.store.resolvePath(["project", "12306", "余票展示-改名"])).nodeId, unitId);
    assert.equal(await rejectedCode(ctx.store.resolvePath(["project", "12306", "余票展示"])), "target_not_found");

    // The snapshot child still belongs to the same stable node id.
    assert.equal((await ctx.store.readSnapshot({ nodeId: snapshotId })).revision, 1);

    // Cycles: into itself and into its own descendant are refused at accept.
    assert.equal(
      await rejectedCode(ctx.store.accept(request({
        operation: "directory.move",
        target: { nodeId: unitId, parentId: unitId }
      }))),
      "invalid_target"
    );
    assert.equal(
      await rejectedCode(ctx.store.accept(request({
        operation: "directory.move",
        target: { nodeId: projectId, parentId: unitId }
      }))),
      "invalid_target"
    );

    // A real move across domains keeps the node id and its children.
    const moved = await acceptProjected(ctx, {
      operation: "directory.move",
      target: { nodeId: unitId, parentId: java.accepted.targetNodeId }
    });
    assert.equal(moved.effect, "applied");
    assert.equal((await ctx.store.resolvePath(["knowledge", "java", "余票展示-改名"])).nodeId, unitId);
    assert.equal(await rejectedCode(ctx.store.resolvePath(["project", "12306", "余票展示-改名"])), "target_not_found");
    assert.equal((await ctx.store.readSnapshot({ nodeId: snapshotId })).content.title, "12306 学习快照");

    // Same-level name collisions are refused for both rename and move.
    assert.equal(
      await rejectedCode(ctx.store.accept(request({
        operation: "directory.move",
        target: { nodeId: alpha.accepted.targetNodeId, parentId: project12306Id }
      }))),
      "name_conflict"
    );
  });
});

test("a frozen create parentId cannot be redirected by a stale display path", async () => {
  await withStore(async (ctx) => {
    const domain = await acceptProjected(ctx, {
      operation: "directory.create",
      target: { path: ["project"], kind: "domain" }
    });
    const oldParent = await acceptProjected(ctx, {
      operation: "directory.create",
      target: { parentId: domain.accepted.targetNodeId, name: "12306", kind: "directory" }
    });
    const oldParentId = oldParent.accepted.targetNodeId;

    const deletion = await ctx.store.accept(request({
      operation: "directory.delete",
      target: { nodeId: oldParentId }
    }));
    await ctx.store.projectAll({ owner: "worker-delete-old-parent" });
    assert.equal(await effectOf(ctx, deletion.requestId), "applied");

    const replacement = await acceptProjected(ctx, {
      operation: "directory.create",
      target: { parentId: domain.accepted.targetNodeId, name: "12306", kind: "directory" }
    });
    assert.notEqual(replacement.accepted.targetNodeId, oldParentId);

    const lateCreate = request({
      operation: "snapshot.create",
      target: {
        path: ["project", "12306", "late.json"],
        parentId: oldParentId
      }
    });
    assert.equal(await rejectedCode(ctx.store.accept(lateCreate)), "target_deleted");
    assert.equal(await countRows(ctx.db, "requests", "WHERE request_id = ?", lateCreate.requestId), 0);
    assert.deepEqual((await ctx.store.listDirectory({ parentId: replacement.accepted.targetNodeId })).nodes, []);
  });
});

test("a frozen create follows a renamed parent by ID even when its path is stale", async () => {
  await withStore(async (ctx) => {
    const domain = await acceptProjected(ctx, {
      operation: "directory.create",
      target: { path: ["project"], kind: "domain" }
    });
    const parent = await acceptProjected(ctx, {
      operation: "directory.create",
      target: { parentId: domain.accepted.targetNodeId, name: "old-name", kind: "directory" }
    });
    const renamed = await acceptProjected(ctx, {
      operation: "directory.rename",
      target: { nodeId: parent.accepted.targetNodeId, name: "new-name" }
    });
    assert.equal(renamed.effect, "applied");

    const lateCreate = await acceptProjected(ctx, {
      operation: "snapshot.create",
      target: { path: ["project", "old-name", "late.json"], parentId: parent.accepted.targetNodeId }
    });
    assert.equal(lateCreate.effect, "applied");
    assert.equal(lateCreate.accepted.targetParentId, parent.accepted.targetNodeId);
    assert.equal((await ctx.store.resolvePath(["project", "new-name", "late.json"])).nodeId,
      lateCreate.accepted.targetNodeId);
  });
});

// ---------------------------------------------------------------------------
test("J20 deletion gate rejects descendant writes and late creates, then clears bodies", async () => {
  await withStore(async (ctx) => {
    const tree = await seedProjectTree(ctx);
    const unitId = tree.unit.accepted.targetNodeId;
    const snapshotId = tree.snapshot.accepted.targetNodeId;
    const rpc = await acceptProjected(ctx, {
      operation: "snapshot.create",
      target: { parentId: tree.project12306.accepted.targetNodeId, name: "学习快照.json", nodeId: "node_rpc_snapshot_0001" },
      changes: [{ op: "set", path: ["title"], value: "RPC 快照" }]
    });

    // Accepted-but-unprojected descendant write, parked like a queued task so
    // the deletion finalisation has to cancel it.
    const pendingEnvelope = request({
      operation: "snapshot.patch",
      target: { nodeId: snapshotId },
      baseRevision: 1,
      changes: [{ op: "set", path: ["nextUnit"], value: "迟到写入" }]
    });
    const pendingWrite = await ctx.store.accept(pendingEnvelope);
    const pendingTask = await oneRow(ctx.db, "SELECT task_id FROM tasks WHERE event_seq = (SELECT event_seq FROM events WHERE request_id = ?)", pendingWrite.requestId);
    await ctx.db.prepare(
      "UPDATE tasks SET state = 'queued', available_at = '2099-01-01T00:00:00.000Z' WHERE task_id = ?"
    ).bind(pendingTask.task_id).run();

    // A conflict body inside the subtree must be cleared by the delete.
    await ctx.db.prepare(
      `INSERT INTO conflicts (conflict_id, node_id, request_id, base_revision, current_revision, details_json, status, resolved_by, created_at)
       VALUES ('cfl_probe', ?, ?, 1, 2, '{"secret":"conflict-body"}', 'open', NULL, ?)`
    ).bind(snapshotId, pendingWrite.requestId, T0).run();

    const deletion = await ctx.store.accept(request({
      operation: "directory.delete",
      target: { nodeId: unitId }
    }));
    assert.equal(deletion.status, "d1_committed");

    // Gate established at accept: the subtree is frozen immediately.
    assert.equal(
      await rejectedCode(ctx.store.accept(request({
        operation: "snapshot.patch",
        target: { nodeId: snapshotId },
        baseRevision: 1,
        changes: [{ op: "set", path: ["nextUnit"], value: "门禁后写入" }]
      }))),
      "target_deleted"
    );
    assert.equal(
      await rejectedCode(ctx.store.accept(request({
        operation: "directory.create",
        target: { parentId: unitId, name: "新目录", kind: "directory" }
      }))),
      "target_deleted"
    );
    assert.equal(
      await rejectedCode(ctx.store.accept(request({
        operation: "snapshot.create",
        target: { parentId: unitId, name: "迟到.json" }
      }))),
      "target_deleted"
    );
    assert.equal(await rejectedCode(ctx.store.listDirectory({ parentId: unitId })), "target_deleted");

    const run = await ctx.store.projectAll({ owner: "worker-1" });
    const deletionResult = run.results.find((result) => result.requestId === deletion.requestId);
    assert.ok(deletionResult, "deletion task should be projected");
    assert.equal(deletionResult.effect, "applied");

    assert.equal((await oneRow(ctx.db, "SELECT lifecycle FROM nodes WHERE node_id = ?", unitId)).lifecycle, "deleted");
    assert.equal(await rejectedCode(ctx.store.readSnapshot({ nodeId: snapshotId })), "target_deleted");
    assert.equal(await rejectedCode(ctx.store.resolvePath(["project", "12306", "余票展示"])), "target_not_found");

    assert.equal(await countRows(ctx.db, "snapshots", "WHERE node_id = ?", snapshotId), 0);
    assert.equal(await countRows(ctx.db, "snapshot_versions", "WHERE node_id = ?", snapshotId), 0);
    assert.equal((await oneRow(ctx.db, "SELECT details_json FROM conflicts WHERE conflict_id = 'cfl_probe'")).details_json, null);

    const redactedEvents = await ctx.db.prepare(
      "SELECT request_id, request_json, redacted FROM events WHERE node_id = ?"
    ).bind(snapshotId).all();
    assert.ok(redactedEvents.results.length >= 1);
    assert.ok(redactedEvents.results.every((row) => Number(row.redacted) === 1 && row.request_json === null));
    const deletionEvent = await oneRow(ctx.db, "SELECT redacted, request_json FROM events WHERE request_id = ?", deletion.requestId);
    assert.equal(Number(deletionEvent.redacted), 0);
    assert.ok(deletionEvent.request_json);

    assert.equal((await oneRow(ctx.db, "SELECT state FROM tasks WHERE task_id = ?", pendingTask.task_id)).state, "cancelled");
    const cancelledRequest = await ctx.store.requestStatus({ requestId: pendingWrite.requestId });
    assert.equal(cancelledRequest.effect, "cancelled");
    assert.equal(cancelledRequest.targetDeleted, true);

    // Unrelated subtree keeps its body.
    assert.equal((await ctx.store.readSnapshot({ nodeId: rpc.accepted.targetNodeId })).content.title, "RPC 快照");
    assert.equal(await effectOf(ctx, deletion.requestId), "applied");
    assert.equal(await countRows(ctx.db, "deletion_gates", "WHERE node_id = ? AND complete = 1", unitId), 1);

    const manifest = await ctx.store.deletionManifest({ requestId: deletion.requestId });
    assert.equal(manifest.complete, true);
    assert.ok(manifest.nodes.includes(unitId));
    assert.ok(manifest.nodes.includes(snapshotId));

    // Same-name rebuild yields a fresh node id; the old request never lands on it.
    const rebuilt = await acceptProjected(ctx, {
      operation: "directory.create",
      target: { path: ["project", "12306", "余票展示"], kind: "directory" }
    });
    assert.notEqual(rebuilt.accepted.targetNodeId, unitId);
    const replayOld = await ctx.store.accept(pendingEnvelope);
    assert.equal(replayOld.duplicate, true);
    assert.equal(replayOld.effect, "cancelled");
    assert.equal(await countRows(ctx.db, "snapshots", "WHERE node_id = ?", rebuilt.accepted.targetNodeId), 0);
  });
});

// ---------------------------------------------------------------------------
test("J21 a deletion gate invalidates an in-flight projection commit", async () => {
  await withStore(async (ctx) => {
    const tree = await seedProjectTree(ctx);
    const unitId = tree.unit.accepted.targetNodeId;
    const snapshotId = tree.snapshot.accepted.targetNodeId;
    const siblingSnapshot = await acceptProjected(ctx, {
      operation: "snapshot.create",
      target: { parentId: unitId, name: "副本.json" },
      changes: [{ op: "set", path: ["title"], value: "副本" }]
    });
    const siblingNodeId = siblingSnapshot.accepted.targetNodeId;
    const catalogBefore = Number((await oneRow(ctx.db, "SELECT catalog_revision FROM workspace_meta WHERE id = 1")).catalog_revision);

    // Two handlers on two different files read the pre-gate tree and are still
    // processing when the deletion gate commits.
    const first = await ctx.store.accept(request({
      operation: "snapshot.patch",
      target: { nodeId: snapshotId },
      baseRevision: 1,
      changes: [{ op: "set", path: ["a"], value: 1 }]
    }));
    const second = await ctx.store.accept(request({
      operation: "snapshot.patch",
      target: { nodeId: siblingNodeId },
      baseRevision: 1,
      changes: [{ op: "set", path: ["b"], value: 2 }]
    }));
    const leaseFirst = await ctx.store.claimTask({ owner: "slow-a" });
    const leaseSecond = await ctx.store.claimTask({ owner: "slow-b" });
    assert.ok(leaseFirst.taskId);
    assert.ok(leaseSecond.taskId);
    assert.notEqual(leaseFirst.taskId, leaseSecond.taskId);

    const deletion = await ctx.store.accept(request({
      operation: "directory.delete",
      target: { nodeId: unitId }
    }));
    const catalogAfter = Number((await oneRow(ctx.db, "SELECT catalog_revision FROM workspace_meta WHERE id = 1")).catalog_revision);
    assert.equal(catalogAfter, catalogBefore + 1);

    // The first late handler's plan sees the frozen subtree and writes nothing;
    // the task closes as cancelled rather than as a completed content change.
    const late = await ctx.store.applyOne({
      taskId: leaseFirst.taskId, owner: "slow-a", epoch: leaseFirst.epoch
    });
    assert.equal(late.effect, "cancelled");
    const snapshotAfterLate = await oneRow(
      ctx.db, "SELECT revision, content_json FROM snapshots WHERE node_id = ?", snapshotId
    );
    assert.equal(Number(snapshotAfterLate.revision), 1);
    assert.ok(!snapshotAfterLate.content_json.includes('"a"'));
    assert.equal(await countRows(ctx.db, "snapshot_versions", "WHERE node_id = ?", snapshotId), 1);
    assert.equal(await effectOf(ctx, first.requestId), "cancelled");

    // Even a batch built from a stale JavaScript read is refused by the
    // database: the commit_guards triggers check the catalog revision and the
    // node lifecycle, not only what the caller believes it read.
    const stamp = ctx.now();
    const guardSql = `INSERT INTO commit_guards
      (guard_id, task_id, owner, expected_epoch, expected_node_id, expected_catalog_revision,
       expected_snapshot_revision, now_utc, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`;
    const staleCatalog = await failureMessage(ctx.db.batch([
      ctx.db.prepare(guardSql).bind(
        "grd_probe_catalog", leaseSecond.taskId, "slow-b", leaseSecond.epoch, siblingNodeId, catalogBefore, stamp, stamp
      )
    ]));
    assert.match(staleCatalog, /stale_catalog_revision/);
    const staleLifecycle = await failureMessage(ctx.db.batch([
      ctx.db.prepare(guardSql).bind(
        "grd_probe_lifecycle", leaseSecond.taskId, "slow-b", leaseSecond.epoch, unitId, catalogAfter, stamp, stamp
      )
    ]));
    // Reaching the gate root directly is refused by the gate or the lifecycle
    // trigger (SQLite trigger order is unspecified, both are database-level).
    assert.match(staleLifecycle, /deletion_gate_blocks_write|stale_node_state/);

    // The deletion completes and cancels the remaining in-flight work.
    const deletionRun = await ctx.store.projectAll({ owner: "worker-1" });
    const outcome = deletionRun.results.find((result) => result.requestId === deletion.requestId);
    assert.ok(outcome);
    assert.equal(outcome.effect, "applied");
    assert.equal(await effectOf(ctx, second.requestId), "cancelled");
    assert.equal(await countRows(ctx.db, "snapshots", "WHERE node_id IN (?, ?)", snapshotId, siblingNodeId), 0);
    assert.equal((await oneRow(ctx.db, "SELECT state FROM tasks WHERE task_id = ?", leaseSecond.taskId)).state, "cancelled");
  });
});

// ---------------------------------------------------------------------------
test("J24 pagination cursors are bound to catalogRevision", async () => {
  await withStore(async (ctx) => {
    for (const name of ["alpha", "beta", "gamma"]) {
      await acceptProjected(ctx, {
        operation: "directory.create",
        target: { path: [name], kind: "domain" }
      });
    }
    const page0 = await ctx.store.listDirectory({ limit: 2 });
    assert.deepEqual(page0.nodes.map((node) => node.name), ["alpha", "beta"]);
    assert.ok(page0.cursor);

    // A structure change moves catalogRevision; the old cursor is refused
    // instead of being stitched across two different catalogs.
    await acceptProjected(ctx, {
      operation: "directory.create",
      target: { path: ["delta"], kind: "domain" }
    });
    assert.equal(
      await rejectedCode(ctx.store.listDirectory({ limit: 2, cursor: page0.cursor })),
      "cursor_stale"
    );

    // A fresh cursor on the current revision walks exactly one catalog.
    const fresh0 = await ctx.store.listDirectory({ limit: 2 });
    const fresh1 = await ctx.store.listDirectory({ limit: 2, cursor: fresh0.cursor });
    assert.deepEqual(
      [...fresh0.nodes, ...fresh1.nodes].map((node) => node.name),
      ["alpha", "beta", "delta", "gamma"]
    );
    const fresh2 = await ctx.store.listDirectory({ limit: 2, cursor: fresh1.cursor });
    assert.deepEqual(fresh2.nodes, []);
    assert.equal(fresh2.complete, true);
  });
});

// ---------------------------------------------------------------------------
test("J23 (partial) deletion body cleanup is paged and resumes from its cursor", async () => {
  await withStore(async (ctx) => {
    const domain = await acceptProjected(ctx, {
      operation: "directory.create",
      target: { path: ["project"], kind: "domain" }
    });
    const children = DELETE_PAGE_SIZE + 2;
    for (let index = 0; index < children; index += 1) {
      await ctx.store.accept(request({
        operation: "snapshot.create",
        target: { parentId: domain.accepted.targetNodeId, name: `快照-${index}.json` },
        changes: [{ op: "set", path: ["index"], value: index }]
      }));
    }
    await ctx.store.projectAll({ owner: "worker-1", maxTasks: 100 });
    assert.equal(await countRows(ctx.db, "snapshots"), children);

    const deletion = await ctx.store.accept(request({
      operation: "directory.delete",
      target: { nodeId: domain.accepted.targetNodeId }
    }));
    const run = await ctx.store.projectAll({ owner: "worker-1", maxTasks: 10 });
    const attempts = run.results.filter((result) => result.requestId === deletion.requestId);
    assert.ok(attempts.length >= 2, `expected paged deletion, got ${attempts.length} attempt(s)`);
    assert.equal(attempts[0].effect, "pending");
    assert.equal(attempts.at(-1).effect, "applied");
    assert.equal(await countRows(ctx.db, "snapshots"), 0);
    assert.equal(await countRows(ctx.db, "snapshot_versions"), 0);
    const gate = await oneRow(ctx.db, "SELECT complete, manifest_cursor FROM deletion_gates WHERE node_id = ?", domain.accepted.targetNodeId);
    assert.equal(Number(gate.complete), 1);
    assert.equal(JSON.parse(gate.manifest_cursor).offset, children + 1);
  });
});

test("J23 large deletion manifests are discovered and read in bounded pages", async () => {
  await withStore(async (ctx) => {
    const domain = await acceptProjected(ctx, {
      operation: "directory.create",
      target: { path: ["project"], kind: "domain" }
    });
    const rootId = domain.accepted.targetNodeId;
    const stamp = T0;
    const totalChildren = 1_000;
    for (let start = 0; start < totalChildren; start += 100) {
      const statements = Array.from({ length: Math.min(100, totalChildren - start) }, (_, offset) => {
        const index = start + offset;
        return ctx.db.prepare(
          `INSERT INTO nodes (node_id, parent_id, name, kind, lifecycle, revision, created_at, updated_at)
           VALUES (?, ?, ?, 'directory', 'active', 0, ?, ?)`
        ).bind(`node_manifest_${String(index).padStart(6, "0")}`, rootId,
          `child-${String(index).padStart(6, "0")}`, stamp, stamp);
      });
      await ctx.db.batch(statements);
    }

    const deletion = await ctx.store.accept(request({
      operation: "directory.delete",
      target: { nodeId: rootId }
    }));
    const firstRun = await ctx.store.projectAll({ owner: "worker-1", maxTasks: 1 });
    const first = firstRun.results.find((entry) => entry.requestId === deletion.requestId);
    assert.ok(first);
    assert.equal(first.ok, true);
    assert.equal(first.effect, "pending");
    assert.equal(await effectOf(ctx, deletion.requestId), "pending");

    const found = [];
    let cursor = null;
    let enumerationComplete = false;
    const firstPage = await ctx.store.deletionManifest({ requestId: deletion.requestId, limit: 50 });
    assert.equal(firstPage.complete, false, "body cleanup is still in progress");
    assert.equal(firstPage.nodes.length, 50);
    assert.match(firstPage.nextCursor, /^rds1:/);
    assert.equal(
      await rejectedCode(ctx.store.deletionManifest({
        requestId: deletion.requestId,
        cursor: `rds1:${encodeURIComponent(JSON.stringify({
          op: "deletion.manifest", requestId: "another-delete", frozenCatalogRevision: firstPage.frozenCatalogRevision, offset: 50
        }))}`
      })),
      "cursor_stale"
    );
    do {
      const page = cursor === null
        ? firstPage
        : await ctx.store.deletionManifest({ requestId: deletion.requestId, cursor, limit: 50 });
      assert.equal(page.complete, false, "body cleanup is still in progress");
      assert.ok(page.nodes.length <= 50);
      found.push(...page.nodes);
      cursor = page.nextCursor;
      enumerationComplete = page.enumerationComplete;
    } while (cursor !== null);

    assert.equal(enumerationComplete, true);
    assert.equal(found.length, totalChildren + 1);
    assert.equal(new Set(found).size, totalChildren + 1);
    assert.ok(found.includes(rootId));
    assert.ok(found.includes("node_manifest_000999"));
  });
});

// ---------------------------------------------------------------------------
test("J31 deleting a node id that never existed leaves a reserve tombstone", async () => {
  await withStore(async (ctx) => {
    const ghostId = "node_ghost_never_existed_0001";
    const deletion = await ctx.store.accept(request({
      operation: "directory.delete",
      target: { nodeId: ghostId }
    }));
    const run = await ctx.store.projectAll({ owner: "worker-1" });
    const outcome = run.results.find((result) => result.requestId === deletion.requestId);
    assert.ok(outcome);
    assert.equal(outcome.effect, "applied");
    assert.equal((await oneRow(ctx.db, "SELECT lifecycle FROM nodes WHERE node_id = ?", ghostId)).lifecycle, "deleted");

    // A late create for the reserved node id is refused, as is a child create
    // or snapshot under the tombstone.
    assert.equal(
      await rejectedCode(ctx.store.accept(request({
        operation: "directory.create",
        target: { nodeId: ghostId, parentId: null, name: "复活", kind: "domain" }
      }))),
      "target_deleted"
    );
    assert.equal(
      await rejectedCode(ctx.store.accept(request({
        operation: "directory.create",
        target: { parentId: ghostId, name: "孩子", kind: "directory" }
      }))),
      "target_deleted"
    );
    assert.equal(
      await rejectedCode(ctx.store.accept(request({
        operation: "snapshot.create",
        target: { parentId: ghostId, name: "迟到.json" }
      }))),
      "target_deleted"
    );
    assert.equal(await countRows(ctx.db, "nodes", "WHERE node_id = ?", ghostId), 1);
    const manifest = await ctx.store.deletionManifest({ requestId: deletion.requestId });
    assert.deepEqual(manifest.nodes, [ghostId]);
  });
});

// ---------------------------------------------------------------------------
test("J34 redacted events are not rebuilt and old requests never revive content", async () => {
  await withStore(async (ctx) => {
    const tree = await seedProjectTree(ctx);
    const unitId = tree.unit.accepted.targetNodeId;
    const snapshotId = tree.snapshot.accepted.targetNodeId;
    const pendingEnvelope = request({
      operation: "snapshot.patch",
      target: { nodeId: snapshotId },
      baseRevision: 1,
      changes: [{ op: "set", path: ["nextUnit"], value: "删除前写入" }]
    });
    const pendingWrite = await ctx.store.accept(pendingEnvelope);
    const pendingTask = await oneRow(ctx.db, "SELECT task_id FROM tasks WHERE event_seq = (SELECT event_seq FROM events WHERE request_id = ?)", pendingWrite.requestId);
    await ctx.db.prepare(
      "UPDATE tasks SET state = 'queued', available_at = '2099-01-01T00:00:00.000Z' WHERE task_id = ?"
    ).bind(pendingTask.task_id).run();

    const deletion = await ctx.store.accept(request({
      operation: "directory.delete",
      target: { nodeId: unitId }
    }));
    await ctx.store.projectAll({ owner: "worker-1" });
    assert.equal(await effectOf(ctx, deletion.requestId), "applied");

    const redacted = await oneRow(ctx.db, "SELECT event_seq, redacted, request_json FROM events WHERE request_id = ?", pendingWrite.requestId);
    assert.equal(Number(redacted.redacted), 1);
    assert.equal(redacted.request_json, null);

    // Re-delivery of a redacted event (a fresh task row) closes as cancelled
    // instead of rebuilding the body or generating a hash retry loop.
    await ctx.db.prepare(
      `INSERT INTO tasks (task_id, event_seq, state, lease_owner, lease_epoch, lease_until, failure_count, available_at, last_error, created_at, updated_at)
       VALUES ('tsk_replay_probe', ?, 'pending', NULL, 0, NULL, 0, ?, NULL, ?, ?)`
    ).bind(redacted.event_seq, T0, T0, T0).run();
    const replayRun = await ctx.store.projectAll({ owner: "worker-1" });
    const replayOutcome = replayRun.results.find((result) => result.taskId === "tsk_replay_probe");
    assert.ok(replayOutcome);
    assert.equal(replayOutcome.code, "redacted_event");
    assert.equal((await oneRow(ctx.db, "SELECT state FROM tasks WHERE task_id = 'tsk_replay_probe'")).state, "cancelled");
    assert.equal(await countRows(ctx.db, "snapshots", "WHERE node_id = ?", snapshotId), 0);
    assert.equal(await countRows(ctx.db, "snapshot_versions", "WHERE node_id = ?", snapshotId), 0);

    // Replaying the old request only returns the stored cancelled receipt.
    const replay = await ctx.store.accept(pendingEnvelope);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.effect, "cancelled");
    assert.equal(await countRows(ctx.db, "snapshots", "WHERE node_id = ?", snapshotId), 0);
    assert.equal(await countRows(ctx.db, "events", "WHERE request_id = ?", pendingWrite.requestId), 1);

    // A same-named rebuild is a new node; the old request cannot address it.
    await acceptProjected(ctx, {
      operation: "directory.create",
      target: { path: ["project", "12306", "重建"], kind: "directory" }
    });
    const rebuilt = await acceptProjected(ctx, {
      operation: "snapshot.create",
      target: { path: ["project", "12306", "重建", "学习快照.json"] },
      changes: [{ op: "set", path: ["title"], value: "重建后的快照" }]
    });
    assert.notEqual(rebuilt.accepted.targetNodeId, snapshotId);
    assert.equal(await countRows(ctx.db, "snapshots", "WHERE node_id = ?", snapshotId), 0);
    assert.equal(
      (await ctx.store.readSnapshot({ nodeId: rebuilt.accepted.targetNodeId })).content.title,
      "重建后的快照"
    );
  });
});

test("queue dispatch hands a live lease to an immediate consumer", async () => {
  await withStore(async (ctx) => {
    const { createProjectionQueue } = await import("../src/queue.js");
    const envelope = {
      protocol: "rds-jbryon",
      apiVersion: 1,
      workspaceEpoch: EPOCH,
      requestId: "queue-handoff-00000001",
      operation: "directory.create",
      target: { path: ["project"], kind: "domain" }
    };
    await ctx.store.accept(envelope);
    const queue = createProjectionQueue({ store: ctx.store, owner: "review-queue" });
    const messages = await queue.dispatchDue({ limit: 1 });
    assert.equal(messages.length, 1);
    const consumed = await queue.consume(messages[0]);
    assert.equal(consumed.ok, true);
    assert.equal((await ctx.store.requestStatus(envelope.requestId)).effect, "applied");
  });
});

test("a replacement supersedes a replan-blocked request and proceeds", async () => {
  await withStore(async (ctx) => {
    const tree = await seedProjectTree(ctx);
    const nodeId = tree.snapshot.accepted.targetNodeId;
    const first = await acceptProjected(ctx, {
      operation: "snapshot.patch", target: { nodeId }, baseRevision: 1,
      changes: [{ op: "set", path: ["x"], value: 1 }]
    });
    assert.equal(first.effect, "applied");
    const conflicted = await acceptProjected(ctx, {
      operation: "snapshot.patch", target: { nodeId }, baseRevision: 1,
      changes: [{ op: "set", path: ["x"], value: 2 }]
    });
    assert.equal(conflicted.effect, "conflict");

    const dependentEnvelope = request({
      operation: "snapshot.patch", target: { nodeId }, baseRevision: 2,
      dependsOn: [conflicted.accepted.requestId],
      changes: [{ op: "set", path: ["otherField"], value: "after-conflict" }]
    });
    await ctx.store.accept(dependentEnvelope);
    await ctx.store.projectAll({ owner: "worker-1" });
    const blocked = await ctx.store.requestStatus(dependentEnvelope.requestId);
    assert.equal(blocked.effect, "pending");
    assert.equal(blocked.dependency.code, "dependency_replan_required");

    const current = await ctx.store.readSnapshot({ nodeId });
    const replacement = await acceptProjected(ctx, {
      operation: "snapshot.patch", target: { nodeId }, baseRevision: current.revision,
      replaces: [dependentEnvelope.requestId],
      changes: [{ op: "set", path: ["x"], value: 3 }]
    });
    assert.equal(replacement.effect, "applied");
    const old = await ctx.store.requestStatus(dependentEnvelope.requestId);
    assert.equal(old.effect, "cancelled");
    assert.equal(old.supersededBy, replacement.accepted.requestId);
  });
});

test("a conflict original and a deletion control cannot be replaced", async () => {
  await withStore(async (ctx) => {
    const tree = await seedProjectTree(ctx);
    const nodeId = tree.snapshot.accepted.targetNodeId;
    const first = await acceptProjected(ctx, {
      operation: "snapshot.patch", target: { nodeId }, baseRevision: 1,
      changes: [{ op: "set", path: ["x"], value: 1 }]
    });
    assert.equal(first.effect, "applied");
    const conflicted = await acceptProjected(ctx, {
      operation: "snapshot.patch", target: { nodeId }, baseRevision: 1,
      changes: [{ op: "set", path: ["x"], value: 2 }]
    });
    assert.equal(conflicted.effect, "conflict");
    const current = await ctx.store.readSnapshot({ nodeId });
    const conflictReplace = await rejectedCode(ctx.store.accept({
      ...request({}),
      operation: "snapshot.patch", target: { nodeId }, baseRevision: current.revision,
      replaces: [conflicted.accepted.requestId],
      changes: [{ op: "set", path: ["x"], value: 3 }]
    }));
    assert.equal(conflictReplace, "replace_target_not_allowed");
    assert.equal((await ctx.store.requestStatus(conflicted.accepted.requestId)).effect, "conflict");

    const deletion = await ctx.store.accept({
      ...request({}), operation: "directory.delete", target: { nodeId: tree.project.accepted.targetNodeId }
    });
    const deleteReplace = await rejectedCode(ctx.store.accept({
      ...request({}), operation: "directory.create", target: { path: ["knowledge"], kind: "domain" },
      replaces: [deletion.requestId]
    }));
    assert.equal(deleteReplace, "replace_target_not_allowed");
    await ctx.store.projectAll({ owner: "worker-1" });
    assert.equal((await ctx.store.requestStatus(deletion.requestId)).effect, "applied");
  });
});
