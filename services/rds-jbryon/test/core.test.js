// Pure-core tests for RDS-JBryon: names/paths, request validation, status
// display, three-way merge and dependency classification (J02/J14/J15/J18).
import test from "node:test";
import assert from "node:assert/strict";
import {
  BUDGETS,
  EFFECT_STATUS,
  LOCAL_STATUS,
  RdsError,
  displayStatus,
  normalizeName,
  normalizePath,
  validateRequest,
  PROTOCOL
} from "../src/contracts.js";
import {
  applyChanges,
  classifyDependency,
  hasDependencyCycle
} from "../src/merge.js";

const EPOCH = "0123456789abcdef0123456789abcdef";

const request = (overrides = {}) => ({
  protocol: PROTOCOL,
  apiVersion: 1,
  workspaceEpoch: EPOCH,
  requestId: "req-00000001",
  operation: "snapshot.patch",
  target: { nodeId: "n1" },
  changes: [{ op: "set", path: ["nextUnit"], value: "token-bucket" }],
  ...overrides
});

const codeOf = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error.code;
  }
};

test("names are NFC-normalized and never lowercased", () => {
  assert.equal(normalizeName("余票展示"), "余票展示");
  assert.equal(normalizeName("JVM"), "JVM");
  assert.equal(normalizeName("e\u0301"), "\u00e9");
  assert.notEqual(normalizeName("JVM"), normalizeName("jvm"));
});

test("names reject separators, dot segments, empty and oversized values", () => {
  for (const bad of ["", ".", "..", "a/b", "a\\b", "a".repeat(BUDGETS.maxNameCharacters + 1), "中".repeat(BUDGETS.maxNameCharacters + 1)]) {
    assert.equal(codeOf(() => normalizeName(bad)), "invalid_name", `accepted ${JSON.stringify(bad)}`);
  }
});

test("paths are arrays with a bounded depth and a display form", () => {
  assert.deepEqual(normalizePath(["project", "12306", "余票展示"]), ["project", "12306", "余票展示"]);
  assert.equal(codeOf(() => normalizePath("project/12306")), "invalid_path");
  assert.equal(codeOf(() => normalizePath(new Array(BUDGETS.maxDepth + 1).fill("x"))), "invalid_path");
});

test("the request envelope is single-user and version-pinned", () => {
  assert.doesNotThrow(() => validateRequest(request()));
  assert.equal(codeOf(() => validateRequest(request({ apiVersion: 2 }))), "unsupported_api_version");
  assert.equal(codeOf(() => validateRequest(request({ protocol: "rds-v2" }))), "unsupported_protocol");
  assert.equal(codeOf(() => validateRequest(request({ workspaceEpoch: "abc" }))), "invalid_workspace_epoch");
  assert.equal(codeOf(() => validateRequest(request({ user: "乔炳源" }))), "invalid_request");
  assert.equal(codeOf(() => validateRequest(request({ operation: "user.register" }))), "unsupported_operation");
  assert.equal(
    codeOf(() => validateRequest(request({ changes: new Array(BUDGETS.maxPatchOperations + 1).fill({ op: "set", path: ["a"], value: 1 }) }))),
    "invalid_changes"
  );
});

test("J25 every local/effect pair has a truthful display status", () => {
  const expected = {
    local_pending: "local_pending",
    sending: "sending",
    waiting_dependency: "waiting_dependency",
    delivery_blocked: "delivery_blocked",
    cancelled: "cancelled"
  };
  const cloud = {
    pending: "d1_committed",
    applied: "projected",
    applied_noop: "projected",
    conflict: "conflict",
    cancelled: "cancelled",
    needs_attention: "needs_attention"
  };
  for (const local of LOCAL_STATUS) {
    for (const effect of [null, ...EFFECT_STATUS]) {
      const display = displayStatus({ local, effect });
      const want = local === "cloud_acknowledged" ? (effect === null ? "d1_committed" : cloud[effect]) : expected[local];
      assert.equal(display, want, `${local} + ${effect ?? "no effect"}`);
    }
  }
  assert.equal(displayStatus({ local: "cloud_acknowledged", effect: null }), "d1_committed");
});

