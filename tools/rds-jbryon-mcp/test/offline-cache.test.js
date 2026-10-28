// J32: offline cache reconciliation against an authoritative deletion manifest.
// The cloud gate freezes membership; a local move in or out while offline must
// never be resolved silently. These tests use the real SQLite Outbox plus the
// local cache schema (no network, no cloud).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalOutbox } from "../outbox.mjs";
import { createRdsService } from "../service.mjs";
import {
  applyOfflineReconciliation,
  openOfflineCache,
  planOfflineReconciliation,
  readOfflineNodes,
  readPendingRequests,
  upsertOfflineNodes
} from "../offline-cache.mjs";

const EPOCH = "0123456789abcdef0123456789abcdef";
const CLEANUP = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 };

function request(requestId, overrides = {}) {
  return {
    protocol: "rds-jbryon",
    apiVersion: 1,
    workspaceEpoch: EPOCH,
    requestId,
    operation: "snapshot.patch",
    target: { nodeId: "node-0001" },
    changes: [{ op: "set", path: ["title"], value: "x" }],
    ...overrides
  };
}

const node = (nodeId, parentId = null, extra = {}) => ({
  nodeId,
  parentId,
  name: extra.name ?? nodeId,
  kind: extra.kind ?? "directory",
  ...extra
});

async function withCache(callback) {
  const directory = await mkdtemp(join(tmpdir(), "rds-jbryon-offline-"));
  const path = join(directory, "local.sqlite");
  let now = "2026-10-26T10:00:00.000Z";
  const outbox = new LocalOutbox({ path, clock: () => now, owner: "offline-test" });
  const db = openOfflineCache({ path });
  try {
    await callback({
      outbox,
      db,
      path,
      advance: (ms) => { now = new Date(Date.parse(now) + ms).toISOString(); }
    });
  } finally {
    db.close();
    outbox.close();
    await rm(directory, CLEANUP);
  }
}

const pendingInput = (outbox) => outbox.list({ limit: 200 }).map((row) => ({
  requestId: row.requestId,
  state: row.state,
  operation: row.operation,
  request: row.request
}));

function auditRows(db) {
  return db.prepare(
    "SELECT audit_id, kind, node_id, request_id FROM offline_audit ORDER BY audit_id"
  ).all();
}

function rawRequests(db) {
  return db.prepare(
    `SELECT request_id, state, envelope_json, body_redacted, content_hash, updated_at
     FROM local_requests ORDER BY request_id`
  ).all();
}

test("a node moved out before the gate is kept, not erased", async () => {
  await withCache(async ({ outbox, db }) => {
    upsertOfflineNodes(db, [
      node("node-deleted-dir", null, { kind: "domain", contentJson: "{\"title\":\"deleted\"}" }),
      node("node-child", "node-deleted-dir", {
        kind: "snapshot", contentJson: "{\"body\":\"not-synced\"}"
      }),
      node("node-moved-out", "node-deleted-dir", {
        kind: "snapshot",
        movedOutBeforeGate: true,
        movedOutOf: "node-deleted-dir",
        contentJson: "{\"body\":\"local-unsent-edit\"}"
      })
    ]);
    outbox.enqueue(request("req-child-01", { target: { nodeId: "node-child" } }));
    outbox.enqueue(request("req-moved-01", { target: { nodeId: "node-moved-out" } }));

    const plan = planOfflineReconciliation({
      manifestNodeIds: ["node-deleted-dir"],
      localNodes: readOfflineNodes(db),
      pendingRequests: readPendingRequests(db)
    });

    assert.deepEqual(plan.erase, ["node-child", "node-deleted-dir"]);
    assert.ok(plan.keep.includes("node-moved-out"));
    assert.deepEqual(plan.movedOut.map((entry) => entry.nodeId), ["node-moved-out"]);
    assert.deepEqual(plan.cancelRequests.map((entry) => entry.requestId), ["req-child-01"]);
    assert.deepEqual(plan.conflicts, []);

    const summary = applyOfflineReconciliation({ db, plan });
    assert.equal(summary.erased, 2);
    assert.equal(summary.erasedBodies, 2);

    const rows = new Map(readOfflineNodes(db).map((row) => [row.nodeId, row]));
    assert.equal(rows.get("node-child").contentJson, null);
    assert.equal(rows.get("node-child").lifecycle, "deleted");
    assert.equal(rows.get("node-moved-out").contentJson, "{\"body\":\"local-unsent-edit\"}");
    assert.equal(rows.get("node-moved-out").lifecycle, "active");

    assert.equal(outbox.get("req-child-01").state, "cancelled");
    assert.equal(outbox.get("req-child-01").bodyRedacted, true);
    assert.equal(outbox.get("req-child-01").request.redacted, true);
    assert.equal(outbox.get("req-moved-01").state, "local_pending");
    assert.ok(auditRows(db).some((row) => row.kind === "erase" && row.node_id === "node-child"));
    assert.ok(auditRows(db).some(
      (row) => row.kind === "cancel_request" && row.request_id === "req-child-01"
    ));
  });
});

