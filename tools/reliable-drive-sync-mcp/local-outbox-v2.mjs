// T09: the local durable outbox behind the reliable receipt.
//
// Frozen contract (design addendum §10):
//   pending -> sending -> acknowledged | blocked, always through an explicit
//   SQLite transaction. A sending row carries an owner and a lease; only
//   EXPIRED leases are recovered, so a process that is still working is never
//   robbed. A receipt is acknowledged only after it matches the attempted
//   request id, the identity and the event association; acknowledged rows are
//   retained for 30 days and purging never takes pending or blocked rows with
//   them. Pure reads must not create the database file.
//
// node:sqlite has no `transaction` helper on either supported runtime, so
// every multi-statement change below opens its own BEGIN IMMEDIATE block.
// Network calls live in the delivery service, never inside these blocks.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "../../shared/rds2-protocol.mjs";

export const LEASE_MS = 30_000;
export const ACK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_PURGE_ROWS = 100;
export const MAX_FLUSH_ROWS = 20;
// First retry waits 30s; the schedule then doubles, capped at the last entry.
const BACKOFF_MS = Object.freeze([30_000, 60_000, 120_000, 240_000, 480_000]);
// A conflict whose answer cannot change with time: park it for a human
// instead of burning the backoff schedule.
const PERMANENT_CODES = new Set([
  "request_id_conflict",
  "event_id_conflict",
  "event_key_conflict",
  "identity_mismatch",
  "identity_conflict",
  "identity_not_found",
  "invalid_domain",
  "invalid_profile_event",
  "unsupported_capability",
  "invalid_display_name",
  "invalid_user_id",
  "invalid_envelope"
]);

