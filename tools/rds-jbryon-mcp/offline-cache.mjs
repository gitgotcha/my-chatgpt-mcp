// RDS-JBryon offline cache reconciliation (design §11.1–§11.2, J32).
//
// The cloud deletion manifest is the authority for what a deletion gate froze.
// A local cache may have moved nodes in or out while the device was offline, so
// the local view cannot decide erasure by itself. This module has two halves:
//
//   * planOfflineReconciliation — pure, deterministic planning over the
//     authoritative manifest, the local node records and the pending local
//     requests. It never touches SQLite and never performs I/O.
//   * applyOfflineReconciliation — one SQLite transaction that removes cached
//     bodies and cancels pending requests while keeping immutable node/request
//     identifiers and append-only audit rows. Repeating the same plan is
//     idempotent: a second run changes no body, state or audit row.
//
// The cache deliberately stores only local copies that the design allows
// (§12: a local read-only route cache, not an offline mirror presented as the
// latest data). A node moved out BEFORE the gate is kept because the cloud
// manifest no longer covers it; a node moved in AFTER the gate is an explicit
// conflict because the gate, not the stale local parent, decides membership
// (§11.2). Neither case is silently resolved.
import { DatabaseSync } from "node:sqlite";
import { cancelRequestsForNodes } from "./outbox.mjs";

/** Local requests that have not reached a cloud acceptance state. */
export const PENDING_LOCAL_STATES = Object.freeze([
  "local_pending", "sending", "waiting_dependency", "delivery_blocked"
]);

const MOVED_OUT_CODE = "moved_out_before_gate";
const MOVED_IN_CODE = "moved_in_after_gate";
const DELETE_REASON = "target_deleted";
const MANIFEST_REASON = "deletion_manifest";

const invalid = (detail) => {
  const error = new Error(`invalid_offline_cache:${detail}`);
  error.code = "invalid_offline_cache";
  error.detail = detail;
  throw error;
};

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sorted = (values) => [...values].sort();

function uniqueNodeIds(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalid(field);
  const ids = [];
  for (const entry of value) {
    const nodeId = typeof entry === "string" ? entry : entry?.nodeId;
    if (typeof nodeId !== "string" || nodeId.length === 0) invalid(field);
    if (!ids.includes(nodeId)) ids.push(nodeId);
  }
  return ids;
}

function normalizeLocalNode(raw) {
  if (!isObject(raw)) invalid("local_node");
  const nodeId = raw.nodeId;
  if (typeof nodeId !== "string" || nodeId.length === 0) invalid("local_node.nodeId");
  return {
    nodeId,
    parentId: typeof raw.parentId === "string" && raw.parentId.length ? raw.parentId : null,
    name: typeof raw.name === "string" ? raw.name : null,
    kind: typeof raw.kind === "string" ? raw.kind : null,
    lifecycle: typeof raw.lifecycle === "string" ? raw.lifecycle : "active",
    movedOutBeforeGate: raw.movedOutBeforeGate === true,
    movedInAfterGate: raw.movedInAfterGate === true,
    movedOutOf: typeof raw.movedOutOf === "string" ? raw.movedOutOf : null,
    movedInTo: typeof raw.movedInTo === "string" ? raw.movedInTo : null
  };
}

/**
 * Pure planning pass. The only inputs are the authoritative manifest node ids,
 * the local node records and the pending local requests. The move facts are
 * recorded by the sync client when it observes them relative to the gate it
 * received (movedOutBeforeGate / movedInAfterGate).
 *
 * Output:
 *   keep           — local nodes that survive (includes moved-out nodes and
 *                    nodes unrelated to the deletion)
 *   erase          — manifest nodes and descendants to erase
 *   cancelRequests — pending requests pointing into the erased scope; their
 *                    local event bodies are marked for redaction
 *   movedOut       — the keep subset with a "moved out before the gate" fact
 *   conflicts      — nodes locally placed inside the frozen subtree after the
 *                    gate; they are NOT erased and NOT silently kept
 */