test("a node moved into the frozen subtree after the gate is an explicit conflict", async () => {
  await withCache(async ({ outbox, db }) => {
    upsertOfflineNodes(db, [
      node("node-deleted-dir", null, { kind: "domain" }),
      node("node-moved-in", "node-deleted-dir", {
        kind: "snapshot",
        movedInAfterGate: true,
        movedInTo: "node-deleted-dir",
        contentJson: "{\"body\":\"still-outside-cloud\"}"
      }),
      node("node-moved-in-child", "node-moved-in", { kind: "directory" })
    ]);
    outbox.enqueue(request("req-moved-in-01", { target: { nodeId: "node-moved-in" } }));

    const plan = planOfflineReconciliation({
      manifestNodeIds: ["node-deleted-dir"],
      localNodes: readOfflineNodes(db),
      pendingRequests: readPendingRequests(db)
    });

    assert.deepEqual(plan.erase, ["node-deleted-dir"]);
    assert.equal(plan.keep.includes("node-moved-in"), false);
    assert.deepEqual(
      plan.conflicts.map((entry) => entry.nodeId),
      ["node-moved-in", "node-moved-in-child"]
    );
    assert.equal(plan.conflicts[0].code, "moved_in_after_gate");
    assert.deepEqual(plan.cancelRequests, []);

    applyOfflineReconciliation({ db, plan });

    const rows = new Map(readOfflineNodes(db).map((row) => [row.nodeId, row]));
    assert.equal(rows.get("node-moved-in").contentJson, "{\"body\":\"still-outside-cloud\"}");
    assert.equal(rows.get("node-moved-in").conflictCode, "moved_in_after_gate");
    assert.equal(rows.get("node-moved-in").lifecycle, "active");
    // The request is not erased because the cloud manifest does not cover the
    // node; the conflict is the user-visible signal instead.
    assert.equal(outbox.get("req-moved-in-01").state, "local_pending");
    assert.ok(auditRows(db).some(
      (row) => row.kind === "conflict" && row.node_id === "node-moved-in"
    ));
  });
});

