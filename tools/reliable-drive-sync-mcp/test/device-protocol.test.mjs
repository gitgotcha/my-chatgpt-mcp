import assert from "node:assert/strict";
import test from "node:test";
import { normalizeName, parseSubmission, sameBinding } from "../../../shared/device-binding-protocol.mjs";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const INSTALLATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EPOCH = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const binding = {
  installationId: INSTALLATION_ID,
  bindingEpoch: EPOCH,
  bindingRevision: 4,
  userId: USER_ID
};

const writeEnvelope = (extra = {}) => ({
  schemaVersion: "1.2",
  namespace: "algorithm",
  eventType: "algorithm.learning.completed",
  requestId: "request-1",
  identity: { userId: USER_ID, username: "乔炳源" },
  payload: {
    event: {
      schemaVersion: "1.2",
      eventId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      eventKey: "algorithm:two-sum:2026-09-09",
      eventType: "algorithm.learning.completed",
      userId: USER_ID,
      username: "乔炳源",
      observedAt: "2026-09-09T00:00:00.000Z",
      source: "leetcode",
      topic: "two-sum",
      problem: { title: "Two Sum", source: "leetcode", url: "https://leetcode.com/problems/two-sum/" },
      evidence: "写出哈希表解法并说明复杂度",
      outcome: "completed",
      tags: [],
      confidence: "medium"
    }
  },
  bindingContext: binding,
  ...extra
});

test("T01 rejects mixed account/query and business envelope shapes", () => {
  assert.throws(
    () => parseSubmission({ storageVersion: 2, operation: "account.current", params: {}, eventType: "x" }),
    (error) => error?.code === "invalid_input_shape"
  );
});

test("T01 current is the only account operation that may omit an old binding", () => {
  const parsed = parseSubmission({ storageVersion: 2, operation: "account.current", params: {} });
  assert.equal(parsed.kind, "account");
  assert.deepEqual(parsed.body, { storageVersion: 2, operation: "account.current", params: {} });
  assert.equal(parsed.bindingContext, null);

  assert.throws(
    () => parseSubmission({ storageVersion: 2, operation: "account.switch", params: { accountHandle: "acct-1" } }),
    (error) => error?.code === "binding_context_required"
  );
});

test("T01 personal query requires the complete binding context and strips it from the body", () => {
  assert.throws(
    () => parseSubmission({ storageVersion: 2, operation: "projection.read", params: { namespace: "algorithm", projectionName: "learning" } }),
    (error) => error?.code === "binding_context_required"
  );
  const parsed = parseSubmission({
    storageVersion: 2,
    operation: "projection.read",
    params: { namespace: "algorithm", projectionName: "learning", limit: 20 },
    bindingContext: binding
  });
  assert.equal(parsed.kind, "query");
  assert.deepEqual(parsed.body.params, { namespace: "algorithm", projectionName: "learning", limit: 20 });
  assert.deepEqual(parsed.bindingContext, binding);
  assert.equal(Object.hasOwn(parsed.body, "bindingContext"), false);
});

test("T01 capabilities is public but unknown account/query operations are closed", () => {
  const parsed = parseSubmission({ storageVersion: 2, operation: "capabilities", params: {} });
  assert.equal(parsed.kind, "query");
  for (const operation of ["account.delete", "profile.read", "event.write"]) {
    assert.throws(
      () => parseSubmission({ storageVersion: 2, operation, params: {} }),
      (error) => error?.code === "invalid_operation"
    );
  }
});

test("T01 personal write requires bindingContext and forwards the old envelope unchanged", () => {
  assert.throws(
    () => parseSubmission({ ...writeEnvelope(), bindingContext: undefined }),
    (error) => error?.code === "binding_context_required"
  );
  const parsed = parseSubmission(writeEnvelope());
  assert.equal(parsed.kind, "write");
  assert.deepEqual(parsed.bindingContext, binding);
  assert.equal(Object.hasOwn(parsed.body, "bindingContext"), false);
  assert.equal(parsed.body.requestId, "request-1");
  assert.equal(parsed.body.payload.event.eventId, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
});

test("T01 rejects malformed binding revisions and user IDs", () => {
  for (const bad of [
    { ...binding, bindingRevision: -1 },
    { ...binding, bindingRevision: 1.5 },
    { ...binding, bindingRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...binding, userId: "not-a-uuid" },
    { ...binding, userId: undefined },
    { ...binding, bindingEpoch: "not-a-uuid" }
  ]) {
    assert.throws(
      () => parseSubmission({ storageVersion: 2, operation: "projection.read", params: { namespace: "algorithm", projectionName: "learning" }, bindingContext: bad }),
      (error) => error?.code === "invalid_binding_context"
    );
  }
  const unbound = { ...binding, userId: null };
  assert.deepEqual(
    parseSubmission({ storageVersion: 2, operation: "account.find", params: {}, bindingContext: unbound }).bindingContext,
    unbound
  );
});

test("T01 normalizes names with NFKC and enforces scalar/byte/control limits", () => {
  assert.equal(normalizeName("  Ｊｏｅ  "), "Joe");
  assert.throws(() => normalizeName(""), (error) => error?.code === "invalid_display_name");
  assert.throws(() => normalizeName("a\u0000b"), (error) => error?.code === "invalid_display_name");
  assert.throws(() => normalizeName("\ud800"), (error) => error?.code === "invalid_display_name");
  assert.throws(() => normalizeName("乔".repeat(81)), (error) => error?.code === "invalid_display_name");
  assert.throws(() => normalizeName("😀".repeat(81)), (error) => error?.code === "invalid_display_name");
});

test("T01 sameBinding compares all four CAS fields, including the unbound null user", () => {
  assert.equal(sameBinding(binding, { ...binding }), true);
  for (const field of ["installationId", "bindingEpoch", "bindingRevision", "userId"]) {
    const changed = { ...binding, [field]: field === "bindingRevision" ? 5 : field === "userId" ? "22222222-2222-4222-8222-222222222222" : "changed" };
    assert.equal(sameBinding(binding, changed), false, field);
  }
  assert.equal(sameBinding({ ...binding, userId: null }, { ...binding, userId: null }), true);
  assert.equal(sameBinding({ ...binding, userId: null }, binding), false);
});