export function planOfflineReconciliation({
  manifestNodeIds = [],
  localNodes = [],
  pendingRequests = []
} = {}) {
  if (!Array.isArray(manifestNodeIds)) invalid("manifestNodeIds");
  if (!Array.isArray(localNodes)) invalid("localNodes");
  if (!Array.isArray(pendingRequests)) invalid("pendingRequests");

  const nodes = localNodes.map(normalizeLocalNode);
  const byId = new Map();
  const children = new Map();
  for (const node of nodes) {
    byId.set(node.nodeId, node);
    if (node.parentId !== null) {
      if (!children.has(node.parentId)) children.set(node.parentId, []);
      children.get(node.parentId).push(node.nodeId);
    }
  }

  const manifest = new Set();
  for (const nodeId of manifestNodeIds) {
    if (typeof nodeId !== "string" || nodeId.length === 0) invalid("manifestNodeIds");
    manifest.add(nodeId);
  }

  const movedOutFact = (node) => node.movedOutBeforeGate === true;
  const movedInFact = (node) => node.movedInAfterGate === true;

  const erase = new Set();
  const conflictIds = new Set();
  const conflicts = [];
  const queue = [];
  // Manifest membership is unconditional: a local "moved out" flag can never
  // shrink the authoritative frozen scope.
  for (const nodeId of manifest) {
    erase.add(nodeId);
    queue.push({ nodeId, rootId: nodeId });
  }

  const addConflict = (nodeId, manifestRootId) => {
    if (conflictIds.has(nodeId) || manifest.has(nodeId)) return;
    conflictIds.add(nodeId);
    conflicts.push({
      nodeId,
      code: MOVED_IN_CODE,
      manifestRootId,
      detail: "local membership was recorded after the deletion gate froze the subtree; the cloud manifest is authoritative"
    });
  };

  // A moved-in node carries its local descendants with it. The whole local
  // placement is untrusted, so every descendant is surfaced rather than erased
  // (the cloud says these nodes are outside the frozen scope).
  const collectMovedInSubtree = (rootId, manifestRootId) => {
    const stack = [rootId];
    const seen = new Set();
    while (stack.length) {
      const nodeId = stack.pop();
      if (seen.has(nodeId) || manifest.has(nodeId)) continue;
      seen.add(nodeId);
      addConflict(nodeId, manifestRootId);
      for (const childId of children.get(nodeId) ?? []) {
        if (!seen.has(childId) && !manifest.has(childId)) stack.push(childId);
      }
    }
  };

  while (queue.length) {
    const { nodeId, rootId } = queue.shift();
    for (const childId of children.get(nodeId) ?? []) {
      if (erase.has(childId)) continue;
      const child = byId.get(childId);
      if (!child) continue;
      if (manifest.has(childId)) {
        erase.add(childId);
        queue.push({ nodeId: childId, rootId: childId });
        continue;
      }
      if (movedOutFact(child)) {
        // Keep the node and its local subtree: the cloud manifest excludes it.
        continue;
      }
      if (movedInFact(child)) {
        // Do not quietly erase a node the cloud says lives outside the frozen
        // subtree, and do not quietly keep the stale placement either.
        collectMovedInSubtree(childId, rootId);
        continue;
      }
      erase.add(childId);
      queue.push({ nodeId: childId, rootId });
    }
  }

  const keep = new Set();
  const movedOut = [];
  for (const node of nodes) {
    if (erase.has(node.nodeId) || conflictIds.has(node.nodeId)) continue;
    keep.add(node.nodeId);
    if (movedOutFact(node)) {
      movedOut.push({
        nodeId: node.nodeId,
        movedOutOf: node.movedOutOf ?? node.parentId,
        reason: MOVED_OUT_CODE
      });
    }
  }

  const cancelRequests = [];
  const cancelled = new Set();
  for (const raw of pendingRequests) {
    if (!isObject(raw)) invalid("pending_request");
    const envelope = isObject(raw.request) ? raw.request
      : (isObject(raw.envelope) ? raw.envelope : raw);
    const state = raw.state ?? envelope.state ?? null;
    if (state !== null && !PENDING_LOCAL_STATES.includes(state)) continue;
    const requestId = raw.requestId ?? envelope.requestId;
    if (typeof requestId !== "string" || requestId.length === 0) continue;
    if (cancelled.has(requestId)) continue;
    const target = isObject(envelope.target) ? envelope.target : {};
    const nodeId = raw.nodeId ?? target.nodeId ?? null;
    const parentNodeId = raw.parentNodeId ?? target.parentId ?? null;
    if (!(nodeId && erase.has(nodeId)) && !(parentNodeId && erase.has(parentNodeId))) continue;
    cancelled.add(requestId);
    cancelRequests.push({
      requestId,
      nodeId: typeof nodeId === "string" ? nodeId : null,
      parentNodeId: typeof parentNodeId === "string" ? parentNodeId : null,
      operation: raw.operation ?? envelope.operation ?? null,
      reason: DELETE_REASON,
      redactBody: true
    });
  }

  cancelRequests.sort((left, right) => left.requestId.localeCompare(right.requestId));
  movedOut.sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  conflicts.sort((left, right) => left.nodeId.localeCompare(right.nodeId));

  return {
    keep: sorted(keep),
    erase: sorted(erase),
    cancelRequests,
    movedOut,
    conflicts
  };
}