test("an unsynced body and a create under the deleted directory are cleansed", async () => {
  await withCache(async ({ outbox, db }) => {
    upsertOfflineNodes(db, [
      node("node-deleted-dir", null, { kind: "domain" }),
      node("node-local-only", "node-deleted-dir", {
        kind: "snapshot", contentJson: "{\"body\":\"never-sent\"}"
      })
    ]);
    outbox.enqueue(request("req-local-only-01", { target: { nodeId: "node-local-only" } }));
    outbox.enqueue(request("req-create-under-01", {
      operation: "directory.create",
      target: { parentId: "node-deleted-dir", name: "later", kind: "directory" },
      changes: undefined
    }));

    const plan = planOfflineReconciliation({
      manifestNodeIds: ["node-deleted-dir"],
      localNodes: readOfflineNodes(db),
      pendingRequests: readPendingRequests(db)
    });
    assert.deepEqual(
      plan.cancelRequests.map((entry) => entry.requestId),
      ["req-create-under-01", "req-local-only-01"]
    );

    const summary = applyOfflineReconciliation({ db, plan });
    assert.equal(summary.erasedBodies, 1);
    assert.equal(summary.redactedRequests, 2);

    for (const requestId of ["req-create-under-01", "req-local-only-01"]) {
      const row = outbox.get(requestId);
      assert.equal(row.state, "cancelled");
      assert.equal(row.bodyRedacted, true);
      assert.equal(row.contentHash.length, 64);
      // The immutable request id and its dedupe hash survive body cleanup.
      assert.equal(row.request.requestId, requestId);
      assert.equal(row.request.changes, undefined);
    }
  });
});

test("applying the same plan twice is idempotent", async () => {
  await withCache(async ({ outbox, db }) => {
    upsertOfflineNodes(db, [
      node("node-deleted-dir", null, { kind: "domain" }),
      node("node-child", "node-deleted-dir", {
        kind: "snapshot", contentJson: "{\"body\":\"not-synced\"}"
      }),
      node("node-moved-out", "node-deleted-dir", {
        kind: "snapshot", movedOutBeforeGate: true, contentJson: "{\"body\":\"keep\"}"
      })
    ]);
    outbox.enqueue(request("req-child-01", { target: { nodeId: "node-child" } }));
    const plan = planOfflineReconciliation({
      manifestNodeIds: ["node-deleted-dir"],
      localNodes: readOfflineNodes(db),
      pendingRequests: readPendingRequests(db)
    });

    const first = applyOfflineReconciliation({ db, plan });
    const afterFirst = {
      nodes: readOfflineNodes(db),
      audit: auditRows(db),
      requests: rawRequests(db)
    };
    const second = applyOfflineReconciliation({ db, plan });

    assert.deepEqual(readOfflineNodes(db), afterFirst.nodes);
    assert.deepEqual(auditRows(db), afterFirst.audit);
    assert.deepEqual(rawRequests(db), afterFirst.requests);
    assert.equal(first.erasedBodies, 1);
    assert.equal(second.erasedBodies, 0);
    assert.equal(second.erasedRows, 0);
    assert.equal(second.cancelled, 0);
    assert.equal(second.redactedRequests, 0);
    assert.equal(second.auditsInserted, 0);
  });
});

test("nodes unrelated to the deletion are untouched", async () => {
  await withCache(async ({ outbox, db }) => {
    upsertOfflineNodes(db, [
      node("node-deleted-dir", null, { kind: "domain" }),
      node("node-unrelated", null, {
        kind: "domain", contentJson: "{\"body\":\"unrelated\"}"
      })
    ]);
    outbox.enqueue(request("req-unrelated-01", { target: { nodeId: "node-unrelated" } }));

    const before = readOfflineNodes(db).find((row) => row.nodeId === "node-unrelated");
    const plan = planOfflineReconciliation({
      manifestNodeIds: ["node-deleted-dir"],
      localNodes: readOfflineNodes(db),
      pendingRequests: readPendingRequests(db)
    });
    assert.ok(plan.keep.includes("node-unrelated"));
    assert.equal(plan.erase.includes("node-unrelated"), false);

    applyOfflineReconciliation({ db, plan });

    const after = readOfflineNodes(db).find((row) => row.nodeId === "node-unrelated");
    assert.deepEqual(after, before);
    assert.equal(outbox.get("req-unrelated-01").state, "local_pending");
  });
});

