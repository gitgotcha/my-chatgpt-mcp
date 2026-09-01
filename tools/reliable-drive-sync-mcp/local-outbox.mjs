import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function normalizeUsername(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("invalid_username");
  return value.normalize("NFKC").trim();
}

export class LocalOutbox {
  #db;
  #closed = false;

  constructor(filename, now = () => new Date().toISOString()) {
    this.now = now;
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
    this.#db = new DatabaseSync(filename);
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#migrateOutboxSchema();
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS local_outbox_events (
        request_id TEXT PRIMARY KEY,
        input_hash TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'blocked')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS identity_cache (
        username_key TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        user_id TEXT NOT NULL UNIQUE,
        updated_at TEXT NOT NULL
      );
    `);
    this.recoverSending();
  }

  #createOutboxTable(name = "local_outbox_events") {
    this.#db.exec(`
      CREATE TABLE ${name} (
        request_id TEXT PRIMARY KEY,
        input_hash TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'blocked')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  #migrateOutboxSchema() {
    const table = this.#db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'local_outbox_events'").get();
    if (!table) return;
    const columns = this.#db.prepare("PRAGMA table_info(local_outbox_events)").all().map((row) => row.name);
    const supportsCurrentShape = columns.includes("request_id") && columns.includes("input_hash")
      && String(table.sql).includes("'blocked'");
    if (supportsCurrentShape) return;

    this.#db.exec("ALTER TABLE local_outbox_events RENAME TO local_outbox_events_legacy");
    this.#createOutboxTable();
    const legacyColumns = this.#db.prepare("PRAGMA table_info(local_outbox_events_legacy)").all().map((row) => row.name);
    if (legacyColumns.includes("request_id") && legacyColumns.includes("input_hash")) {
      this.#db.exec(`
        INSERT INTO local_outbox_events (
          request_id, input_hash, envelope_json, state, attempt_count,
          last_attempt_at, last_error_code, created_at, updated_at
        ) SELECT request_id, input_hash, envelope_json,
          CASE WHEN state IN ('pending', 'sending', 'blocked') THEN state ELSE 'pending' END,
          attempt_count, last_attempt_at, last_error_code, created_at, updated_at
        FROM local_outbox_events_legacy
      `);
    } else if (legacyColumns.includes("event_key") && legacyColumns.includes("event_json")) {
      const legacyRows = this.#db.prepare("SELECT * FROM local_outbox_events_legacy").all();
      const insert = this.#db.prepare(`
        INSERT INTO local_outbox_events (
          request_id, input_hash, envelope_json, state, attempt_count,
          last_attempt_at, last_error_code, created_at, updated_at
        ) VALUES (?, ?, ?, 'blocked', ?, ?, ?, ?, ?)
      `);
      for (const row of legacyRows) {
        const envelopeJson = row.event_json;
        let inputHash;
        try { inputHash = createHash("sha256").update(canonical(JSON.parse(envelopeJson))).digest("hex"); }
        catch { inputHash = createHash("sha256").update(String(envelopeJson)).digest("hex"); }
        insert.run(
          row.event_key,
          inputHash,
          envelopeJson,
          Number(row.attempt_count ?? 0),
          row.last_attempt_at ?? null,
          "legacy_outbox_requires_resubmit",
          row.created_at ?? this.now(),
          row.updated_at ?? this.now()
        );
      }
    }
    this.#db.exec("DROP TABLE local_outbox_events_legacy");
  }

  enqueue(envelope) {
    if (!envelope || typeof envelope !== "object" || typeof envelope.requestId !== "string" || !envelope.requestId.trim()) {
      throw new Error("invalid_request_id");
    }
    const timestamp = this.now();
    const inputHash = hash(envelope);
    const existing = this.#db.prepare("SELECT input_hash FROM local_outbox_events WHERE request_id = ?").get(envelope.requestId);
    if (existing) {
      if (existing.input_hash !== inputHash) throw new Error("request_id_conflict");
      return false;
    }
    this.#db.prepare(`
      INSERT INTO local_outbox_events (
        request_id, input_hash, envelope_json, state, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', ?, ?)
    `).run(envelope.requestId, inputHash, JSON.stringify(envelope), timestamp, timestamp);
    return true;
  }

  bindEnvelope(requestId, envelope) {
    this.#db.prepare(`
      UPDATE local_outbox_events SET envelope_json = ?, updated_at = ? WHERE request_id = ?
    `).run(JSON.stringify(envelope), this.now(), requestId);
  }

  recoverSending() {
    this.#db.prepare("UPDATE local_outbox_events SET state = 'pending', updated_at = ? WHERE state = 'sending'")
      .run(this.now());
  }

  listPending() {
    return this.#db.prepare(`
      SELECT * FROM local_outbox_events WHERE state = 'pending' ORDER BY created_at, request_id
    `).all().map((row) => ({
      requestId: row.request_id,
      envelope: JSON.parse(row.envelope_json),
      state: row.state,
      attemptCount: row.attempt_count,
      lastAttemptAt: row.last_attempt_at,
      lastErrorCode: row.last_error_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  markSending(requestId) {
    this.#db.prepare(`
      UPDATE local_outbox_events
      SET state = 'sending', attempt_count = attempt_count + 1, last_attempt_at = ?, updated_at = ?
      WHERE request_id = ? AND state = 'pending'
    `).run(this.now(), this.now(), requestId);
  }

  markPending(requestId, errorCode) {
    this.#db.prepare(`
      UPDATE local_outbox_events SET state = 'pending', last_error_code = ?, updated_at = ? WHERE request_id = ?
    `).run(errorCode, this.now(), requestId);
  }

  markBlocked(requestId, errorCode) {
    this.#db.prepare(`
      UPDATE local_outbox_events SET state = 'blocked', last_error_code = ?, updated_at = ? WHERE request_id = ?
    `).run(errorCode, this.now(), requestId);
  }

  acknowledge(requestId, jobId) {
    if (typeof jobId !== "string" || !jobId.trim()) return false;
    return this.#db.prepare("DELETE FROM local_outbox_events WHERE request_id = ? AND state = 'sending'")
      .run(requestId).changes === 1;
  }

  findIdentity(username) {
    // Worker identity matching is exact after NFKC normalization; do not
    // fold case locally and accidentally reuse another user's identity.
    const key = normalizeUsername(username);
    const row = this.#db.prepare("SELECT username, user_id FROM identity_cache WHERE username_key = ?").get(key);
    return row ? { username: row.username, userId: row.user_id } : null;
  }

  rememberIdentity(username, userId) {
    const normalized = normalizeUsername(username);
    if (typeof userId !== "string" || !userId.trim()) throw new Error("invalid_user_id");
    const key = normalized;
    const existingByName = this.#db.prepare("SELECT user_id FROM identity_cache WHERE username_key = ?").get(key);
    if (existingByName && existingByName.user_id !== userId) throw new Error("identity_conflict");
    const existingById = this.#db.prepare("SELECT username_key FROM identity_cache WHERE user_id = ?").get(userId);
    if (existingById && existingById.username_key !== key) throw new Error("identity_conflict");
    this.#db.prepare(`
      INSERT INTO identity_cache (username_key, username, user_id, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(username_key) DO UPDATE SET username = excluded.username, updated_at = excluded.updated_at
    `).run(key, normalized, userId, this.now());
    return { username: normalized, userId };
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}
