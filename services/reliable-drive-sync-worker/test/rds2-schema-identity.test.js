import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withD1, applySchema } from "./support/rds2-d1.js";
import { authenticate } from "../src/rds2/identity/auth.js";
import { initializeUser } from "../src/rds2/identity/initialize.js";
import { hashText } from "../src/rds2/identity/hashing.js";

const MIGRATION_PATH = new URL("../migrations/0006_rds2_v2_tables.sql", import.meta.url);
const MIGRATION_SQL = readFileSync(fileURLToPath(MIGRATION_PATH), "utf8");
const NOW = "2026-09-05T00:00:00.000Z";
const ADMIN_HASH = await hashText("admin-secret");
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const NAME = "乔炳源";

function credentialHash(seed) {
  // Deterministic 64-hex stand-in for the server-side SHA-256 of a credential.
  let out = "";
  for (let index = 0; index < 64; index += 1) {
    out += ((seed.charCodeAt(index % seed.length) + index * 7) % 16).toString(16);
  }
  return out;
}

test("migration trigger CASE guards are parenthesized for remote D1 parsing", () => {
  assert.doesNotMatch(MIGRATION_SQL, /SELECT CASE WHEN/);
  assert.match(MIGRATION_SQL, /SELECT \(CASE WHEN/);
});

async function seedUser(db, { userId, name, hash }) {
  await db.batch([
    db.prepare(
      "INSERT INTO rds2_users (user_id, name_key, display_name, status, created_at) VALUES (?, ?, ?, 'active', ?)"
    ).bind(userId, name, name, NOW),
    db.prepare(
      "INSERT INTO rds2_credentials (credential_hash, user_id, status, created_at) VALUES (?, ?, 'active', ?)"
    ).bind(hash, userId, NOW)
  ]);
}

async function seedProcessingTask(db, overrides = {}) {
  const task = {
    taskId: "task-guard-1",
    type: "projection",
    userId: USER_A,
    namespace: "algorithm",
    projectionName: "learning",
    eventSeq: 1,
    state: "processing",
    owner: "worker-1",
    epoch: 3,
    leaseUntil: "2026-09-05T00:05:00.000Z",
    ...overrides
  };
  await db.batch([
    db.prepare(
      "INSERT INTO rds2_projections (user_id, namespace, projection_name, revision, last_event_seq, active_generation, building, summary_json, updated_at) VALUES (?, ?, ?, 0, 0, 0, 0, NULL, ?)"
    ).bind(task.userId, task.namespace, task.projectionName, NOW),
    db.prepare(
      `INSERT INTO rds2_tasks (task_id, type, user_id, namespace, projection_name, event_seq, state,
        available_at, lease_owner, lease_until, lease_epoch, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(task.taskId, task.type, task.userId, task.namespace, task.projectionName,
      task.eventSeq, task.state, NOW, task.owner, task.leaseUntil, task.epoch, NOW, NOW)
  ]);
  return task;
}

test("migration 0006 creates all ten V2 tables on both bindings and leaves V1 untouched", async () => {
  await withD1(async (binding, db) => {
    await applySchema(db, MIGRATION_SQL);
    const tables = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'rds2_%' ORDER BY name"
    ).all();
    const names = tables.results.map((row) => row.name);
    assert.deepEqual(names, [
      "rds2_archive_deliveries",
      "rds2_commit_guards",
      "rds2_credentials",
      "rds2_events",
      "rds2_projection_builds",
      "rds2_projection_rows",
      "rds2_projections",
      "rds2_requests",
      "rds2_tasks",
      "rds2_users"
    ]);
    const v1Tables = await db.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name LIKE 'v1_%'"
    ).first("n");
    assert.equal(v1Tables, 0);
    assert.equal(binding, binding);
  });
});

test("task type, state and lease columns enforce CHECK constraints", async () => {
  await withD1(async (binding, db) => {
    await applySchema(db, MIGRATION_SQL);
    await assert.rejects(async () => db.prepare(
      `INSERT INTO rds2_tasks (task_id, type, user_id, namespace, projection_name, event_seq, state, available_at, created_at, updated_at)
       VALUES ('t-bad-type', 'cleanup', 'u', 'algorithm', 'learning', 1, 'pending', ?, ?, ?)`
    ).bind(NOW, NOW, NOW).run(), undefined, `${binding}: unknown task type must be rejected`);
    await assert.rejects(async () => db.prepare(
      `INSERT INTO rds2_tasks (task_id, type, user_id, namespace, projection_name, event_seq, state, available_at, created_at, updated_at)
       VALUES ('t-bad-state', 'projection', 'u', 'algorithm', 'learning', 1, 'archived', ?, ?, ?)`
    ).bind(NOW, NOW, NOW).run(), undefined, `${binding}: unknown task state must be rejected`);
    await assert.rejects(async () => db.prepare(
      `INSERT INTO rds2_tasks (task_id, type, user_id, namespace, projection_name, state, available_at, created_at, updated_at)
       VALUES ('t-no-target', 'projection', 'u', 'algorithm', 'learning', 'pending', ?, ?, ?)`
    ).bind(NOW, NOW, NOW).run(), undefined, `${binding}: a task without event or artifact must be rejected`);
  });
});

test("business key uniqueness is per user and partial", async () => {
  await withD1(async (binding, db) => {
    await applySchema(db, MIGRATION_SQL);
    let sequence = 0;
    const insert = (userId, businessKey) => {
      sequence += 1;
      return db.prepare(
        `INSERT INTO rds2_events (user_id, namespace, projection_name, event_id, event_key, business_key, event_type, created_by_request, envelope_json, content_hash, created_at)
         VALUES (?, 'resume-knowledge', 'mastery', ?, ?, ?, 'resume-knowledge.answer-scored', 'seed-req', '{}', ?, ?)`
      ).bind(userId, `e-${sequence}`, `k-${sequence}`, businessKey, `c-${sequence}`, NOW);
    };
    await insert(USER_A, "biz-1").run();
    await assert.rejects(async () => insert(USER_A, "biz-1").run(),
      undefined, `${binding}: same user and business key must be unique`);
    await insert(USER_B, "biz-1").run();
    await insert(USER_A, null).run();
    await insert(USER_A, null).run();
    const count = await db.prepare("SELECT COUNT(*) AS n FROM rds2_events").first("n");
    assert.equal(count, 4);
  });
});

test("oversized JSON units are rejected by CHECK constraints", async () => {
  await withD1(async (binding, db) => {
    await applySchema(db, MIGRATION_SQL);
    // Valid JSON documents whose UTF-8 byte size exceeds the limit by one.
    const bigEnvelope = JSON.stringify("x".repeat(256 * 1024 - 2 + 1));
    await assert.rejects(async () => db.prepare(
      `INSERT INTO rds2_events (user_id, namespace, projection_name, event_id, event_key, event_type, created_by_request, envelope_json, content_hash, created_at)
       VALUES ('u', 'algorithm', 'learning', 'e-big', 'k-big', 'algorithm.learning.completed', 'seed-req', ?, 'c', ?)`
    ).bind(bigEnvelope, NOW).run(), undefined, `${binding}: envelope over 256KiB must be rejected`);
    const bigRow = JSON.stringify("x".repeat(64 * 1024 - 2 + 1));
    await assert.rejects(async () => db.prepare(
      `INSERT INTO rds2_projection_rows (user_id, namespace, projection_name, generation, row_kind, row_key, value_json, updated_at)
       VALUES ('u', 'algorithm', 'learning', 0, 'topic', 't1', ?, ?)`
    ).bind(bigRow, NOW).run(), undefined, `${binding}: row JSON over 64KiB must be rejected`);
  });
});

test("new display name combined with another user's id override fails with zero writes", async () => {
  await withD1(async (binding, db) => {
    await applySchema(db, MIGRATION_SQL);
    await seedUser(db, { userId: USER_B, name: "已有用户", hash: credentialHash("b-cred") });
    await assert.rejects(async () => initializeUser({
      db, adminCredential: "admin-secret", expectedAdminHash: ADMIN_HASH,
      displayName: "全新名字", userIdOverride: USER_B,
      credentialHash: credentialHash("new-cred"), now: NOW
    }), (error) => error.code === "identity_conflict");
    const users = await db.prepare("SELECT COUNT(*) AS n FROM rds2_users").first("n");
    const creds = await db.prepare("SELECT COUNT(*) AS n FROM rds2_credentials").first("n");
    assert.equal(users, 1, `${binding}: no user row may be created on conflict`);
    assert.equal(creds, 1, `${binding}: no credential row may be created on conflict`);
  });
});

test("NFKC-equivalent names resolve to one user but never bypass the admin gate", async () => {
  await withD1(async (binding, db) => {
    await applySchema(db, MIGRATION_SQL);
    await assert.rejects(async () => initializeUser({
      db, adminCredential: "wrong-secret", expectedAdminHash: ADMIN_HASH,
      displayName: NAME, credentialHash: credentialHash("a-cred"), now: NOW
    }), (error) => error.code === "admin_credential_rejected");
    const afterBadAdmin = await db.prepare("SELECT COUNT(*) AS n FROM rds2_users").first("n");
    assert.equal(afterBadAdmin, 0, `${binding}: a rejected admin call must not write anything`);

    const first = await initializeUser({
      db, adminCredential: "admin-secret", expectedAdminHash: ADMIN_HASH,
      displayName: NAME, credentialHash: credentialHash("a-cred"), now: NOW
    });
    const again = await initializeUser({
      db, adminCredential: "admin-secret", expectedAdminHash: ADMIN_HASH,
      displayName: ` ${NAME}\u3000`, credentialHash: credentialHash("a-cred-2"), now: NOW
    });
    assert.equal(again.userId, first.userId, `${binding}: NFKC-equivalent names resolve to the same identity`);
    const users = await db.prepare("SELECT COUNT(*) AS n FROM rds2_users").first("n");
    assert.equal(users, 1);
  });
});

test("credentials bind identity and revoked credentials are rejected", async () => {
  await withD1(async (binding, db) => {
    await applySchema(db, MIGRATION_SQL);
    const credentialA = "a-user-credential";
    const credentialB = "b-user-credential";
    await seedUser(db, { userId: USER_A, name: NAME, hash: await hashText(credentialA) });
    await seedUser(db, { userId: USER_B, name: "其他用户", hash: await hashText(credentialB) });
    await db.batch([
      db.prepare(
        `INSERT INTO rds2_events (user_id, namespace, projection_name, event_id, event_key, event_type, created_by_request, envelope_json, content_hash, created_at)
         VALUES (?, 'algorithm', 'learning', 'e-b1', 'k-b1', 'algorithm.learning.completed', 'seed-req', '{}', 'c', ?)`
      ).bind(USER_B, NOW)
    ]);
    const principalA = await authenticate({ db, credential: credentialA });
    assert.equal(principalA.userId, USER_A);
    assert.equal(principalA.username, NAME);
    const principalB = await authenticate({ db, credential: credentialB });
    assert.equal(principalB.userId, USER_B, `${binding}: each credential resolves to its own bound user`);

    await assert.rejects(async () => authenticate({ db, credential: "nobody-credential" }),
      (error) => error.code === "unknown_credential");
    await db.batch([
      db.prepare("UPDATE rds2_credentials SET status = 'revoked' WHERE credential_hash = ?").bind(await hashText(credentialA))
    ]);
    await assert.rejects(async () => authenticate({ db, credential: credentialA }),
      (error) => error.code === "credential_revoked");
    assert.equal(binding, binding);
  });
});

test("two same-name initializations converge on exactly one identity", async () => {
  await withD1(async (binding, db) => {
    await applySchema(db, MIGRATION_SQL);
    const first = await initializeUser({
      db, adminCredential: "admin-secret", expectedAdminHash: ADMIN_HASH,
      displayName: NAME, credentialHash: credentialHash("a-cred"), now: NOW
    });
    const second = await initializeUser({
      db, adminCredential: "admin-secret", expectedAdminHash: ADMIN_HASH,
      displayName: NAME, credentialHash: credentialHash("a-cred-2"), now: NOW
    });
    assert.equal(second.userId, first.userId);
    const users = await db.prepare("SELECT COUNT(*) AS n FROM rds2_users").first("n");
    assert.equal(users, 1, `${binding}: the UNIQUE name_key must collapse concurrent initializations`);
    const creds = await db.prepare("SELECT COUNT(*) AS n FROM rds2_credentials").first("n");
    assert.equal(creds, 2);
  });
});

test("a commit guard with stale epoch, wrong owner or expired lease aborts the whole batch", async () => {
  await withD1(async (binding, db) => {
    await applySchema(db, MIGRATION_SQL);
    const task = await seedProcessingTask(db);

    const guardInsert = (overrides = {}) => db.prepare(
      `INSERT INTO rds2_commit_guards (guard_id, task_id, owner, expected_epoch, now_utc, expected_revision, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`
    ).bind(
      overrides.guardId ?? "g-1",
      overrides.taskId ?? task.taskId,
      overrides.owner ?? task.owner,
      overrides.epoch ?? task.epoch,
      overrides.now ?? NOW,
      NOW
    );
    const rowWrite = db.prepare(
      `INSERT INTO rds2_projection_rows (user_id, namespace, projection_name, generation, row_kind, row_key, value_json, updated_at)
       VALUES (?, ?, ?, 0, 'topic', 't-1', '{}', ?)`
    ).bind(task.userId, task.namespace, task.projectionName, NOW);

    for (const [label, guard] of [
      ["stale epoch", guardInsert({ epoch: task.epoch - 1 })],
      ["future epoch", guardInsert({ epoch: task.epoch + 1 })],
      ["wrong owner", guardInsert({ owner: "worker-2" })],
      ["expired lease", guardInsert({ now: "2026-09-05T00:06:00.000Z" })]
    ]) {
      await assert.rejects(async () => db.batch([rowWrite, guard]),
        undefined, `${binding}: ${label} must abort the batch`);
      const rows = await db.prepare("SELECT COUNT(*) AS n FROM rds2_projection_rows").first("n");
      assert.equal(rows, 0, `${binding}: ${label} must roll back statements before the guard`);
      const guards = await db.prepare("SELECT COUNT(*) AS n FROM rds2_commit_guards").first("n");
      assert.equal(guards, 0);
    }

    await assert.rejects(async () => db.batch([rowWrite, guardInsert({ state: undefined, taskId: "task-other" })]),
      undefined, `${binding}: a guard for an unknown task must abort`);
    const guardsAfterUnknown = await db.prepare("SELECT COUNT(*) AS n FROM rds2_commit_guards").first("n");
    assert.equal(guardsAfterUnknown, 0);
  });
});

test("a valid commit guard passes and its projection revision is enforced", async () => {
  await withD1(async (binding, db) => {
    await applySchema(db, MIGRATION_SQL);
    const task = await seedProcessingTask(db);
    const guardInsert = (expectedRevision) => db.prepare(
      `INSERT INTO rds2_commit_guards (guard_id, task_id, owner, expected_epoch, now_utc, expected_revision, created_at)
       VALUES ('g-ok', ?, ?, ?, ?, ?, ?)`
    ).bind(task.taskId, task.owner, task.epoch, NOW, expectedRevision, NOW);

    await db.batch([guardInsert(0)]);
    const guards = await db.prepare("SELECT COUNT(*) AS n FROM rds2_commit_guards").first("n");
    assert.equal(guards, 1, `${binding}: a valid guard must be insertable inside a batch`);
    await db.batch([db.prepare("DELETE FROM rds2_commit_guards")]);

    await assert.rejects(async () => db.batch([guardInsert(1)]),
      undefined, `${binding}: expected_revision must equal the projection head revision`);
    await assert.rejects(async () => db.batch([
      db.prepare(
        `INSERT INTO rds2_commit_guards (guard_id, task_id, owner, expected_epoch, now_utc, expected_revision, created_at)
         VALUES ('g-no-rev', ?, ?, ?, ?, NULL, ?)`
      ).bind(task.taskId, task.owner, task.epoch, NOW, NOW)
    ]), undefined, `${binding}: a projection guard without expected_revision must be rejected`);
  });
});

// ---------------------------------------------------------------------------
// R4 regression: an explicit userIdOverride is a binding constraint, never a
// preference. An existing name paired with a different explicit id must
// conflict in both the pre-check path and the post-UNIQUE winner path, with
// zero credential writes.
// ---------------------------------------------------------------------------

test("R4 an existing name combined with an unused explicit id conflicts", async () => {
  await withD1(async (binding, db) => {
    await applySchema(db, MIGRATION_SQL);
    await seedUser(db, { userId: USER_A, name: NAME, hash: await hashText("a-user-credential") });
    await assert.rejects(async () => initializeUser({
      db, adminCredential: "admin-secret", expectedAdminHash: ADMIN_HASH,
      displayName: NAME, userIdOverride: USER_B,
      credentialHash: credentialHash("b-cred-fresh"), now: NOW
    }), (error) => {
      assert.equal(error.code, "identity_conflict", `(${binding}) explicit id vs existing name must conflict`);
      return true;
    }, `(${binding}) the existing user must not be silently returned`);
    const users = await db.prepare("SELECT COUNT(*) AS n FROM rds2_users").first("n");
    const creds = await db.prepare("SELECT COUNT(*) AS n FROM rds2_credentials").first("n");
    assert.equal(users, 1, `(${binding}) zero user writes`);
    assert.equal(creds, 1, `(${binding}) zero credential writes`);
  });
});

test("R4 a race winner bound to a different explicit id conflicts with zero credential writes", async () => {
  await withD1(async (binding, db) => {
    await applySchema(db, MIGRATION_SQL);
    // Simulate the concurrent winner: between our pre-check and our INSERT,
    // another administrator registers the same name under USER_A.
    const racingDb = {
      prepare: (sql) => db.prepare(sql),
      batch: async (records) => {
        if (records.length === 2) {
          await db.prepare(
            "INSERT INTO rds2_users (user_id, name_key, display_name, status, created_at) VALUES (?, ?, ?, 'active', ?)"
          ).bind(USER_A, NAME, NAME, NOW).run();
        }
        return db.batch(records);
      }
    };
    await assert.rejects(async () => initializeUser({
      db: racingDb, adminCredential: "admin-secret", expectedAdminHash: ADMIN_HASH,
      displayName: NAME, userIdOverride: USER_B,
      credentialHash: credentialHash("b-cred-fresh"), now: NOW
    }), (error) => {
      assert.equal(error.code, "identity_conflict", `(${binding}) the race winner's id must be checked against the override`);
      return true;
    }, `(${binding}) a winner with a different id must not be adopted`);
    const users = await db.prepare("SELECT COUNT(*) AS n FROM rds2_users").first("n");
    const creds = await db.prepare("SELECT COUNT(*) AS n FROM rds2_credentials").first("n");
    assert.equal(users, 1, `(${binding}) only the winner's user row exists`);
    assert.equal(creds, 0, `(${binding}) no credential may be issued after an identity conflict`);
  });
});

