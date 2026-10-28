// RDS-JBryon local Outbox (design §4, §8, §10).
//
// Every request is frozen and committed to SQLite BEFORE any network attempt.
// States: local_pending -> sending -> cloud_acknowledged, plus
// waiting_dependency, delivery_blocked and cancelled. A D1 receipt ends transport
// retries but never satisfies a dependency by itself: dependencies are checked
// against the authoritative effect before a request is allowed to send.
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stableStringify, validateRequest, RdsError, PROTOCOL } from "../../services/rds-jbryon/src/contracts.js";

export const LOCAL_STATES = Object.freeze([
  "local_pending", "sending", "cloud_acknowledged", "waiting_dependency",
  "delivery_blocked", "cancelled"
]);
export const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 480_000];
const LEASE_MS = 60_000;
// A request in one of these states has not been accepted by the cloud yet, so
// a local target deletion may still stop it. cloud_acknowledged is deliberately
// absent: the cloud owns that request and its own deletion gate closes it.
const CANCELLABLE_STATES = Object.freeze([
  "local_pending", "sending", "waiting_dependency", "delivery_blocked"
]);
const CANCELLABLE_SQL = CANCELLABLE_STATES.map((state) => `'${state}'`).join(", ");
const PERMANENT_CODES = new Set([
  "request_id_conflict", "unsupported_protocol", "unsupported_api_version",
  "unsupported_operation", "invalid_request", "invalid_workspace_epoch"
]);

const fail = (code, detail) => {
  const error = new RdsError(code, detail);
  return error;
};

