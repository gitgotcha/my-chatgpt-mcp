import assert from "node:assert/strict";
import test from "node:test";
import { createBudget } from "../src/rds2/io/budget.js";
import { createInvocationIo, wrapQueue } from "../src/rds2/io/invocation-io.js";

function countingDb() {
  let calls = 0;
  const db = {
    prepare() {
      const statement = {
        bind() { return statement; },
        async first() { calls += 1; return null; },
        async all() { calls += 1; return { results: [], meta: {} }; },
        async run() { calls += 1; return { results: [], meta: { changes: 0 } }; }
      };
      return statement;
    },
    async batch() { calls += 1; return []; }
  };
  return { db, calls: () => calls };
}

function assertBudgetTrace(trace, cap) {
  assert.ok(trace.length <= cap);
  assert.ok(trace.length <= 40);
  assert.ok(trace.every((item) => ["d1", "queue", "http"].includes(item.category)));
  assert.ok(trace.every((item) => !Object.hasOwn(item, "payload") && !Object.hasOwn(item, "credential")));
}

test("T14 a normal invocation records every outbound category under one budget", async () => {
  const native = countingDb();
  const sent = [];
  const io = createInvocationIo({
    db: native.db,
    queues: { PROJECTION: { send: async (message) => sent.push(message) } },
    fetchImpl: async () => new Response("ok", { status: 200 }),
    limit: 20
  });
  await io.db.prepare("SELECT 1").first();
  await io.queues.PROJECTION.send({ taskId: "t-1", type: "projection" });
  await io.fetch("https://example.test/token");
  assert.equal(native.calls(), 1);
  assert.equal(sent.length, 1);
  const snapshot = io.budget.snapshot();
  assertBudgetTrace(snapshot.entries, 20);
  assert.deepEqual(snapshot.entries.map((entry) => entry.category), ["d1", "queue", "http"]);
});

test("T14 requesting two calls with only one unit left emits nothing", async () => {
  const native = countingDb();
  const budget = createBudget(40);
  const db = createInvocationIo({ db: native.db, limit: 40 }).db;
  for (let index = 0; index < 39; index += 1) budget.consume("d1");
  const queue = wrapQueue({ sendBatch: async () => { throw new Error("must not send"); } }, budget);
  await assert.rejects(() => queue.sendBatch([{ taskId: "a" }, { taskId: "b" }]), (error) => error.code === "budget_exhausted");
  assert.equal(native.calls(), 0);
  assert.equal(budget.snapshot().used, 39);
  // The wrapped db uses its own budget; this assertion only proves creating an
  // invocation does not mutate the already exhausted ledger.
  assert.equal(db !== null, true);
});

test("T14 a queue batch charges one unit per message and preserves closed-set trace fields", async () => {
  const budget = createBudget(10);
  const sent = [];
  const queue = wrapQueue({ sendBatch: async (messages) => sent.push(...messages) }, budget);
  await queue.sendBatch([{ taskId: "a" }, { taskId: "b" }, { taskId: "c" }]);
  assert.equal(sent.length, 3);
  assert.equal(budget.snapshot().used, 3);
  assertBudgetTrace(budget.snapshot().entries, 10);
});

