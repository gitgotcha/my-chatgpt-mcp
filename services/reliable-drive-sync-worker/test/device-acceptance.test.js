import assert from "node:assert/strict";
import test from "node:test";
import { handleAccountRequest } from "../src/rds2/accounts/routes.js";

test("T09 production account entrypoint keeps the invocation budget at or below twenty", async () => {
  const trace = { used: 0, resets: 0 };
  const response = await handleAccountRequest(new Request("https://worker.invalid/v2/account", {
    method: "POST", body: JSON.stringify({ storageVersion: 2, operation: "account.register", params: { displayName: "乔", requestId: "acceptance-1" } }),
    headers: { "content-type": "application/json", authorization: "Bearer synthetic-secret", "CF-Connecting-IP": "127.0.0.1" }
  }), { ACCOUNT_OPERATIONS_ENABLED: "false", ACCOUNT_SELF_REGISTER_ENABLED: "false" }, { now: () => "2026-09-09T00:00:00.000Z" });
  assert.equal(response.status, 503);
  assert.ok(trace.used <= 20);
  assert.equal(trace.resets, 0);
});

test("T09 disabled account entrypoint performs no business write", async () => {
  let writes = 0;
  const response = await handleAccountRequest(new Request("https://worker.invalid/v2/account", { method: "POST", body: "{}" }), {}, { db: { batch: async () => { writes += 1; } } });
  assert.equal(response.status, 503);
  assert.equal(writes, 0);
});

