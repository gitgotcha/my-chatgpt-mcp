// T10: the fixed V1→V2 read mapping and the explicit V2 status input schema.
import assert from "node:assert/strict";
import test from "node:test";
import { V2_OPERATIONS, toV2Query, isV2ReadMessage, parseV2StatusInput } from "../v2-routing.mjs";

const read = (eventType, payload = {}, overrides = {}) => ({
  schemaVersion: "1.2",
  namespace: "system",
  eventType,
  identity: { username: "乔炳源" },
  payload,
  requestId: "req-read",
  ...overrides
});

test("T10 the five v1 read messages map to the frozen v2 operations", () => {
  assert.deepEqual(V2_OPERATIONS, {
    "system.capabilities.read": "capabilities",
    "system.user.resolve": "user.resolve",
    "interview.session.list": "interview.session.list",
    "interview.session.load": "interview.session.load",
    "profile.snapshot.read": "projection.read"
  });

  const capabilities = toV2Query(read("system.capabilities.read"));
  assert.deepEqual(capabilities, { storageVersion: 2, operation: "capabilities", params: {} });

  const listed = toV2Query(read("interview.session.list", { limit: 5 }));
  assert.deepEqual(listed, { storageVersion: 2, operation: "interview.session.list", params: { limit: 5 } });

  const loaded = toV2Query(read("interview.session.load", { sessionId: "s-1" }));
  assert.deepEqual(loaded, { storageVersion: 2, operation: "interview.session.load", params: { sessionId: "s-1" } });

  assert.equal(isV2ReadMessage(read("system.capabilities.read")), true);
  assert.equal(isV2ReadMessage(read("algorithm.learning.completed")), false,
    "a write event is not a v2 read");
});

test("T10 profile.snapshot.read binds domain as projectionName", () => {
  const query = toV2Query(read("profile.snapshot.read", { domain: "algorithm", limit: 10 }));
  assert.equal(query.operation, "projection.read");
  assert.equal(query.params.namespace, "profile");
  assert.equal(query.params.projectionName, "algorithm", "domain is bound as the projection name");
  assert.equal(query.params.limit, 10);
});

test("T10 user.resolve carries only the displayName", () => {
  const query = toV2Query(read("system.user.resolve", {
    displayName: "乔炳源", extraField: "dropped"
  }));
  assert.deepEqual(query.params, { displayName: "乔炳源" },
    "resolve params are reduced to the display name exactly");
});

test("T10 the v2 status input has an explicit schema, not a forged v1 event", () => {
  const valid = parseV2StatusInput({
    storageVersion: 2, operation: "event.status", params: { targetRequestId: "req-1" }
  });
  assert.deepEqual(valid, { storageVersion: 2, operation: "event.status", params: { targetRequestId: "req-1" } });

  const byEvent = parseV2StatusInput({
    storageVersion: 2, operation: "event.status", params: { targetEventId: "e-1" }
  });
  assert.equal(byEvent.params.targetEventId, "e-1");

  for (const bad of [
    null,
    { storageVersion: 1, operation: "event.status", params: {} },
    { storageVersion: 2, operation: "event.status", params: {} },
    { storageVersion: 2, operation: "event.status", params: { targetRequestId: "r", targetEventId: "e" } },
    { storageVersion: 2, operation: "event.status", params: { targetRequestId: "r", extra: 1 } },
    { storageVersion: 2, operation: "system.capabilities.read", params: {} }
  ]) {
    assert.throws(() => parseV2StatusInput(bad), undefined,
      "an ambiguous or non-status input is refused");
  }
});

test("T10 write events are not routable through the v2 read mapping", () => {
  assert.throws(() => toV2Query(read("algorithm.learning.completed")),
    /not_a_v2_read/, "a write event must go through the outbox, never the query mapping");
  assert.throws(() => toV2Query(null), /not_a_v2_read/);
});
