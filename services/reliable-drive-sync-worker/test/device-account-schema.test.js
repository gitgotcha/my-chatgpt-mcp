import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { applySchema, withD1, withDeviceAccountsD1 } from "./support/rds2-d1.js";

const MIGRATION_0006 = readFileSync(fileURLToPath(new URL("../migrations/0006_rds2_v2_tables.sql", import.meta.url)), "utf8");
const MIGRATION_0008 = readFileSync(fileURLToPath(new URL("../migrations/0008_rds2_device_accounts.sql", import.meta.url)), "utf8");
const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

test("T02 removes the old name uniqueness while preserving users and credentials", async () => {
  await withDeviceAccountsD1(async (_binding, db) => {
    const users = await db.prepare("SELECT user_id, name_key, display_name, status, created_at FROM rds2_users ORDER BY user_id").all();
    assert.deepEqual(users.results, []);
    await db.prepare("INSERT INTO rds2_users(user_id,name_key,display_name,status,created_at) VALUES(?,?,?,?,?)")
      .bind(UUID_A, "same-name", "同名", "active", "2026-09-09T00:00:00.000Z").run();
    await db.prepare("INSERT INTO rds2_users(user_id,name_key,display_name,status,created_at) VALUES(?,?,?,?,?)")
      .bind(UUID_B, "same-name", "同名", "active", "2026-09-09T00:00:01.000Z").run();
    await db.prepare("INSERT INTO rds2_credentials(credential_hash,user_id,status,created_at) VALUES(?,?,?,?)")
      .bind(HASH_A, UUID_A, "active", "2026-09-09T00:00:00.000Z").run();
    await db.prepare("INSERT INTO rds2_credentials(credential_hash,user_id,status,created_at) VALUES(?,?,?,?)")
      .bind(HASH_B, UUID_B, "active", "2026-09-09T00:00:01.000Z").run();
    const count = await db.prepare("SELECT COUNT(*) AS count FROM rds2_users WHERE name_key = ?").bind("same-name").first();
    assert.equal(Number(count.count), 2);
    assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  });
});

test("T02 creates registration, pairing and account-limit tables with the frozen guard", async () => {
  await withDeviceAccountsD1(async (_binding, db) => {
    const names = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'rds2_%' ORDER BY name").all()).results.map((row) => row.name);
    for (const name of ["rds2_registration_intents", "rds2_pairing_tickets", "rds2_pairing_redemptions", "rds2_account_limits"]) {
      assert.ok(names.includes(name), name);
    }
    await assert.rejects(
      db.prepare("INSERT INTO rds2_pairing_redemptions(request_id,code_hash,proof_hash,user_id,created_at,recover_until) VALUES(?,?,?,?,?,?)")
        .bind("request-1", "code-1", "proof-1", UUID_A, "2026-09-09T00:00:00.000Z", "2026-09-10T00:00:00.000Z").run(),
      /pairing_invalid|SQLITE_CONSTRAINT|D1_ERROR/
    );
  });
});

test("T02 migration starts from the existing 0006 schema rather than a second database", async () => {
  // This is a fixture guard: the device-account helper must apply 0006 before
  // 0008, so all existing V2 tables remain available to later tasks.
  await withDeviceAccountsD1(async (_binding, db) => {
    const existing = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rds2_events'").first();
    assert.equal(existing.name, "rds2_events");
  });
  assert.match(MIGRATION_0006, /CREATE TABLE rds2_users/);
});

test("T02 copies existing users and credentials byte-for-byte before adding management tables", async () => {
  await withD1(async (_binding, db) => {
    await applySchema(db, MIGRATION_0006);
    await db.prepare("INSERT INTO rds2_users(user_id,name_key,display_name,status,created_at) VALUES(?,?,?,?,?)")
      .bind(UUID_A, "legacy-name", "旧用户", "active", "2026-09-09T00:00:00.000Z").run();
    await db.prepare("INSERT INTO rds2_credentials(credential_hash,user_id,status,created_at) VALUES(?,?,?,?)")
      .bind(HASH_A, UUID_A, "revoked", "2026-09-09T00:00:01.000Z").run();
    const beforeUser = await db.prepare("SELECT * FROM rds2_users").first();
    const beforeCredential = await db.prepare("SELECT * FROM rds2_credentials").first();
    await applySchema(db, MIGRATION_0008);
    assert.deepEqual(await db.prepare("SELECT * FROM rds2_users").first(), beforeUser);
    assert.deepEqual(await db.prepare("SELECT * FROM rds2_credentials").first(), beforeCredential);
    assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  });
});