function fail(code, detail) {
  const error = new Error(code);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

function transaction(db, action) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function envelopeHash(envelope) {
  return createHash("sha256").update(canonicalJson(envelope)).digest("hex");
}

// The identity and the event travel with the frozen envelope, in exactly the
// fields the worker reads when it accepts a submission — the outbox never
// invents either. Confirm compares against these, so a receipt for the right
// request but another user or another event cannot acknowledge the row.
function envelopeUserId(envelope) {
  const value = envelope?.identity?.userId ?? envelope?.payload?.userId ?? envelope?.payload?.event?.userId;
  return typeof value === "string" && value.trim() ? value : null;
}

function envelopeEventId(envelope) {
  const value = envelope?.payload?.event?.eventId;
  return typeof value === "string" && value.trim() ? value : null;
}

function backoffFor(attempts) {
  const index = Math.min(Math.max(Number(attempts) || 0, 0), BACKOFF_MS.length - 1);
  return BACKOFF_MS[index];
}

function rowOf(record) {
  if (!record) return null;
  return {
    requestId: record.request_id,
    envelope: JSON.parse(record.envelope_json),
    state: record.state,
    attemptCount: Number(record.attempt_count),
    availableAt: record.available_at,
    leaseOwner: record.lease_owner,
    leaseUntil: record.lease_until,
    lastAttemptAt: record.last_attempt_at,
    lastErrorCode: record.last_error_code,
    receipt: record.receipt_json ? JSON.parse(record.receipt_json) : null,
    acknowledgedAt: record.acknowledged_at,
    createdAt: record.created_at,
    updatedAt: record.updated_at
  };
}

export class LocalOutboxV2 {
  #db = null;
  #closed = false;

  constructor({ path, clock, owner, readOnly = false, leaseMs = LEASE_MS }) {
    if (typeof path !== "string" || !path.trim()) throw fail("invalid_path");
    if (typeof clock !== "function") throw fail("invalid_clock");
    if (typeof owner !== "string" || !owner.trim()) throw fail("invalid_owner");
    this.path = path;
    this.clock = clock;
    this.owner = owner;
    this.leaseMs = leaseMs;
    this.readOnly = readOnly === true;
    // A read-only open must never conjure a database into existence: a
    // machine that only reads stays untouched.
    if (this.readOnly) return;
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL;");
    transaction(this.#db, () => {
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS local_outbox_rows (
          request_id TEXT PRIMARY KEY,
          envelope_json TEXT NOT NULL,
          envelope_hash TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'acknowledged', 'blocked')),
          attempt_count INTEGER NOT NULL DEFAULT 0,
          available_at TEXT NOT NULL,
          lease_owner TEXT,
          lease_until TEXT,
          last_attempt_at TEXT,
          last_error_code TEXT,
          receipt_json TEXT,
          acknowledged_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS local_outbox_due
          ON local_outbox_rows (state, available_at, created_at);
      `);
    });
    this.recoverExpired();
  }

  get opened() {
    return this.#db !== null;
  }

  #require() {
    if (this.#closed) throw fail("outbox_closed");
    if (this.#db === null) throw fail("outbox_read_only");
    return this.#db;
  }

  enqueue(envelope) {
    const db = this.#require();
    const requestId = envelope?.requestId;
    if (typeof requestId !== "string" || !requestId.trim()) throw fail("invalid_request_id");
    const hash = envelopeHash(envelope);
    const now = this.clock();
    return transaction(db, () => {
      const existing = db.prepare(
        "SELECT request_id, envelope_hash, state FROM local_outbox_rows WHERE request_id = ?"
      ).get(requestId);
      if (existing) {
        if (existing.envelope_hash !== hash) {
          // The same intent declared different content: park it. Overwriting
          // would silently drop the first declaration's bytes.
          db.prepare(
            `UPDATE local_outbox_rows
             SET state = 'blocked', last_error_code = 'request_id_conflict', updated_at = ?
             WHERE request_id = ?`
          ).run(now, requestId);
          return { requestId, state: "blocked", duplicate: false, conflict: true };
        }
        return { requestId, state: existing.state, duplicate: true, conflict: false };
      }
      db.prepare(
        `INSERT INTO local_outbox_rows (
           request_id, envelope_json, envelope_hash, state, attempt_count,
           available_at, created_at, updated_at
         ) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`
      ).run(requestId, JSON.stringify(envelope), hash, now, now, now);
      return { requestId, state: "pending", duplicate: false, conflict: false };
    });
  }

  claimDue({ limit = MAX_FLUSH_ROWS } = {}) {
    const db = this.#require();
    // Reclaim expired leases first: without this a row whose owner died would
    // stay 'sending' forever and the fact would never be delivered.
    this.recoverExpired();
    const now = this.clock();
    const leaseUntil = new Date(Date.parse(now) + this.leaseMs).toISOString();
    const size = Math.max(1, Math.min(Number(limit) || 0, MAX_FLUSH_ROWS));
    return transaction(db, () => {
      const due = db.prepare(
        `SELECT request_id FROM local_outbox_rows
         WHERE state = 'pending' AND available_at <= ?
         ORDER BY created_at, request_id LIMIT ?`
      ).all(now, size);
      const update = db.prepare(
        `UPDATE local_outbox_rows
         SET state = 'sending', attempt_count = attempt_count + 1,
             lease_owner = ?, lease_until = ?, last_attempt_at = ?, updated_at = ?
         WHERE request_id = ? AND state = 'pending'`
      );
      const claimed = [];
      for (const row of due) {
        update.run(this.owner, leaseUntil, now, now, row.request_id);
        claimed.push(row.request_id);
      }
      return claimed.map((requestId) => this.#read(requestId));
    });
  }

  confirm(receipt) {
    const db = this.#require();
    const requestId = receipt?.attemptedRequestId;
    if (typeof requestId !== "string" || !requestId.trim()) throw fail("receipt_mismatch", "attemptedRequestId");
    if (receipt?.cloudPersistence !== "d1_committed") {
      throw fail("receipt_mismatch", "cloudPersistence");
    }
    if (typeof receipt?.userId !== "string" || !receipt.userId.trim()) throw fail("receipt_mismatch", "userId");
    if (typeof receipt?.eventId !== "string" || !receipt.eventId.trim()) throw fail("receipt_mismatch", "eventId");
    const now = this.clock();
    return transaction(db, () => {
      const record = db.prepare(
        `SELECT request_id, state, lease_owner, lease_until, envelope_json
         FROM local_outbox_rows WHERE request_id = ?`
      ).get(requestId);
      // A receipt for a request we never attempted — or one that was already
      // settled — can never acknowledge: that is how one request's receipt is
      // prevented from masquerading as another's.
      if (!record || record.state !== "sending") throw fail("receipt_mismatch", "state");
      if (record.lease_owner !== null && record.lease_owner !== this.owner) {
        throw fail("receipt_mismatch", "owner");
      }
      if (record.lease_until !== null && Date.parse(record.lease_until) <= Date.parse(now)) {
        throw fail("receipt_mismatch", "lease_expired");
      }
      // Identity and event association: the receipt has to describe the very
      // fact this row froze, not merely a request id that happens to match.
      // The rules follow the frozen dedupe protocol instead of demanding
      // equality everywhere — a legitimate dedupe receipt carries the
      // CANONICAL event's id, which may differ from what this row declared.
      const frozen = JSON.parse(record.envelope_json);
      const expectedUserId = envelopeUserId(frozen);
      const expectedEventId = envelopeEventId(frozen);
      if (expectedUserId === null) throw fail("receipt_mismatch", "envelope_user");
      if (receipt.userId !== expectedUserId) throw fail("receipt_mismatch", "userId");
      if (typeof receipt?.canonicalRequestId !== "string" || !receipt.canonicalRequestId.trim()) {
        throw fail("receipt_mismatch", "canonicalRequestId");
      }
      if (receipt.canonicalRequestId === requestId) {
        // The cloud says THIS request created the event (or exactly replayed
        // it): the event id must be the one the frozen envelope declared.
        if (expectedEventId === null) throw fail("receipt_mismatch", "envelope_event");
        if (receipt.eventId !== expectedEventId) throw fail("receipt_mismatch", "eventId");
      } else {
        // A merged fact: the cloud folded this submission into an older one,
        // so the receipt carries that older event's id and the disposition
        // has to say so — anything else is an unfounded canonical reference.
        if (receipt.disposition !== "already_recorded") {
          throw fail("receipt_mismatch", "canonicalRequestId");
        }
      }
      db.prepare(
        `UPDATE local_outbox_rows
         SET state = 'acknowledged', receipt_json = ?, acknowledged_at = ?,
             lease_owner = NULL, lease_until = NULL, last_error_code = NULL, updated_at = ?
         WHERE request_id = ?`
      ).run(JSON.stringify(receipt), now, now, requestId);
      return { acknowledged: true, requestId };
    });
  }

  fail({ requestId, code }) {
    const db = this.#require();
    if (typeof requestId !== "string" || !requestId.trim()) throw fail("invalid_request_id");
    const reason = typeof code === "string" && code.trim() ? code : "delivery_failed";
    const now = this.clock();
    return transaction(db, () => {
      const record = db.prepare(
        "SELECT request_id, attempt_count, state FROM local_outbox_rows WHERE request_id = ?"
      ).get(requestId);
      if (!record) return { requestId, state: null };
      if (PERMANENT_CODES.has(reason)) {
        db.prepare(
          `UPDATE local_outbox_rows
           SET state = 'blocked', last_error_code = ?, lease_owner = NULL, lease_until = NULL,
               updated_at = ?
           WHERE request_id = ?`
        ).run(reason, now, requestId);
        return { requestId, state: "blocked", permanent: true };
      }
      if (record.state === "acknowledged") return { requestId, state: "acknowledged" };
      const attempts = Math.max(1, Number(record.attempt_count) || 0);
      const availableAt = new Date(Date.parse(now) + backoffFor(attempts - 1)).toISOString();
      db.prepare(
        `UPDATE local_outbox_rows
         SET state = 'pending', available_at = ?, last_error_code = ?,
             lease_owner = NULL, lease_until = NULL, updated_at = ?
         WHERE request_id = ?`
      ).run(availableAt, reason, now, requestId);
      return { requestId, state: "pending", retryAt: availableAt };
    });
  }

  // Startup recovery: only leases that already expired go back to the queue.
  // A live lease belongs to a process that is still working on the row.
  recoverExpired() {
    const db = this.#require();
    const now = this.clock();
    const result = db.prepare(
      `UPDATE local_outbox_rows
       SET state = 'pending', lease_owner = NULL, lease_until = NULL, updated_at = ?
       WHERE state = 'sending' AND (lease_until IS NULL OR lease_until <= ?)`
    ).run(now, now);
    return { recovered: Number(result.changes ?? 0) };
  }

  purgeAcknowledged({ limit = MAX_PURGE_ROWS } = {}) {
    const db = this.#require();
    const cutoff = new Date(Date.parse(this.clock()) - ACK_RETENTION_MS).toISOString();
    const size = Math.max(1, Math.min(Number(limit) || 0, MAX_PURGE_ROWS));
    return transaction(db, () => {
      // Only acknowledged rows past the retention window, in bounded batches,
      // and never a pending or blocked row.
      const stale = db.prepare(
        `SELECT request_id FROM local_outbox_rows
         WHERE state = 'acknowledged' AND acknowledged_at IS NOT NULL AND acknowledged_at <= ?
         ORDER BY acknowledged_at, request_id LIMIT ?`
      ).all(cutoff, size);
      const remove = db.prepare("DELETE FROM local_outbox_rows WHERE request_id = ?");
      for (const row of stale) remove.run(row.request_id);
      return stale.length;
    });
  }

  #read(requestId) {
    return rowOf(this.#db.prepare("SELECT * FROM local_outbox_rows WHERE request_id = ?").get(requestId));
  }

  get(requestId) {
    if (this.#db === null) return null;
    if (typeof requestId !== "string" || !requestId.trim()) return null;
    return this.#read(requestId);
  }

  inspect() {
    if (this.#db === null) return [];
    return this.#db.prepare(
      "SELECT * FROM local_outbox_rows ORDER BY created_at, request_id"
    ).all().map(rowOf);
  }

  // Migration-only import: copy a legacy row without sending it or changing
  // its durable state. This is intentionally separate from enqueue so a
  // restored blocked/sending row cannot be mistaken for a fresh submission.
  restore(record) {
    const db = this.#require();
    if (!record || typeof record.requestId !== "string" || !record.requestId.trim()
      || !record.envelope || !["pending", "sending", "acknowledged", "blocked"].includes(record.state)) {
      throw fail("invalid_migration_row");
    }
    const hash = envelopeHash(record.envelope);
    const now = this.clock();
    return transaction(db, () => {
      const existing = db.prepare("SELECT envelope_hash, state FROM local_outbox_rows WHERE request_id = ?").get(record.requestId);
      if (existing) {
        if (existing.envelope_hash !== hash) throw fail("migration_conflict");
        return { requestId: record.requestId, duplicate: true, state: existing.state };
      }
      db.prepare(`
        INSERT INTO local_outbox_rows (
          request_id, envelope_json, envelope_hash, state, attempt_count,
          available_at, lease_owner, lease_until, last_attempt_at,
          last_error_code, receipt_json, acknowledged_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.requestId, JSON.stringify(record.envelope), hash, record.state,
        Number(record.attemptCount ?? 0), record.availableAt ?? now,
        record.leaseOwner ?? null, record.leaseUntil ?? null, record.lastAttemptAt ?? null,
        record.lastErrorCode ?? null, record.receipt ? JSON.stringify(record.receipt) : null,
        record.acknowledgedAt ?? null, record.createdAt ?? now, record.updatedAt ?? now
      );
      return { requestId: record.requestId, duplicate: false, state: record.state };
    });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#db !== null) {
      this.#db.close();
      this.#db = null;
    }
  }
}

export { existsSync };
