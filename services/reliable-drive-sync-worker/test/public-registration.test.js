import assert from "node:assert/strict";
import test from "node:test";
import { handleAccountRequest } from "../src/rds2/accounts/routes.js";
import { handleV2Write } from "../src/rds2/routes.js";
import { withDeviceAccountsD1 } from "./support/rds2-d1.js";

const DISPLAY_NAME = "自助注册用户";
const SECRET = "self-registration-secret";
const NOW = "2026-09-09T12:00:00.000Z";
const IP = "198.51.100.33";

const ACCOUNT_ENV = {
  ACCOUNT_OPERATIONS_ENABLED: "true",
  ACCOUNT_SELF_REGISTER_ENABLED: "true",
  ACCOUNT_RATE_LIMIT_SALT: "test-salt"
};

const WRITE_ENV = {
  RDS2_WRITE_ENABLED: "true",
  RDS2_ENABLED_DOMAINS: "algorithm",
  RDS2_DYNAMIC_USER_AUTH_ENABLED: "true"
};

function accountRequest(requestId) {
  return new Request("https://worker.example/v2/account", {
    method: "POST",
    headers: {
      authorization: `Bearer ${SECRET}`,
      "content-type": "application/json",
      "CF-Connecting-IP": IP
    },
    body: JSON.stringify({
      storageVersion: 2,
      operation: "account.register",
      params: { displayName: DISPLAY_NAME, requestId }
    })
  });
}

function eventEnvelope(userId, requestId, eventId) {
  return {
    schemaVersion: "1.2",
    namespace: "algorithm",
    eventType: "algorithm.learning.completed",
    identity: { userId, username: DISPLAY_NAME },
    payload: {
      event: {
        schemaVersion: "1.2",
        eventId,
        eventKey: `${userId}:algorithm-learning:two-sum:${eventId}`,
        eventType: "algorithm.learning.completed",
        userId,
        username: DISPLAY_NAME,
        observedAt: NOW,
        source: "self-registration-test",
        topic: "two-sum",
        problem: { title: "Two Sum", source: "Hot100", url: "" },
        outcome: "consulted",
        evidence: "自助注册用户完成一次算法练习。",
        tags: ["hash-map"],
        confidence: "medium"
      }
    },
    requestId
  };
}

function writeRequest(envelope) {
  return new Request("https://worker.example/v2/events", {
    method: "POST",
    headers: {
      authorization: `Bearer ${SECRET}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(envelope)
  });
}

test("a newly self-registered active user can submit V2 events without a static allowlist", async () => {
  await withDeviceAccountsD1(async (_binding, db) => {
    const registered = await handleAccountRequest(accountRequest("self-register-1"), ACCOUNT_ENV, {
      db,
      now: () => NOW,
      randomUUID: () => "33333333-3333-4333-8333-333333333333"
    });
    assert.equal(registered.status, 201);
    const registration = await registered.json();
    assert.match(registration.userId, /^[0-9a-f-]{36}$/i);

    const response = await handleV2Write(
      writeRequest(eventEnvelope(registration.userId, "self-event-1", "44444444-4444-4444-8444-444444444444")),
      { ...WRITE_ENV, RDS2_ALLOWED_USER_IDS: "" },
      null,
      { db, now: () => NOW }
    );
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).userId, registration.userId);
  });
});

test("disabling dynamic user authorization preserves the static allowlist gate", async () => {
  await withDeviceAccountsD1(async (_binding, db) => {
    const registered = await handleAccountRequest(accountRequest("self-register-2"), ACCOUNT_ENV, {
      db,
      now: () => NOW,
      randomUUID: () => "33333333-3333-4333-8333-333333333333"
    });
    assert.equal(registered.status, 201);
    const registration = await registered.json();

    const response = await handleV2Write(
      writeRequest(eventEnvelope(registration.userId, "self-event-2", "55555555-5555-4555-8555-555555555555")),
      { ...WRITE_ENV, RDS2_DYNAMIC_USER_AUTH_ENABLED: "false", RDS2_ALLOWED_USER_IDS: "" },
      null,
      { db, now: () => NOW }
    );
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "user_disabled");
  });
});
