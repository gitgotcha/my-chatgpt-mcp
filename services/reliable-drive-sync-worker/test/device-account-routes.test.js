import assert from "node:assert/strict";
import test from "node:test";
import { hashText } from "../src/rds2/identity/hashing.js";
import { handleAccountRequest } from "../src/rds2/accounts/routes.js";
import { withDeviceAccountsD1 } from "./support/rds2-d1.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const BASE_ENV = {
  ACCOUNT_OPERATIONS_ENABLED: "true",
  ACCOUNT_SELF_REGISTER_ENABLED: "true",
  ACCOUNT_RATE_LIMIT_SALT: "test-rate-salt"
};
const ip = "203.0.113.10";

function request(operation, params, { authorization, bodyExtra = {}, ipAddress = ip, url = "https://worker.example/v2/account" } = {}) {
  const headers = { "content-type": "application/json", "CF-Connecting-IP": ipAddress };
  if (authorization) headers.authorization = `Bearer ${authorization}`;
  return new Request(url, { method: "POST", headers, body: JSON.stringify({ storageVersion: 2, operation, params, ...bodyExtra }) });
}

test("T04 account endpoint is fail-closed when disabled and streams the 4KiB body limit", async () => {
  const disabled = await handleAccountRequest(request("account.register", { displayName: "乔", requestId: "r1" }), {
    ...BASE_ENV, ACCOUNT_OPERATIONS_ENABLED: "false"
  }, { db: null });
  assert.equal(disabled.status, 503);

  const tooLarge = await handleAccountRequest(new Request("https://worker.example/v2/account", {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify({ storageVersion: 2, operation: "account.register", params: { displayName: "乔", requestId: "r1" }, padding: "x".repeat(5000) })
  }), BASE_ENV, { db: null });
  assert.equal(tooLarge.status, 413);
});

test("T04 registration uses Authorization as the secret and enforces a fixed-window limit", async () => {
  await withDeviceAccountsD1(async (_binding, db) => {
    const env = { ...BASE_ENV };
    const results = [];
    for (let index = 0; index < 6; index += 1) {
      results.push(await handleAccountRequest(
        request("account.register", { displayName: `用户${index}`, requestId: `r-${index}` }, { authorization: `secret-${index}` }),
        env,
        { db, now: () => "2026-09-09T01:00:00.000Z" }
      ));
    }
    assert.deepEqual(results.slice(0, 5).map((response) => response.status), [201, 201, 201, 201, 201]);
    assert.equal(results[5].status, 429);
    const body = await results[0].json();
    assert.equal(typeof body.userId, "string");
    assert.equal(Object.hasOwn(body, "secret"), false);
  });
});

test("T04 authenticated pairing create and redeem stay within one 20-call budget", async () => {
  await withDeviceAccountsD1(async (_binding, db) => {
    const sourceSecret = "source-secret";
    const sourceHash = await hashText(sourceSecret);
    await db.prepare("INSERT INTO rds2_users(user_id,name_key,display_name,status,created_at) VALUES(?,?,?,?,?)")
      .bind(USER_ID, "source", "来源", "active", "2026-09-09T00:00:00.000Z").run();
    await db.prepare("INSERT INTO rds2_credentials(credential_hash,user_id,status,created_at) VALUES(?,?,?,?)")
      .bind(sourceHash, USER_ID, "active", "2026-09-09T00:00:00.000Z").run();
    const created = await handleAccountRequest(
      request("account.transfer.create", { code: "runtime-private-code" }, { authorization: sourceSecret }),
      BASE_ENV,
      { db, now: () => "2026-09-09T01:00:00.000Z" }
    );
    assert.equal(created.status, 201);
    const redeemed = await handleAccountRequest(
      request("account.transfer.redeem", { requestId: "redeem-route", code: "runtime-private-code" }, { authorization: "target-secret", ipAddress: "203.0.113.11" }),
      BASE_ENV,
      { db, now: () => "2026-09-09T01:01:00.000Z" }
    );
    assert.equal(redeemed.status, 201);
    const output = await redeemed.json();
    assert.equal(output.userId, USER_ID);
    assert.equal(Object.hasOwn(output, "code"), false);
  });
});
