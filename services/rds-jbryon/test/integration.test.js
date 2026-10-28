// Layer integration: the HTTP surface drives the real D1 store, on both the
// node:sqlite simulator and Miniflare D1. This closes the gap between the route
// unit tests (fake store) and the store tests (no HTTP).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withD1, applySchema } from "./support/d1.js";
import { createRdsStore, initWorkspace } from "../src/store.js";
import { createRdsHandler } from "../src/routes.js";
import { LocalOutbox } from "../../../tools/rds-jbryon-mcp/outbox.mjs";
import { openOfflineCache, upsertOfflineNodes } from "../../../tools/rds-jbryon-mcp/offline-cache.mjs";

const SQL = readFileSync(fileURLToPath(new URL("../migrations/0001_rds_jbryon.sql", import.meta.url)), "utf8");
const EPOCH = "0123456789abcdef0123456789abcdef";
const TOKEN = "integration-token";
const NOW = "2026-10-26T10:00:00.000Z";

async function boot(db) {
  await applySchema(db, SQL);
  await initWorkspace(db, { epoch: EPOCH });
  const store = createRdsStore({ db, epoch: EPOCH, now: NOW });
  const handler = createRdsHandler({ store, token: TOKEN });
  return { store, handler };
}

function call(handler, body) {
  return handler.handle(new Request("https://rds.test/rds", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  }));
}

function request(id, operation, extra = {}) {
  return {
    protocol: "rds-jbryon",
    apiVersion: 1,
    workspaceEpoch: EPOCH,
    requestId: id,
    operation,
    ...extra
  };
}