test("an acknowledged request loses its local body without a state rewrite", async () => {
  await withCache(async ({ outbox, db }) => {
    upsertOfflineNodes(db, [
      node("node-deleted-dir", null, { kind: "domain" }),
      node("node-child", "node-deleted-dir", {
        kind: "snapshot", contentJson: "{\"body\":\"cloud-has-this\"}"
      })
    ]);
    const service = createRdsService({
      outbox,
      client: {
        async submit(request) {
          return { requestId: request.requestId, status: "d1_committed", effect: "pending" };
        },
        async status() { return { effect: "pending" }; },
        async read() { return {}; }
      }
    });
    await service.submit(request("req-ack-01", { target: { nodeId: "node-child" } }));
    assert.equal(outbox.get("req-ack-01").state, "cloud_acknowledged");
    assert.deepEqual(readPendingRequests(db), []);

    const plan = planOfflineReconciliation({
      manifestNodeIds: ["node-deleted-dir"],
      localNodes: readOfflineNodes(db),
      pendingRequests: readPendingRequests(db)
    });
    assert.deepEqual(plan.cancelRequests, []);
    applyOfflineReconciliation({ db, plan });

    const row = outbox.get("req-ack-01");
    assert.equal(row.state, "cloud_acknowledged");
    assert.equal(row.bodyRedacted, true);
    assert.equal(row.request.changes, undefined);
  });
});

test("cancelForNodes cancels matching requests and keeps their rows", async () => {
  await withCache(async ({ outbox, db }) => {
    outbox.enqueue(request("req-node-one-01", { target: { nodeId: "node-one" } }));
    outbox.enqueue(request("req-node-two-01", { target: { nodeId: "node-two" } }));
    outbox.enqueue(request("req-child-create-01", {
      operation: "directory.create",
      target: { parentId: "node-one", name: "child", kind: "directory" },
      changes: undefined
    }));

    const first = outbox.cancelForNodes(["node-one"]);
    assert.deepEqual(first.requestIds.sort(), ["req-child-create-01", "req-node-one-01"]);
    assert.equal(first.cancelled, 2);
    assert.equal(outbox.get("req-node-two-01").state, "local_pending");
    for (const requestId of first.requestIds) {
      const row = outbox.get(requestId);
      assert.equal(row.state, "cancelled");
      assert.equal(row.lastError, "target_deleted");
      assert.equal(db.prepare(
        "SELECT COUNT(1) AS total FROM local_requests WHERE request_id = ?"
      ).get(requestId).total, 1);
    }

    const second = outbox.cancelForNodes(["node-one"]);
    assert.equal(second.cancelled, 0);
    assert.equal(second.alreadyCancelled, 2);
  });
});

test("a path-only offline request is frozen onto the cached node id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rds-jbryon-bind-"));
  const path = join(directory, "client.sqlite");
  const outbox = new LocalOutbox({ path, clock: () => "2026-10-27T04:00:00.000Z", owner: "bind-test" });
  const cache = openOfflineCache({ path });
  try {
    upsertOfflineNodes(cache, [
      { nodeId: "node-domain", kind: "domain", name: "project" },
      { nodeId: "node-dir", parentId: "node-domain", kind: "directory", name: "12306" },
      { nodeId: "node-snap", parentId: "node-dir", kind: "snapshot", name: "notes.json" }
    ], { now: "2026-10-27T04:00:00.000Z" });
    const request = {
      protocol: "rds-jbryon", apiVersion: 1, workspaceEpoch: EPOCH,
      requestId: "path-only-bind-00000001", operation: "snapshot.patch",
      target: { path: ["project", "12306", "notes.json"] },
      baseRevision: 1, changes: [{ op: "set", path: ["answer"], value: "A" }]
    };
    outbox.enqueue(request);
    const frozen = outbox.get(request.requestId);
    assert.equal(frozen.request.target.nodeId, "node-snap");
    assert.deepEqual(frozen.request.target.path, ["project", "12306", "notes.json"]);

    const plan = planOfflineReconciliation({
      manifestNodeIds: ["node-dir", "node-snap"],
      localNodes: readOfflineNodes(cache),
      pendingRequests: readPendingRequests(cache)
    });
    assert.ok(plan.cancelRequests.some((entry) => entry.requestId === request.requestId));
  } finally {
    cache.close();
    outbox.close();
    await rm(directory, CLEANUP);
  }
});