// ---------------------------------------------------------------------------
// R7 regression: the KiB limits in CHECK constraints count UTF-8 bytes, not
// characters, and JSON columns must hold valid JSON.
// ---------------------------------------------------------------------------

function jsonDocOfByteLength(totalBytes, unit) {
  // A JSON document (a quoted string) whose UTF-8 byte length is exactly
  // totalBytes: body of unit characters plus an ASCII remainder, +2 quotes.
  const bytesPerUnit = { ascii: 1, cjk: 3, emoji: 4 }[unit];
  const unitChar = { ascii: "a", cjk: "乔", emoji: "😀" }[unit];
  const bodyBytes = totalBytes - 2;
  if (bodyBytes < 0) throw new Error("fixture too small");
  const body = unitChar.repeat(Math.floor(bodyBytes / bytesPerUnit))
    + "a".repeat(bodyBytes % bytesPerUnit);
  return JSON.stringify(body);
}

test("R7 JSON limits are byte-based for ASCII, CJK and emoji at the 64 KiB boundary", async () => {
  await withD1(async (binding, db) => {
    await applySchema(db, MIGRATION_SQL);
    const insertRow = (doc) => db.prepare(
      `INSERT INTO rds2_projection_rows (user_id, namespace, projection_name, generation, row_kind, row_key, value_json, updated_at)
       VALUES ('u', 'algorithm', 'learning', 0, 'topic', ?, ?, ?)`
    ).bind(`row-${Math.random().toString(36).slice(2)}`, doc, NOW);
    for (const unit of ["ascii", "cjk", "emoji"]) {
      const atLimit = jsonDocOfByteLength(64 * 1024, unit);
      const overLimit = jsonDocOfByteLength(64 * 1024 + 1, unit);
      await insertRow(atLimit).run();
      await assert.rejects(async () => insertRow(overLimit).run(),
        undefined, `(${binding}) ${unit} JSON over 64 KiB by UTF-8 bytes must be rejected`);
    }
    const count = await db.prepare("SELECT COUNT(*) AS n FROM rds2_projection_rows").first("n");
    assert.equal(count, 3, `(${binding}) exactly the three boundary-fit rows persist`);
  });
});

