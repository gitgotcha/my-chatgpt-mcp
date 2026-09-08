import assert from "node:assert/strict";
import test from "node:test";
import { createBudget } from "../src/rds2/io/budget.js";
import { closeOutFailure } from "../src/rds2/errors/close-out.js";

function fakeIo({ remaining = 20, updateChanges = 1, logs = [] } = {}) {
  const budget = createBudget(20);
  const originalRemaining = budget.remaining;
  if (remaining < 20) {
    for (let index = 0; index < 20 - remaining; index += 1) budget.consume("d1");
  }
  return {
    budget: { ...budget, remaining: () => Math.min(originalRemaining(), remaining) },
    log: (line) => logs.push(JSON.parse(line)),
    db: {
      prepare(sql) {
        const statement = {
          bind() { return statement; },
          async first() { return sql.startsWith("SELECT") ? { failure_count: 0 } : null; },
          async run() { return { meta: { changes: updateChanges }, results: [] }; }
        };
        return statement;
      }
    }
  };
}

const lease = { taskId: "task-1", owner: "owner-1", epoch: 1 };
const now = "2026-09-08T10:00:00.000Z";

test("T14 a transient fault is bounded, sanitized and counted through failTask", async () => {
  const logs = [];
  const result = await closeOutFailure({
    io: fakeIo({ logs }), lease, now, taskId: lease.taskId,
    error: Object.assign(new Error("SQLITE password=secret"), { code: "D1_DOWN" })
  });
  assert.equal(result.outcome, "retry");
  assert.equal(result.class, "C");
  assert.equal(logs.length, 1);
  assert.deepEqual(Object.keys(logs[0]).sort(), ["at", "class", "code", "event", "outcome", "taskId"]);
  assert.equal(JSON.stringify(logs).includes("secret"), false);
});

test("T14 a deterministic contract fault parks without entering the retry counter", async () => {
  const logs = [];
  const result = await closeOutFailure({
    io: fakeIo({ logs }), lease, now, taskId: lease.taskId,
    error: Object.assign(new Error("changes_too_large"), { code: "changes_too_large" })
  });
  assert.equal(result.outcome, "needs_attention");
  assert.equal(result.class, "D");
  assert.equal(logs[0].code, "changes_too_large");
});

test("T14 an exhausted close-out budget returns stable E and never claims persistence", async () => {
  const logs = [];
  const result = await closeOutFailure({
    io: fakeIo({ remaining: 1, logs }), lease, now, taskId: lease.taskId,
    error: Object.assign(new Error("D1_DOWN"), { code: "D1_DOWN" })
  });
  assert.equal(result.outcome, "failed");
  assert.equal(result.class, "E");
  assert.equal(result.code, "budget_exhausted_no_closeout");
  assert.deepEqual(logs, []);
});