export function contentHashOf(request) {
  return createHash("sha256").update(stableStringify({
    protocol: request.protocol,
    apiVersion: request.apiVersion,
    workspaceEpoch: request.workspaceEpoch,
    requestId: request.requestId,
    operation: request.operation,
    target: request.target ?? null,
    dependsOn: request.dependsOn ?? [],
    baseRevision: request.baseRevision ?? null,
    changes: request.changes ?? null,
    confirmation: request.confirmation ?? null
  })).digest("hex");
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

function requestNodeIds(nodeIds) {
  if (!Array.isArray(nodeIds)) throw fail("invalid_node_ids");
  const ids = [];
  for (const value of nodeIds) {
    if (typeof value !== "string" || !value.trim()) throw fail("invalid_node_ids");
    if (!ids.includes(value)) ids.push(value);
  }
  return ids;
}

/**
 * Bulk local cancellation for every request whose frozen target is one of
 * `nodeIds` (or whose frozen parent is one of them: a create under a deleted
 * parent must not survive the parent). Rows are never deleted: the request id,
 * content hash and state remain available for dedupe and audit (design §11.1).
 *
 * Exported for the offline reconciliation pass, which must run inside its own
 * SQLite transaction (`inTransaction: true`) so body cleanup and cancellation
 * commit together. `LocalOutbox.cancelForNodes` is the ordinary entry point.
 */
export function cancelRequestsForNodes(db, nodeIds, {
  now = new Date().toISOString(),
  reason = "target_deleted",
  inTransaction = false
} = {}) {
  const ids = requestNodeIds(nodeIds);
  if (ids.length === 0) {
    return {
      nodeIds: [], requestIds: [], matchedRequestIds: [],
      cancelled: 0, alreadyCancelled: 0, skipped: 0
    };
  }
  const marks = ids.map(() => "?").join(", ");
  const action = () => {
    const rows = db.prepare(
      `SELECT request_id, state FROM local_requests
       WHERE json_extract(envelope_json, '$.target.nodeId') IN (${marks})
          OR json_extract(envelope_json, '$.target.parentId') IN (${marks})`
    ).all(...ids, ...ids);
    const cancellable = rows.filter((row) => CANCELLABLE_STATES.includes(row.state));
    const update = db.prepare(
      `UPDATE local_requests
       SET state = 'cancelled', last_error = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?
       WHERE request_id = ? AND state IN (${CANCELLABLE_SQL})`
    );
    for (const row of cancellable) update.run(reason, now, row.request_id);
    return {
      nodeIds: ids,
      requestIds: cancellable.map((row) => row.request_id),
      // Every matching row, including cloud_acknowledged ones. Offline cleanup
      // uses this list to strip local bodies without rewriting cloud state.
      matchedRequestIds: rows.map((row) => row.request_id),
      cancelled: cancellable.length,
      alreadyCancelled: rows.filter((row) => row.state === "cancelled").length,
      skipped: rows.filter((row) => row.state !== "cancelled"
        && !CANCELLABLE_STATES.includes(row.state)).length
    };
  };
  return inTransaction ? action() : transaction(db, action);
}


function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

// Writes that need an EXISTING target. Creates only need their parent proven.
const EXISTING_TARGET_OPS = new Set([
  "snapshot.patch", "snapshot.delete", "directory.delete",
  "directory.rename", "directory.move", "conflict.resolve", "task.retry"
]);

function activeMatches(db, path) {
  const row = db.prepare(
    `WITH RECURSIVE tree(node_id, name, path, lifecycle) AS (
       SELECT node_id, name, name, lifecycle FROM offline_nodes
        WHERE parent_id IS NULL AND lifecycle = 'active'
       UNION ALL
       SELECT n.node_id, n.name, t.path || '/' || n.name, n.lifecycle
       FROM offline_nodes n JOIN tree t ON n.parent_id = t.node_id
       WHERE n.lifecycle = 'active'
     )
     SELECT node_id FROM tree WHERE path = ?`
  ).all(path.join("/"));
  return row.map((entry) => entry.node_id);
}

/**
 * Freeze a readable path onto a stable node id. Only a UNIQUE ACTIVE target is
 * provable offline; a cache miss, a tombstone-only match or several active
 * matches blocks the request instead of letting the cloud resolve it later
 * against a same-named rebuild. Users still supply only the path.
 */
function bindTargetToOfflineCache(db, request) {
  const target = request?.target;
  if (!target || typeof target !== "object") return { request };
  if (typeof target.nodeId === "string" && target.nodeId) return { request };
  if (!Array.isArray(target.path) || target.path.length === 0) return { request };
  try {
    const existing = EXISTING_TARGET_OPS.has(request.operation);
    const lookupPath = existing ? target.path : target.path.slice(0, -1);
    if (lookupPath.length === 0) return { request };
    if (!tableExists(db, "offline_nodes")) {
      return { request, blocked: "target_binding_unresolved" };
    }
    const matches = activeMatches(db, lookupPath);
    if (matches.length === 0) {
      return { request, blocked: "target_binding_unresolved" };
    }
    if (matches.length > 1) {
      return { request, blocked: "target_binding_ambiguous" };
    }
    if (existing) {
      return { request: { ...request, target: { ...target, nodeId: matches[0] } } };
    }
    return { request: { ...request, target: { ...target, parentId: matches[0] } } };
  } catch {
    return { request, blocked: "target_binding_unresolved" };
  }
}
export class LocalOutbox {
  #db = null;
  #closed = false;

  constructor({ path, clock = () => new Date().toISOString(), owner = "rds-jbryon-local", leaseMs = LEASE_MS }) {
    if (typeof path !== "string" || !path.trim()) throw fail("invalid_path");
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    // Separate MCP processes share the durable Outbox. A competing
    // BEGIN IMMEDIATE must wait for the current claim transaction instead of
    // failing immediately with SQLITE_BUSY and surfacing a false send error.
    this.#db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    this.clock = clock;
    this.owner = owner;
    this.leaseMs = leaseMs;
    transaction(this.#db, () => {
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS local_requests (
          request_id TEXT PRIMARY KEY,
          workspace_epoch TEXT NOT NULL,
          operation TEXT NOT NULL,
          envelope_json TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('local_pending','sending','cloud_acknowledged','waiting_dependency','delivery_blocked','cancelled')),
          attempt_count INTEGER NOT NULL DEFAULT 0,
          available_at TEXT NOT NULL,
          lease_owner TEXT,
          lease_until TEXT,
          last_error TEXT,
          receipt_json TEXT,
          effect TEXT,
          body_redacted INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS local_requests_due
          ON local_requests (state, available_at, created_at);
      `);
      // Existing local databases predate the offline body-redaction marker.
      const columns = this.#db.prepare("PRAGMA table_info(local_requests)").all()
        .map((row) => row.name);
      if (!columns.includes("body_redacted")) {
        this.#db.exec("ALTER TABLE local_requests ADD COLUMN body_redacted INTEGER NOT NULL DEFAULT 0");
      }
    });
    this.recoverExpired();
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#db?.close();
    this.#db = null;
  }

  #require() {
    if (this.#closed || !this.#db) throw fail("outbox_closed");
    return this.#db;
  }

  enqueue(request) {
    const db = this.#require();
    const binding = bindTargetToOfflineCache(db, request);
    request = binding.request;
    validateRequest(request);
    const hash = contentHashOf(request);
    const now = this.clock();
    return transaction(db, () => {
      const existing = db.prepare(
        "SELECT request_id, content_hash, state, receipt_json, effect FROM local_requests WHERE request_id = ?"
      ).get(request.requestId);
      if (existing) {
        if (existing.content_hash !== hash) throw fail("request_id_conflict", request.requestId);
        return {
          requestId: request.requestId,
          state: existing.state,
          duplicate: true,
          receipt: existing.receipt_json ? JSON.parse(existing.receipt_json) : null,
          effect: existing.effect
        };
      }
      const initialState = binding.blocked ? "delivery_blocked" : "local_pending";
      db.prepare(
        `INSERT INTO local_requests (request_id, workspace_epoch, operation, envelope_json, content_hash,
           state, attempt_count, available_at, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
      ).run(request.requestId, request.workspaceEpoch, request.operation,
        JSON.stringify(request), hash, initialState, now,
        binding.blocked ?? null, now, now);
      return {
        requestId: request.requestId, state: initialState, duplicate: false, receipt: null,
        ...(binding.blocked ? { blocked: binding.blocked } : {})
      };
    });
  }

  get(requestId) {
    const row = this.#require().prepare("SELECT * FROM local_requests WHERE request_id = ?").get(requestId);
    return row ? shape(row) : null;
  }

  list({ limit = 50 } = {}) {
    return this.#require().prepare(
      "SELECT * FROM local_requests ORDER BY created_at, request_id LIMIT ?"
    ).all(Math.max(1, Math.min(Number(limit) || 50, 200))).map(shape);
  }

  #claim(requestIds) {
    const db = this.#require();
    const now = this.clock();
    const leaseUntil = new Date(Date.parse(now) + this.leaseMs).toISOString();
    return transaction(db, () => {
      const update = db.prepare(
        `UPDATE local_requests SET state = 'sending', attempt_count = attempt_count + 1,
           lease_owner = ?, lease_until = ?, updated_at = ?
         WHERE request_id = ? AND state = 'local_pending'`
      );
      const claimed = [];
      for (const requestId of requestIds) {
        const result = update.run(this.owner, leaseUntil, now, requestId);
        if (Number(result.changes ?? 0) === 1) claimed.push(this.get(requestId));
      }
      return claimed;
    });
  }

  claimDue({ limit = 20 } = {}) {
    const db = this.#require();
    this.recoverExpired();
    const now = this.clock();
    const due = db.prepare(
      `SELECT request_id FROM local_requests
       WHERE state = 'local_pending' AND available_at <= ?
       ORDER BY created_at, request_id LIMIT ?`
    ).all(now, Math.max(1, Math.min(Number(limit) || 20, 20)));
    return this.#claim(due.map((row) => row.request_id));
  }

  /** Claim exactly one request (used when a submit wants to try immediately). */
  claimOne(requestId) {
    this.recoverExpired();
    const row = this.#require().prepare(
      "SELECT request_id FROM local_requests WHERE request_id = ? AND state = 'local_pending' AND available_at <= ?"
    ).get(requestId, this.clock());
    return row ? this.#claim([requestId])[0] ?? null : null;
  }
  /** A D1 receipt: stop transport retries, but the effect is still pending. */
  acknowledge(receipt) {
    const db = this.#require();
    const requestId = receipt?.requestId;
    if (typeof requestId !== "string" || !requestId.trim()) throw fail("receipt_mismatch");
    if (receipt?.status !== "d1_committed") throw fail("receipt_mismatch", "status");
    const now = this.clock();
    return transaction(db, () => {
      const row = db.prepare("SELECT state, lease_owner, lease_until FROM local_requests WHERE request_id = ?").get(requestId);
      if (!row) throw fail("receipt_mismatch", "unknown_request");
      if (row.state !== "sending") throw fail("receipt_mismatch", "state");
      if (row.lease_owner !== null && row.lease_owner !== this.owner) throw fail("receipt_mismatch", "owner");
      db.prepare(
        `UPDATE local_requests SET state = 'cloud_acknowledged', receipt_json = ?, effect = 'pending',
           lease_owner = NULL, lease_until = NULL, last_error = NULL, updated_at = ?
         WHERE request_id = ?`
      ).run(JSON.stringify(receipt), now, requestId);
      return { requestId, state: "cloud_acknowledged" };
    });
  }

  /** Record an authoritative effect read back from the cloud. */
  observeEffect(requestId, effect) {
    const db = this.#require();
    const now = this.clock();
    return transaction(db, () => {
      const row = db.prepare("SELECT state FROM local_requests WHERE request_id = ?").get(requestId);
      if (!row) throw fail("unknown_request", requestId);
      db.prepare("UPDATE local_requests SET effect = ?, updated_at = ? WHERE request_id = ?")
        .run(effect, now, requestId);
      return { requestId, effect };
    });
  }

  /** A dependency is not ready: wait without spending failure attempts. */
  waitForDependency(requestId, code) {
    const db = this.#require();
    const now = this.clock();
    return transaction(db, () => {
      const row = db.prepare("SELECT state FROM local_requests WHERE request_id = ?").get(requestId);
      if (!row) throw fail("unknown_request", requestId);
      if (row.state === "cancelled" || row.state === "delivery_blocked") return { requestId, state: row.state };
      db.prepare(
        `UPDATE local_requests SET state = 'waiting_dependency', last_error = ?, lease_owner = NULL,
           lease_until = NULL,
           attempt_count = CASE WHEN attempt_count > 0 THEN attempt_count - 1 ELSE 0 END,
           updated_at = ? WHERE request_id = ?`
      ).run(code ?? "dependency_pending", now, requestId);
      return { requestId, state: "waiting_dependency", code: code ?? "dependency_pending" };
    });
  }

  /** Requeue a waiting request once its dependency is applied. */
  releaseWaiting(requestId) {
    const db = this.#require();
    const now = this.clock();
    return transaction(db, () => {
      const row = db.prepare("SELECT state FROM local_requests WHERE request_id = ?").get(requestId);
      if (!row) throw fail("unknown_request", requestId);
      if (row.state !== "waiting_dependency") return { requestId, state: row.state };
      db.prepare(
        "UPDATE local_requests SET state = 'local_pending', available_at = ?, last_error = NULL, updated_at = ? WHERE request_id = ?"
      ).run(now, now, requestId);
      return { requestId, state: "local_pending" };
    });
  }

  cancel(requestId, reason = "cancelled") {
    const db = this.#require();
    const now = this.clock();
    return transaction(db, () => {
      db.prepare(
        `UPDATE local_requests SET state = 'cancelled', last_error = ?, lease_owner = NULL,
           lease_until = NULL, updated_at = ? WHERE request_id = ?`
      ).run(reason, now, requestId);
      return { requestId, state: "cancelled" };
    });
  }

  /**
   * Batch cancellation by target node (J32). A request whose target node or
   * target parent is in `nodeIds` is cancelled; the row is kept. Requests that
   * already reached the cloud are not rewritten here.
   */
  cancelForNodes(nodeIds, reason = "target_deleted") {
    const db = this.#require();
    return cancelRequestsForNodes(db, nodeIds, { now: this.clock(), reason });
  }

  /** A send failure: permanent codes park, transient ones back off, capped. */
  fail(requestId, code) {
    const db = this.#require();
    const now = this.clock();
    return transaction(db, () => {
      const row = db.prepare(
        "SELECT state, attempt_count FROM local_requests WHERE request_id = ?"
      ).get(requestId);
      if (!row) throw fail("unknown_request", requestId);
      if (row.state === "cloud_acknowledged" || row.state === "cancelled") {
        return { requestId, state: row.state };
      }
      if (PERMANENT_CODES.has(code)) {
        db.prepare(
          "UPDATE local_requests SET state = 'delivery_blocked', last_error = ?, lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE request_id = ?"
        ).run(code, now, requestId);
        return { requestId, state: "delivery_blocked", permanent: true };
      }
      const attempts = Math.max(1, Number(row.attempt_count) || 0);
      if (attempts >= MAX_ATTEMPTS) {
        db.prepare(
          "UPDATE local_requests SET state = 'delivery_blocked', last_error = ?, lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE request_id = ?"
        ).run(code, now, requestId);
        return { requestId, state: "delivery_blocked", attempts };
      }
      const availableAt = new Date(Date.parse(now) + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]).toISOString();
      db.prepare(
        `UPDATE local_requests SET state = 'local_pending', available_at = ?, last_error = ?,
           lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE request_id = ?`
      ).run(availableAt, code, now, requestId);
      return { requestId, state: "local_pending", retryAt: availableAt };
    });
  }

  recoverExpired() {
    const db = this.#require();
    const now = this.clock();
    const result = db.prepare(
      `UPDATE local_requests SET state = 'local_pending', lease_owner = NULL, lease_until = NULL, updated_at = ?
       WHERE state = 'sending' AND (lease_until IS NULL OR lease_until <= ?)`
    ).run(now, now);
    return { recovered: Number(result.changes ?? 0) };
  }
}