// --------------------------------------------------------------- local state

export function ensureOfflineCacheSchema(db) {
  if (!db || typeof db.exec !== "function" || typeof db.prepare !== "function") {
    invalid("db");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS offline_nodes (
      node_id TEXT PRIMARY KEY,
      parent_id TEXT,
      name TEXT,
      kind TEXT,
      lifecycle TEXT NOT NULL DEFAULT 'active',
      moved_out_before_gate INTEGER NOT NULL DEFAULT 0,
      moved_in_after_gate INTEGER NOT NULL DEFAULT 0,
      moved_out_of TEXT,
      moved_in_to TEXT,
      content_json TEXT,
      conflict_code TEXT,
      deleted_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS offline_nodes_parent_idx ON offline_nodes (parent_id);
    CREATE TABLE IF NOT EXISTS offline_audit (
      audit_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      node_id TEXT,
      request_id TEXT,
      detail_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS offline_audit_kind_idx ON offline_audit (kind, created_at);
  `);
  // The cache may share a database file with an Outbox created before the
  // body-redaction marker existed. Bring that table to the same shape.
  if (tableExists(db, "local_requests") && !columnExists(db, "local_requests", "body_redacted")) {
    db.exec("ALTER TABLE local_requests ADD COLUMN body_redacted INTEGER NOT NULL DEFAULT 0");
  }
  return db;
}

/** Opens (and initialises) the local cache database. Local file only. */
export function openOfflineCache({ path } = {}) {
  if (typeof path !== "string" || path.trim().length === 0) invalid("path");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  // Best-effort local body erasure: overwrite freed cells instead of leaving
  // the deleted body readable in the database free list. This is not a claim
  // about filesystem/backup copies (design §11.1.6).
  db.exec("PRAGMA secure_delete = ON;");
  ensureOfflineCacheSchema(db);
  return db;
}

/** Seeds/updates local cache records. Intended for the sync client and tests. */
export function upsertOfflineNodes(db, nodes, { now = new Date().toISOString() } = {}) {
  if (!db || typeof db.exec !== "function" || typeof db.prepare !== "function") invalid("db");
  if (!Array.isArray(nodes)) invalid("nodes");
  ensureOfflineCacheSchema(db);
  const statement = db.prepare(
    `INSERT INTO offline_nodes
       (node_id, parent_id, name, kind, lifecycle, moved_out_before_gate, moved_in_after_gate,
        moved_out_of, moved_in_to, content_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET
       parent_id = excluded.parent_id,
       name = excluded.name,
       kind = excluded.kind,
       lifecycle = excluded.lifecycle,
       moved_out_before_gate = excluded.moved_out_before_gate,
       moved_in_after_gate = excluded.moved_in_after_gate,
       moved_out_of = excluded.moved_out_of,
       moved_in_to = excluded.moved_in_to,
       content_json = excluded.content_json,
       updated_at = excluded.updated_at`
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const raw of nodes) {
      if (!isObject(raw) || typeof raw.nodeId !== "string" || raw.nodeId.length === 0) {
        invalid("node.nodeId");
      }
      const content = raw.contentJson !== undefined
        ? raw.contentJson
        : (raw.content !== undefined ? JSON.stringify(raw.content) : null);
      statement.run(
        raw.nodeId,
        typeof raw.parentId === "string" ? raw.parentId : null,
        typeof raw.name === "string" ? raw.name : null,
        typeof raw.kind === "string" ? raw.kind : null,
        typeof raw.lifecycle === "string" ? raw.lifecycle : "active",
        raw.movedOutBeforeGate === true ? 1 : 0,
        raw.movedInAfterGate === true ? 1 : 0,
        typeof raw.movedOutOf === "string" ? raw.movedOutOf : null,
        typeof raw.movedInTo === "string" ? raw.movedInTo : null,
        content === null ? null : String(content),
        typeof raw.updatedAt === "string" ? raw.updatedAt : now
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { nodes: nodes.length };
}

/** Reads local cache records in the shape planOfflineReconciliation accepts. */
export function readOfflineNodes(db) {
  ensureOfflineCacheSchema(db);
  return db.prepare(
    `SELECT node_id, parent_id, name, kind, lifecycle, moved_out_before_gate,
            moved_in_after_gate, moved_out_of, moved_in_to, content_json, conflict_code,
            deleted_at, updated_at
     FROM offline_nodes ORDER BY node_id`
  ).all().map((row) => ({
    nodeId: row.node_id,
    parentId: row.parent_id,
    name: row.name,
    kind: row.kind,
    lifecycle: row.lifecycle,
    movedOutBeforeGate: Number(row.moved_out_before_gate) === 1,
    movedInAfterGate: Number(row.moved_in_after_gate) === 1,
    movedOutOf: row.moved_out_of,
    movedInTo: row.moved_in_to,
    contentJson: row.content_json,
    conflictCode: row.conflict_code,
    deletedAt: row.deleted_at,
    updatedAt: row.updated_at
  }));
}

function tableExists(db, name) {
  return Boolean(db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(name));
}

function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all()
    .some((row) => row.name === column);
}

/** Pending local requests in the shape planOfflineReconciliation accepts. */
export function readPendingRequests(db) {
  ensureOfflineCacheSchema(db);
  if (!tableExists(db, "local_requests")) return [];
  return db.prepare(
    `SELECT request_id, operation, state, envelope_json, body_redacted
     FROM local_requests
     WHERE state IN (${PENDING_LOCAL_STATES.map((state) => `'${state}'`).join(", ")})
     ORDER BY created_at, request_id`
  ).all().map((row) => {
    let request = null;
    try {
      request = row.envelope_json ? JSON.parse(row.envelope_json) : null;
    } catch {
      request = null;
    }
    return {
      requestId: row.request_id,
      operation: row.operation,
      state: row.state,
      bodyRedacted: Number(row.body_redacted) === 1,
      request
    };
  });
}

// ------------------------------------------------------------------- applying

function normaliseCancelEntries(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalid("plan.cancelRequests");
  const entries = [];
  for (const raw of value) {
    const entry = typeof raw === "string" ? { requestId: raw } : raw;
    if (!isObject(entry) || typeof entry.requestId !== "string" || entry.requestId.length === 0) {
      invalid("plan.cancelRequests");
    }
    if (!entries.some((existing) => existing.requestId === entry.requestId)) entries.push(entry);
  }
  return entries;
}

function normaliseMovedOut(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalid("plan.movedOut");
  return value.map((raw) => {
    const entry = typeof raw === "string" ? { nodeId: raw } : raw;
    if (!isObject(entry) || typeof entry.nodeId !== "string" || entry.nodeId.length === 0) {
      invalid("plan.movedOut");
    }
    return entry;
  });
}

function normaliseConflicts(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalid("plan.conflicts");
  return value.map((raw) => {
    const entry = typeof raw === "string" ? { nodeId: raw } : raw;
    if (!isObject(entry) || typeof entry.nodeId !== "string" || entry.nodeId.length === 0) {
      invalid("plan.conflicts");
    }
    return { ...entry, code: typeof entry.code === "string" ? entry.code : MOVED_IN_CODE };
  });
}

function tombstoneOf(requestId, envelope) {
  const target = isObject(envelope?.target) ? envelope.target : null;
  const tombstone = {
    protocol: envelope?.protocol ?? "rds-jbryon",
    apiVersion: envelope?.apiVersion ?? 1,
    workspaceEpoch: envelope?.workspaceEpoch,
    requestId: envelope?.requestId ?? requestId,
    operation: envelope?.operation,
    redacted: true
  };
  if (target) tombstone.target = target;
  return tombstone;
}

/**
 * Applies a plan in one SQLite transaction. Cached bodies are cleared, pending
 * requests are cancelled and their envelopes are replaced by a body-free
 * tombstone; node/request ids, content hashes and audit rows stay. The update
 * predicates make a second identical application a no-op.
 */
export function applyOfflineReconciliation({ db, plan, now = () => new Date().toISOString() } = {}) {
  if (!db || typeof db.exec !== "function" || typeof db.prepare !== "function") invalid("db");
  if (!isObject(plan)) invalid("plan");
  ensureOfflineCacheSchema(db);

  const erase = uniqueNodeIds(plan.erase, "plan.erase");
  const keep = uniqueNodeIds(plan.keep, "plan.keep");
  const movedOut = normaliseMovedOut(plan.movedOut);
  const conflicts = normaliseConflicts(plan.conflicts);
  const cancelRequests = normaliseCancelEntries(plan.cancelRequests);
  const stamp = typeof now === "function" ? now() : (now ?? new Date().toISOString());
  const auditIds = new Set();
  let auditsInserted = 0;
  let erasedBodies = 0;
  let erasedRows = 0;
  let redactedRequests = 0;

  const audit = db.prepare(
    `INSERT OR IGNORE INTO offline_audit
       (audit_id, kind, node_id, request_id, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const writeAudit = (kind, nodeId, requestId, detail) => {
    const auditId = `${kind}:${nodeId ?? "-"}:${requestId ?? "-"}`;
    if (auditIds.has(auditId)) return;
    auditIds.add(auditId);
    const result = audit.run(
      auditId, kind, nodeId ?? null, requestId ?? null,
      JSON.stringify(detail ?? {}), stamp
    );
    auditsInserted += Number(result.changes ?? 0);
  };

  const eraseStatement = db.prepare(
    `INSERT INTO offline_nodes (node_id, lifecycle, content_json, deleted_at, updated_at)
     VALUES (?, 'deleted', NULL, ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET
       lifecycle = 'deleted',
       content_json = NULL,
       deleted_at = COALESCE(offline_nodes.deleted_at, excluded.deleted_at),
       conflict_code = NULL,
       updated_at = excluded.updated_at
     WHERE offline_nodes.lifecycle <> 'deleted'
        OR offline_nodes.content_json IS NOT NULL
        OR offline_nodes.deleted_at IS NULL
        OR offline_nodes.conflict_code IS NOT NULL`
  );
  const conflictStatement = db.prepare(
    `INSERT INTO offline_nodes (node_id, lifecycle, conflict_code, updated_at)
     VALUES (?, 'active', ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET
       conflict_code = excluded.conflict_code,
       updated_at = excluded.updated_at
     WHERE COALESCE(offline_nodes.conflict_code, '') <> excluded.conflict_code`
  );
  const keepStatement = db.prepare(
    `UPDATE offline_nodes SET conflict_code = NULL, updated_at = ?
     WHERE node_id = ? AND conflict_code IS NOT NULL`
  );
  const countBodies = db.prepare(
    "SELECT COUNT(1) AS total FROM offline_nodes WHERE node_id = ? AND content_json IS NOT NULL"
  );

  // Same connection-level guarantee even if the caller opened the database
  // outside openOfflineCache (for example the Outbox connection).
  db.exec("PRAGMA secure_delete = ON;");
  db.exec("BEGIN IMMEDIATE");
  try {
    // 1. Erase cached bodies in the authoritative scope; keep the id and an
    //    audit row. Unknown manifest ids still get their own tombstone row.
    for (const nodeId of erase) {
      const rowCount = countBodies.get(nodeId);
      erasedBodies += Number(rowCount?.total ?? 0);
      const result = eraseStatement.run(nodeId, stamp, stamp);
      erasedRows += Number(result.changes ?? 0);
      writeAudit("erase", nodeId, null, { reason: MANIFEST_REASON });
    }

    // 2. A node locally moved into the frozen subtree is surfaced, not erased.
    for (const conflict of conflicts) {
      conflictStatement.run(conflict.nodeId, conflict.code, stamp);
      writeAudit("conflict", conflict.nodeId, null, {
        code: conflict.code,
        manifestRootId: conflict.manifestRootId ?? null,
        detail: conflict.detail ?? null
      });
    }

    // 3. A node moved out before the gate survives; retain its evidence.
    for (const entry of movedOut) {
      keepStatement.run(stamp, entry.nodeId);
      writeAudit("keep_moved_out", entry.nodeId, null, {
        reason: MOVED_OUT_CODE,
        movedOutOf: entry.movedOutOf ?? null
      });
    }

    // 4. Cancel pending requests whose target is inside the erased scope and
    //    strip their local bodies. The outbox helper keeps every row.
    let cancelled = 0;
    if (tableExists(db, "local_requests")) {
      const outcome = cancelRequestsForNodes(db, erase, {
        now: stamp, reason: DELETE_REASON, inTransaction: true
      });
      cancelled = outcome.cancelled;
      const explicit = cancelRequests.map((entry) => entry.requestId);
      // Body cleanup covers acknowledged rows too: the cloud owns their state,
      // but a local copy of the payload must not survive the deletion scope.
      const redactIds = [...new Set([
        ...(outcome.matchedRequestIds ?? outcome.requestIds), ...explicit
      ])];
      const readRequest = db.prepare(
        "SELECT envelope_json, body_redacted FROM local_requests WHERE request_id = ?"
      );
      const redact = db.prepare(
        `UPDATE local_requests SET envelope_json = ?, body_redacted = 1, updated_at = ?
         WHERE request_id = ? AND body_redacted = 0`
      );
      const cancelExplicit = db.prepare(
        `UPDATE local_requests
         SET state = 'cancelled', last_error = ?, lease_owner = NULL, lease_until = NULL,
             updated_at = ?
         WHERE request_id = ? AND state IN (${PENDING_LOCAL_STATES.map((state) => `'${state}'`).join(", ")})`
      );
      for (const entry of cancelRequests) {
        cancelExplicit.run(DELETE_REASON, stamp, entry.requestId);
      }
      for (const requestId of redactIds) {
        const row = readRequest.get(requestId);
        if (!row) {
          writeAudit("cancel_request", null, requestId, {
            reason: DELETE_REASON, cached: false, bodyRedacted: true
          });
          continue;
        }
        if (Number(row.body_redacted) === 0) {
          let envelope = null;
          try {
            envelope = row.envelope_json ? JSON.parse(row.envelope_json) : null;
          } catch {
            envelope = null;
          }
          const result = redact.run(
            JSON.stringify(tombstoneOf(requestId, envelope)), stamp, requestId
          );
          redactedRequests += Number(result.changes ?? 0);
        }
        const entry = cancelRequests.find((item) => item.requestId === requestId);
        writeAudit("cancel_request", entry?.nodeId ?? entry?.parentNodeId ?? null, requestId, {
          reason: DELETE_REASON,
          bodyRedacted: true,
          operation: entry?.operation ?? null
        });
      }
    } else {
      for (const entry of cancelRequests) {
        writeAudit("cancel_request", entry.nodeId ?? null, entry.requestId, {
          reason: DELETE_REASON, cached: false, bodyRedacted: true
        });
      }
    }

    db.exec("COMMIT");
    return {
      appliedAt: stamp,
      erased: erase.length,
      erasedRows,
      erasedBodies,
      kept: keep.length,
      movedOut: movedOut.length,
      conflicts: conflicts.length,
      cancelled,
      redactedRequests,
      auditsInserted
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
