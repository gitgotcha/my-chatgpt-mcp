// Worker wiring: HTTP -> D1 task, Queue consumer -> projection, Cron -> dispatch
// and recovery (design §4, §10). Local D1 only; no Cloudflare deployment.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withD1, applySchema } from "./support/d1.js";
import { createRdsStore, initWorkspace } from "../src/store.js";
import { createProjectionQueue } from "../src/queue.js";
import { createWorker } from "../src/worker.js";

const SQL = readFileSync(fileURLToPath(new URL("../migrations/0001_rds_jbryon.sql", import.meta.url)), "utf8");
const EPOCH = "0123456789abcdef0123456789abcdef";
const TOKEN = "worker-token";
const NOW = "2026-10-26T15:00:00.000Z";
const BASE = { protocol: "rds-jbryon", apiVersion: 1 };

async function boot(db, extra = {}, clock = () => NOW) {
  await applySchema(db, SQL);
  await initWorkspace(db, { epoch: EPOCH });
  const worker = createWorker({
    createStore: ({ db: binding, epoch }) => createRdsStore({ db: binding, epoch: epoch ?? EPOCH, now: clock })
  });
  const env = {
    DB: db,
    RDS_TOKEN: TOKEN,
    RDS_WORKSPACE_EPOCH: EPOCH,
    QUEUE: { send: async () => {} },
    ...extra
  };
  return { worker, env };
}

function http(env, worker, body, token = TOKEN) {
  return worker.fetch(new Request("https://rds.test/rds", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  }), env);
}

function request(id, extra = {}) {
  return {
    ...BASE, workspaceEpoch: EPOCH, requestId: id,
    operation: "directory.create", target: { path: ["project"], kind: "domain" },
    ...extra
  };
}

test("the worker refuses requests without the service token", async () => {
  await withD1(async (_binding, db) => {
    const { worker, env } = await boot(db);
    const response = await http(env, worker, { ...BASE, kind: "query", operation: "capabilities" }, "wrong");
    assert.equal(response.status, 401);
  });
});

test("the Queue consumer applies a dispatched task end to end", async () => {
  await withD1(async (_binding, db) => {
    const { worker, env } = await boot(db);
    const accepted = await http(env, worker, { ...BASE, kind: "request", request: request("worker-req-00000001") });
    assert.equal(accepted.status, 202);

    const store = createRdsStore({ db, now: NOW, epoch: EPOCH });
    const dispatcher = createProjectionQueue({ store, owner: "worker-dispatcher" });
    const messages = await dispatcher.dispatchDue({ limit: 1 });
    assert.equal(messages.length, 1);

    const acks = [];
    const result = await worker.queue({
      messages: [{ body: messages[0], ack: () => acks.push("ack"), retry: () => acks.push("retry") }]
    }, env);
    assert.equal(result.processed, 1);
    assert.equal(result.outcomes[0].ok, true);
    assert.deepEqual(acks, ["ack"]);
    assert.equal((await store.requestStatus("worker-req-00000001")).effect, "applied");
  });
});

test("cron dispatch leaves projection to the Queue consumer", async () => {
  await withD1(async (_binding, db) => {
    const sent = [];
    const { worker, env } = await boot(db, { QUEUE: { send: async (message) => sent.push(message) } });
    const accepted = await http(env, worker, { ...BASE, kind: "request", request: request("worker-req-00000002") });
    const receipt = await accepted.json();
    const result = await worker.scheduled({}, env);
    assert.equal(result.dispatched, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].taskType, "projection");
    assert.deepEqual(Object.keys(sent[0]).sort(), ["attempt", "taskId", "taskType"]);
    assert.equal(JSON.stringify(sent[0]).includes("changes"), false);
    const store = createRdsStore({ db, now: NOW, epoch: EPOCH });
    assert.equal((await store.requestStatus("worker-req-00000002")).effect, "pending");
    const taskBeforeConsume = await store.taskStatus(receipt.taskId);
    assert.equal(taskBeforeConsume.state, "queued");

    const acks = [];
    await worker.queue({ messages: [{ body: sent[0], ack: () => acks.push("ack") }] }, env);
    assert.deepEqual(acks, ["ack"]);
    assert.equal((await store.requestStatus("worker-req-00000002")).effect, "applied");
    assert.equal((await store.releaseQueuedTask({ taskId: sent[0].taskId, epoch: sent[0].attempt })).released, false);
  });
});

test("a failed Queue send releases the handoff so the next Cron can retry", async () => {
  await withD1(async (_binding, db) => {
    let shouldFail = true;
    const sent = [];
    const { worker, env } = await boot(db, {
      QUEUE: {
        send: async (message) => {
          if (shouldFail) throw new Error("queue unavailable");
          sent.push(message);
        }
      }
    });
    await http(env, worker, { ...BASE, kind: "request", request: request("worker-req-00000003") });

    const first = await worker.scheduled({}, env);
    assert.equal(first.dispatched, 1);
    assert.equal(first.sent[0].error, "queue_send_failed");
    assert.equal(first.sent[0].released, true);
    const store = createRdsStore({ db, now: NOW, epoch: EPOCH });
    assert.equal((await store.requestStatus("worker-req-00000003")).effect, "pending");

    shouldFail = false;
    const second = await worker.scheduled({}, env);
    assert.equal(second.dispatched, 1);
    assert.equal(sent.length, 1);
    const acks = [];
    await worker.queue({ messages: [{ body: sent[0], ack: () => acks.push("ack") }] }, env);
    assert.deepEqual(acks, ["ack"]);
    assert.equal((await store.requestStatus("worker-req-00000003")).effect, "applied");
  });
});

test("an overdue queued task is re-dispatched and duplicate messages remain harmless", async () => {
  await withD1(async (_binding, db) => {
    let current = NOW;
    const sent = [];
    const { worker, env } = await boot(db, { QUEUE: { send: async (message) => sent.push(message) } }, () => current);
    await http(env, worker, { ...BASE, kind: "request", request: request("worker-req-00000004") });

    const first = await worker.scheduled({}, env);
    assert.equal(first.dispatched, 1);
    const tooSoon = await worker.scheduled({}, env);
    assert.equal(tooSoon.dispatched, 0);

    current = new Date(Date.parse(NOW) + 300_000).toISOString();
    const recovery = await worker.scheduled({}, env);
    assert.equal(recovery.dispatched, 1);
    assert.equal(sent.length, 2);

    const acknowledgements = [];
    await worker.queue({
      messages: sent.map((body) => ({ body, ack: () => acknowledgements.push("ack") }))
    }, env);
    assert.deepEqual(acknowledgements, ["ack", "ack"]);
    const store = createRdsStore({ db, now: () => current, epoch: EPOCH });
    assert.equal((await store.requestStatus("worker-req-00000004")).effect, "applied");
  });
});