function shape(row) {
  return {
    requestId: row.request_id,
    workspaceEpoch: row.workspace_epoch,
    operation: row.operation,
    request: JSON.parse(row.envelope_json),
    contentHash: row.content_hash,
    state: row.state,
    attemptCount: Number(row.attempt_count),
    availableAt: row.available_at,
    lastError: row.last_error,
    receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null,
    effect: row.effect,
    bodyRedacted: Number(row.body_redacted ?? 0) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** A cloud client whose only job is transport; no identity, no accounts. */
export function createRdsClient({ baseUrl, token, fetchImpl = fetch }) {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) throw fail("invalid_base_url");
  if (typeof token !== "string" || !token.trim()) throw fail("invalid_token");
  const root = baseUrl.replace(/\/$/, "");
  async function call(body) {
    const response = await fetchImpl(`${root}/rds`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ protocol: PROTOCOL, apiVersion: 1, ...body })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload?.error?.code ?? `http_${response.status}`);
      error.code = payload?.error?.code ?? `http_${response.status}`;
      throw error;
    }
    return payload;
  }
  return {
    submit: (request) => call({ kind: "request", request }),
    status: (requestId) => call({ kind: "query", operation: "request.status", params: { requestId } }),
    read: (operation, params = {}) => call({ kind: "query", operation, params }),
    admin: (operation, params = {}) => call({ kind: "admin", operation, params })
  };
}