test("R7 an oversized JSON write inside a batch rolls the whole batch back", async () => {
  await withD1(async (binding, db) => {
    await applySchema(db, MIGRATION_SQL);
    const good = db.prepare(
      `INSERT INTO rds2_projection_rows (user_id, namespace, projection_name, generation, row_kind, row_key, value_json, updated_at)
       VALUES ('u', 'algorithm', 'learning', 0, 'topic', 'ok-row', '{}', ?)`
    ).bind(NOW);
    const bad = db.prepare(
      `INSERT INTO rds2_projection_rows (user_id, namespace, projection_name, generation, row_kind, row_key, value_json, updated_at)
       VALUES ('u', 'algorithm', 'learning', 0, 'topic', 'bad-row', ?, ?)`
    ).bind(JSON.stringify("乔".repeat(22000)), NOW);
    await assert.rejects(async () => db.batch([good, bad]),
      undefined, `(${binding}) the oversized unit must abort the batch`);
    const count = await db.prepare("SELECT COUNT(*) AS n FROM rds2_projection_rows").first("n");
    assert.equal(count, 0, `(${binding}) the whole batch must roll back`);
  });
});

test("R7 JSON columns reject non-JSON text", async () => {
  await withD1(async (binding, db) => {
    await applySchema(db, MIGRATION_SQL);
    await assert.rejects(async () => db.prepare(
      `INSERT INTO rds2_projection_rows (user_id, namespace, projection_name, generation, row_kind, row_key, value_json, updated_at)
       VALUES ('u', 'algorithm', 'learning', 0, 'topic', 't1', 'not json', ?)`
    ).bind(NOW).run(), undefined, `(${binding}) value_json must be valid JSON`);
    await assert.rejects(async () => db.prepare(
      `INSERT INTO rds2_requests (user_id, request_id, envelope_hash, canonical_event_id, receipt_json, created_at)
       VALUES ('u', 'r1', 'h', 'e', 'also not json', ?)`
    ).bind(NOW).run(), undefined, `(${binding}) receipt_json must be valid JSON`);
  });
});
