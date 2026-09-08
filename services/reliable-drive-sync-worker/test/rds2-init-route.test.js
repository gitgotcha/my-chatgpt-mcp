import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { handleV2Init } from "../src/rds2/routes.js";
import { applySchema, withD1 } from "./support/rds2-d1.js";

const MIGRATION_SQL = readFileSync(fileURLToPath(
  new URL("../migrations/0006_rds2_v2_tables.sql", import.meta.url)
), "utf8");
const NOW = "2026-09-08T09:00:00.000Z";
const ADMIN = "synthetic-admin-token";
const ENV = { RDS2_INIT_ENABLED: "true", RDS2_ADMIN_TOKEN: ADMIN };

function request(body, { token = ADMIN } = {}) {
  return new Request("https://worker.example/v2/users/init", {
    method: "POST",
    headers: {
      authorization: token === null ? "" : `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

async function withInit(callback) {
  await withD1(async (_binding, rawDb) => {
    await applySchema(rawDb, MIGRATION_SQL);
    await callback(rawDb);
  });
}

test("init is fail-closed while the feature switch is disabled", async () => {
  await withInit(async (db) => {
    const response = await handleV2Init(request({ displayName: "合成用户" }),
      { ...ENV, RDS2_INIT_ENABLED: "false" }, null, { db, now: () => NOW });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: { code: "v2_init_disabled" } });
  });
});

test("init rejects an invalid administrator token without writing", async () => {
  await withInit(async (db) => {
    const response = await handleV2Init(request({ displayName: "合成用户" }, { token: "wrong" }),
      ENV, null, { db, now: () => NOW });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: { code: "admin_credential_rejected" } });
    const count = await db.prepare("SELECT COUNT(*) AS n FROM rds2_users").first();
    assert.equal(Number(count.n), 0);
  });
});

test("init creates one synthetic identity and returns its credential once", async () => {
  await withInit(async (db) => {
    const response = await handleV2Init(request({ displayName: "合成用户", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      ENV, null, { db, now: () => NOW, randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.storageVersion, 2);
    assert.equal(body.displayName, "合成用户");
    assert.equal(body.userId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    assert.equal(typeof body.credential, "string");
    assert.ok(body.credential.length > 20);
    const user = await db.prepare("SELECT user_id, display_name, status FROM rds2_users").first();
    assert.deepEqual(user, {
      user_id: body.userId,
      display_name: "合成用户",
      status: "active"
    });
    const credentials = await db.prepare("SELECT COUNT(*) AS n FROM rds2_credentials WHERE user_id = ?")
      .bind(body.userId).first();
    assert.equal(Number(credentials.n), 1);
  });
});

test("init rejects unknown fields and invalid display names", async () => {
  await withInit(async (db) => {
    const extra = await handleV2Init(request({ displayName: "合成用户", unexpected: true }),
      ENV, null, { db, now: () => NOW });
    assert.equal(extra.status, 400);
    assert.deepEqual(await extra.json(), { error: { code: "invalid_params" } });

    const empty = await handleV2Init(request({ displayName: "  " }),
      ENV, null, { db, now: () => NOW });
    assert.equal(empty.status, 400);
    assert.deepEqual(await empty.json(), { error: { code: "invalid_display_name" } });
  });
});