test("independent fields merge automatically", () => {
  const result = applyChanges({
    base: { title: "旧", nextUnit: "锁" },
    current: { title: "旧", nextUnit: "锁" },
    changes: [
      { op: "set", path: ["title"], value: "12306" },
      { op: "set", path: ["owner"], value: "乔炳源" }
    ]
  });
  assert.equal(result.status, "applied");
  assert.deepEqual(result.value, { title: "12306", nextUnit: "锁", owner: "乔炳源" });
});

test("setting the same value is a no-op and keeps the revision unchanged", () => {
  const result = applyChanges({
    base: { title: "12306" },
    current: { title: "12306" },
    changes: [{ op: "set", path: ["title"], value: "12306" }]
  });
  assert.equal(result.status, "applied_noop");
  assert.equal(result.changed, false);
});

test("a concurrent different value becomes a conflict with both sides kept", () => {
  const result = applyChanges({
    base: { nextUnit: "锁" },
    current: { nextUnit: "令牌桶" },
    changes: [{ op: "set", path: ["nextUnit"], value: "选座" }]
  });
  assert.equal(result.status, "conflict");
  assert.deepEqual(result.conflicts[0], {
    path: ["nextUnit"],
    reason: "concurrent_change",
    base: "锁",
    current: "令牌桶",
    proposed: "选座"
  });
});

test("delete against a modified field conflicts instead of dropping data", () => {
  const result = applyChanges({
    base: { note: "a" },
    current: { note: "b" },
    changes: [{ op: "remove", path: ["note"] }]
  });
  assert.equal(result.status, "conflict");
  assert.equal(result.conflicts[0].reason, "delete_modified");
});

test("parent and child paths overlap and are never ordered silently", () => {
  const result = applyChanges({
    base: {},
    current: {},
    changes: [
      { op: "set", path: ["a"], value: { b: 1 } },
      { op: "set", path: ["a", "b"], value: 2 }
    ]
  });
  assert.equal(result.status, "conflict");
  assert.equal(result.conflicts[0].reason, "overlapping_paths");
});

test("one conflicting operation means the whole request is a conflict", () => {
  const result = applyChanges({
    base: { a: 1, b: 2 },
    current: { a: 9, b: 2 },
    changes: [
      { op: "set", path: ["b"], value: 3 },
      { op: "set", path: ["a"], value: 1 }
    ]
  });
  assert.equal(result.status, "conflict");
  assert.equal(result.value, undefined);
});

test("item sets merge by itemId and conflict only on the same id", () => {
  const base = { attempts: { A: { answer: "a" } } };
  const current = { attempts: { A: { answer: "a" }, B: { answer: "b" } } };
  const merged = applyChanges({
    base,
    current,
    changes: [{ op: "item_set", field: "attempts", itemId: "C", value: { answer: "c" } }]
  });
  assert.equal(merged.status, "applied");
  assert.deepEqual(merged.value.attempts.C, { answer: "c" });
  assert.deepEqual(merged.value.attempts.B, { answer: "b" });

  const noop = applyChanges({
    base, current,
    changes: [{ op: "item_set", field: "attempts", itemId: "A", value: { answer: "a" } }]
  });
  assert.equal(noop.status, "applied_noop");

  const conflict = applyChanges({
    base,
    current: { attempts: { A: { answer: "b" } } },
    changes: [{ op: "item_set", field: "attempts", itemId: "A", value: { answer: "changed" } }]
  });
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.conflicts[0].reason, "item_concurrent_change");
});