test("capabilities are served over HTTP from the real store", async () => {
  await withD1(async (_binding, db) => {
    const { handler } = await boot(db);
    const response = await call(handler, {
      protocol: "rds-jbryon", apiVersion: 1, kind: "query", operation: "capabilities", params: {}
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.product, "RDS-JBryon");
    assert.equal(body.workspaceEpoch, EPOCH);
  });
});

test("a directory and a snapshot travel the full local chain", async () => {
  await withD1(async (_binding, db) => {
    const { store, handler } = await boot(db);
    const domainResponse = await call(handler, {
      protocol: "rds-jbryon", apiVersion: 1, kind: "request",
      request: request("req-00000000", "directory.create", { target: { name: "project", kind: "domain" } })
    });
    assert.equal(domainResponse.status, 202);
    const domainReceipt = await domainResponse.json();
    await store.projectAll({ owner: "test", maxTasks: 10 });
    assert.equal((await store.requestStatus(domainReceipt.requestId)).effect, "applied");
    const domain = await store.resolvePath(["project"]);

    const create = await call(handler, {
      protocol: "rds-jbryon", apiVersion: 1, kind: "request",
      request: request("req-00000001", "directory.create", {
        target: { parentId: domain.nodeId, name: "12306", kind: "directory" }
      })
    });
    assert.equal(create.status, 202);
    const receipt = await create.json();
    assert.equal(receipt.status, "d1_committed");
    assert.equal((await store.requestStatus(receipt.requestId)).effect, "pending");

    await store.projectAll({ owner: "test", maxTasks: 10 });
    assert.equal((await store.requestStatus(receipt.requestId)).effect, "applied");
    const resolved = await store.resolvePath(["project", "12306"]);
    assert.equal(resolved.name, "12306");

    const snapshot = request("req-00000002", "snapshot.create", {
      target: { parentId: resolved.nodeId, name: "学习快照.json", kind: "snapshot" },
      changes: [{ op: "set", path: ["topic"], value: "余票展示" }]
    });
    const snapshotResponse = await call(handler, {
      protocol: "rds-jbryon", apiVersion: 1, kind: "request", request: snapshot
    });
    assert.equal(snapshotResponse.status, 202);
    await store.projectAll({ owner: "test", maxTasks: 10 });
    const read = await call(handler, {
      protocol: "rds-jbryon", apiVersion: 1, kind: "query",
      operation: "snapshot.read", params: { nodeId: (await store.resolvePath(["project", "12306", "学习快照.json"])).nodeId }
    });
    const body = await read.json();
    assert.equal(body.content.topic, "余票展示");
    assert.equal(body.waiting, false);
  });
});

test("an unauthenticated write never reaches the store", async () => {
  await withD1(async (_binding, db) => {
    const { store } = await boot(db);
    const response = await createRdsHandler({ store, token: TOKEN }).handle(new Request("https://rds.test/rds", {
      method: "POST",
      headers: { authorization: "Bearer wrong", "content-type": "application/json" },
      body: JSON.stringify({
        protocol: "rds-jbryon", apiVersion: 1, kind: "request",
        request: request("req-00000001", "directory.create", { target: { name: "project", kind: "domain" } })
      })
    }));
    assert.equal(response.status, 401);
    const count = await db.prepare("SELECT COUNT(1) AS n FROM requests").first("n");
    assert.equal(Number(count), 0);
  });
});

test("J26 administrator task retry returns through HTTP and completes the same request", async () => {
  await withD1(async (_binding, db) => {
    const { store, handler } = await boot(db);
    const accepted = await store.accept(request("req-admin-retry-0001", "directory.create", {
      target: { name: "project", kind: "domain" }
    }));
    await db.prepare(
      "UPDATE tasks SET state = 'needs_attention', failure_count = 5, last_error = 'fixture_failure' WHERE task_id = ?"
    ).bind(accepted.taskId).run();
    await db.prepare("UPDATE requests SET effect = 'needs_attention' WHERE request_id = ?")
      .bind(accepted.requestId).run();

    const response = await call(handler, {
      protocol: "rds-jbryon", apiVersion: 1, kind: "admin",
      operation: "task.retry", params: { taskId: accepted.taskId, reason: "operator-fixed" }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      taskId: accepted.taskId, state: "pending", retriedAt: NOW
    });
    const repeatedRetry = await call(handler, {
      protocol: "rds-jbryon", apiVersion: 1, kind: "admin",
      operation: "task.retry", params: { taskId: accepted.taskId, reason: "duplicate" }
    });
    assert.equal(repeatedRetry.status, 409);
    assert.equal((await repeatedRetry.json()).error.code, "task_not_retryable");
    const pending = await store.taskStatus({ taskId: accepted.taskId });
    assert.equal(pending.state, "pending");
    assert.equal(pending.failureCount, 0);
    assert.equal(pending.leaseEpoch, 1);
    assert.equal(pending.lastError, "operator-fixed");

    const run = await store.projectAll({ owner: "operator-retry-worker" });
    assert.equal(run.results.find((result) => result.requestId === accepted.requestId).effect, "applied");
    assert.equal((await store.requestStatus({ requestId: accepted.requestId })).effect, "applied");
  });
});

test("J04 a frozen path request follows the same snapshot after its directory moves", async () => {
  await withD1(async (_binding, db) => {
    const { store } = await boot(db);
    const project = await store.accept(request("req-move-project-0001", "directory.create", {
      target: { path: ["project"], kind: "domain" }
    }));
    await store.projectAll({ owner: "move-test" });
    const folder = await store.accept(request("req-move-folder-0001", "directory.create", {
      target: { parentId: project.targetNodeId, name: "12306", kind: "directory" }
    }));
    await store.projectAll({ owner: "move-test" });
    const snapshot = await store.accept(request("req-move-snapshot-0001", "snapshot.create", {
      target: { parentId: folder.targetNodeId, name: "学习快照.json" },
      changes: [{ op: "set", path: ["title"], value: "余票展示" }]
    }));
    await store.projectAll({ owner: "move-test" });
    const knowledge = await store.accept(request("req-move-knowledge-0001", "directory.create", {
      target: { path: ["knowledge"], kind: "domain" }
    }));
    await store.projectAll({ owner: "move-test" });

    const directory = await mkdtemp(join(tmpdir(), "rds-jbryon-move-route-"));
    const path = join(directory, "client.sqlite");
    const outbox = new LocalOutbox({ path, owner: "move-route-test" });
    const cache = openOfflineCache({ path });
    try {
      upsertOfflineNodes(cache, [
        { nodeId: project.targetNodeId, name: "project", kind: "domain" },
        { nodeId: folder.targetNodeId, parentId: project.targetNodeId, name: "12306", kind: "directory" },
        { nodeId: snapshot.targetNodeId, parentId: folder.targetNodeId, name: "学习快照.json", kind: "snapshot" }
      ]);
      const patch = request("req-move-pending-0001", "snapshot.patch", {
        target: { path: ["project", "12306", "学习快照.json"] },
        baseRevision: 1,
        changes: [{ op: "set", path: ["answer"], value: "查询先看余票" }]
      });
      outbox.enqueue(patch);
      const frozen = outbox.get(patch.requestId).request;
      assert.equal(frozen.target.nodeId, snapshot.targetNodeId);

      const move = await store.accept(request("req-move-folder-0002", "directory.move", {
        target: { nodeId: folder.targetNodeId, parentId: knowledge.targetNodeId }
      }));
      await store.projectAll({ owner: "move-test" });
      assert.equal((await store.requestStatus({ requestId: move.requestId })).effect, "applied");

      const claimed = outbox.claimOne(patch.requestId);
      const receipt = await store.accept(claimed.request);
      outbox.acknowledge(receipt);
      await store.projectAll({ owner: "move-test" });
      assert.equal((await store.requestStatus({ requestId: patch.requestId })).effect, "applied");
      assert.equal((await store.readSnapshot({ nodeId: snapshot.targetNodeId })).content.answer, "查询先看余票");
      assert.equal((await store.resolvePath(["knowledge", "12306", "学习快照.json"])).nodeId,
        snapshot.targetNodeId);
    } finally {
      cache.close();
      outbox.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