test("a fresh Outbox can enqueue a root domain without an offline route cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rds-jbryon-root-bootstrap-"));
  const path = join(directory, "client.sqlite");
  const outbox = new LocalOutbox({ path, clock: () => "2026-10-27T04:00:00.000Z", owner: "bootstrap-test" });
  try {
    const request = {
      protocol: "rds-jbryon", apiVersion: 1, workspaceEpoch: EPOCH,
      requestId: "root-domain-bootstrap-0001", operation: "directory.create",
      target: { path: ["project"], kind: "domain" }
    };
    outbox.enqueue(request);
    const stored = outbox.get(request.requestId);
    assert.equal(stored.state, "local_pending");
    assert.equal(stored.lastError, null);
    assert.equal(outbox.claimOne(request.requestId).request.requestId, request.requestId);
  } finally {
    outbox.close();
    await rm(directory, CLEANUP);
  }
});

test("a fresh Outbox still blocks a nested create without a proven parent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rds-jbryon-nested-bootstrap-"));
  const path = join(directory, "client.sqlite");
  const outbox = new LocalOutbox({ path, clock: () => "2026-10-27T04:00:00.000Z", owner: "bootstrap-test" });
  try {
    const request = {
      protocol: "rds-jbryon", apiVersion: 1, workspaceEpoch: EPOCH,
      requestId: "nested-domain-bootstrap-0001", operation: "directory.create",
      target: { path: ["project", "12306"], kind: "directory" }
    };
    outbox.enqueue(request);
    const stored = outbox.get(request.requestId);
    assert.equal(stored.state, "delivery_blocked");
    assert.equal(stored.lastError, "target_binding_unresolved");
    assert.equal(outbox.claimOne(request.requestId), null);
  } finally {
    outbox.close();
    await rm(directory, CLEANUP);
  }
});

test("J22/J32 the same authoritative manifest reconciles two independent offline caches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rds-jbryon-two-devices-"));
  const devices = ["device-a", "device-b"].map((name) => {
    const path = join(directory, `${name}.sqlite`);
    return {
      path,
      outbox: new LocalOutbox({ path, owner: name, clock: () => "2026-10-27T04:00:00.000Z" }),
      cache: openOfflineCache({ path })
    };
  });
  try {
    for (const [index, device] of devices.entries()) {
      upsertOfflineNodes(device.cache, [
        node("node-project", null, { kind: "domain", name: "project" }),
        node("node-12306", "node-project", { kind: "directory", name: "12306" }),
        node("node-notes", "node-12306", { kind: "snapshot", name: "学习快照.json" })
      ], { now: "2026-10-27T04:00:00.000Z" });
      const answer = request(`two-device-pending-${index + 1}`, {
        target: { nodeId: "node-notes" },
        changes: [{ op: "set", path: ["answer"], value: `旧设备答案-${index + 1}` }]
      });
      device.outbox.enqueue(answer);
    }

    for (const device of devices) {
      const plan = planOfflineReconciliation({
        manifestNodeIds: ["node-12306", "node-notes"],
        localNodes: readOfflineNodes(device.cache),
        pendingRequests: readPendingRequests(device.cache)
      });
      assert.equal(plan.cancelRequests.length, 1);
      const result = applyOfflineReconciliation({ db: device.cache, plan });
      assert.equal(result.cancelled, 1);
      const row = device.outbox.get(plan.cancelRequests[0].requestId);
      assert.equal(row.state, "cancelled");
      assert.equal(row.bodyRedacted, true);
      assert.match(row.lastError, /target_deleted/);
    }
  } finally {
    for (const device of devices) {
      device.cache.close();
      device.outbox.close();
    }
    await rm(directory, CLEANUP);
  }
});