test("dependencies require a real applied effect, not a receipt", () => {
  const effects = {
    "req-a": { effect: "applied", workspaceEpoch: EPOCH },
    "req-b": { effect: "pending", workspaceEpoch: EPOCH },
    "req-c": { effect: "conflict", workspaceEpoch: EPOCH },
    "req-d": { effect: "cancelled", workspaceEpoch: EPOCH }
  };
  const lookupEffect = (id) => effects[id];
  const lookupRequest = () => null;
  assert.deepEqual(
    classifyDependency({ request: request({ dependsOn: ["req-a"] }), lookupEffect, lookupRequest, epoch: EPOCH }),
    { ready: true }
  );
  assert.equal(
    classifyDependency({ request: request({ dependsOn: ["req-b"] }), lookupEffect, lookupRequest }).code,
    "dependency_pending"
  );
  assert.equal(
    classifyDependency({ request: request({ dependsOn: ["req-c"] }), lookupEffect, lookupRequest }).code,
    "dependency_replan_required"
  );
  assert.equal(
    classifyDependency({ request: request({ dependsOn: ["req-d"] }), lookupEffect, lookupRequest }).code,
    "dependency_cancelled"
  );
  assert.equal(
    classifyDependency({ request: request({ dependsOn: ["missing"] }), lookupEffect, lookupRequest }).code,
    "dependency_missing"
  );
});

test("dependency cycles are detected within a bounded walk", () => {
  const graph = {
    "req-a": { dependsOn: ["req-b"] },
    "req-b": { dependsOn: ["req-c"] },
    "req-c": { dependsOn: ["req-a"] }
  };
  assert.equal(hasDependencyCycle("req-a", ["req-b"], (id) => graph[id]), true);
  assert.equal(hasDependencyCycle("req-x", ["req-b"], (id) => graph[id]), false);
});

test("an error carries a stable code", () => {
  try {
    normalizeName("a/b");
    assert.fail("should throw");
  } catch (error) {
    assert.ok(error instanceof RdsError);
    assert.equal(error.code, "invalid_name");
  }
});

test("several item additions in one request all survive", () => {
  const result = applyChanges({
    base: {},
    current: {},
    changes: [
      { op: "item_set", path: [], field: "attempts", itemId: "answer-A", value: { answer: "A" } },
      { op: "item_set", path: [], field: "attempts", itemId: "answer-B", value: { answer: "B" } }
    ]
  });
  assert.equal(result.status, "applied");
  assert.deepEqual(Object.keys(result.value.attempts).sort(), ["answer-A", "answer-B"]);
});

test("writing below a deleted parent is a conflict, never a silent recreate", () => {
  const result = applyChanges({
    base: { section: { existing: "old" } },
    current: {},
    changes: [{ op: "set", path: ["section", "newAnswer"], value: "new" }]
  });
  assert.equal(result.status, "conflict");
  assert.equal(result.conflicts[0].reason, "parent_deleted");
});

test("the same itemId twice in one request does not last-write-win", () => {
  const result = applyChanges({
    base: {},
    current: {},
    changes: [
      { op: "item_set", path: [], field: "answers", itemId: "same-id", value: "first" },
      { op: "item_set", path: [], field: "answers", itemId: "same-id", value: "second" }
    ]
  });
  assert.equal(result.status, "conflict");
});

test("an item write may not recreate a deleted collection", () => {
  const result = applyChanges({
    base: { answers: { old: "base" } },
    current: {},
    changes: [{ op: "item_set", path: [], field: "answers", itemId: "new", value: "new answer" }]
  });
  assert.equal(result.status, "conflict");
  assert.equal(result.conflicts[0].reason, "parent_deleted");
});

test("deleting an already deleted field is a no-op, not a conflict", () => {
  const result = applyChanges({
    base: { field: "old" },
    current: {},
    changes: [{ op: "remove", path: ["field"] }]
  });
  assert.equal(result.status, "applied_noop");
  assert.equal(result.changed, false);
});
