// Queue consumer and Cron recovery wiring (design §10, J10/J12 local layer).
import test from "node:test";
import assert from "node:assert/strict";
import { createProjectionQueue, createScheduledRecovery } from "../src/queue.js";

function fakeStore() {
  const state = {
    claimed: [
      { taskId: "t1", epoch: 1, operation: "snapshot.patch" },
      { taskId: "t2", epoch: 1, operation: "directory.create" }
    ],
    byId: {
      "t1": { ok: true, taskId: "t1", owner: "queue-owner", epoch: 2 },
      "t2": { blocked: true, code: "dependency_pending" }
    },
    applied: [],
    projectAllCalls: 0
  };
  return {
    state,
    async claimTask() { return state.claimed.shift() ?? null; },
    async claimTaskById({ taskId, owner }) {
      const entry = state.byId[taskId];
      if (entry?.blocked) return entry;
      return { taskId, owner, epoch: 2 };
    },
    async applyOne({ taskId, owner, epoch }) {
      state.applied.push({ taskId, owner, epoch });
      return { ok: true, effect: "applied" };
    },
    async projectAll({ maxTasks }) {
      state.projectAllCalls += 1;
      return { processed: maxTasks };
    }
  };
}

test("a dispatched message carries only identity and the consumer re-leases", async () => {
  const store = fakeStore();
  const queue = createProjectionQueue({ store, owner: "queue-owner" });
  const messages = await queue.dispatchDue({ limit: 2 });
  assert.deepEqual(messages.map((message) => message.taskId), ["t1", "t2"]);
  assert.equal(messages[0].taskType, "projection");
  assert.deepEqual(Object.keys(messages[0]).sort(), ["attempt", "taskId", "taskType"]);
  assert.equal(JSON.stringify(messages).includes("changes"), false);

  const result = await queue.consume(messages[0]);
  assert.equal(result.ok, true);
  assert.deepEqual(store.state.applied[0], { taskId: "t1", owner: "queue-owner", epoch: 2 });
});

test("a message whose dependency is not ready is not applied", async () => {
  const store = fakeStore();
  const queue = createProjectionQueue({ store });
  const result = await queue.consume({ taskId: "t2" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "dependency_pending");
  assert.equal(store.state.applied.length, 0);
});

test("a duplicate delivery cannot steal a live lease", async () => {
  const store = fakeStore();
  store.claimTaskById = async () => null;
  const queue = createProjectionQueue({ store });
  const result = await queue.consume({ taskId: "t1" });
  assert.equal(result.ok, false);
  assert.equal(result.stale, true);
});

test("the scheduled handler drives due work through the same task table", async () => {
  const store = fakeStore();
  const scheduled = createScheduledRecovery({ store, maxTasks: 7 });
  const result = await scheduled();
  assert.equal(store.state.projectAllCalls, 1);
  assert.equal(result.processed, 7);
  assert.match(result.ranAt, /^\d{4}-\d{2}-\d{2}T/);
});
