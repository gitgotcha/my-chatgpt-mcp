// RDS-JBryon D1 storage layer (design 2026-10-26 §4–§12).
//
// Single user by construction: nothing in this module accepts or stores a
// username/userId. `workspace_epoch` is a workspace identity, not a user id.
// The store is pure D1: no Queue, no Drive, no network, no clock other than the
// injected `now` function.
//
// Scope of this minimal implementation (what is deliberately NOT here, see the
// delivery report):
//   * no Queue/network calls — `accept` commits D1 only; the Worker dispatches
//     committed tasks to Queue outside the accept transaction;
//   * no multi-generation / rebuild table (`snapshot.rebuild`, `rebuilding`
//     display) — stale writes are instead rejected by the deletion gate, the
//     catalog-revision guard and the node-lifecycle guard;
//   * deletion discovery and body cleanup both use a persisted offset over the
//     subtree, whose membership is frozen by the deletion gate;
//   * no Outbox, MCP connection-key or Skill-layer code (J01/J05/J19/J27/J28/
//     J29/J30 belong to those layers);
//   * `task.retry` is admin-only and does not enter `accept`/Outbox:
//     `retryTask()` requeues a needs_attention task with a bumped lease epoch.
//     `snapshotHistory()` is a read query (metadata only, no bodies);
//   * src/routes.js is served by a thin alias layer at the bottom of the
//     returned object (querySnapshots/listConflicts) so the HTTP surface and the
//     store agree without either module owning the other's naming.
//
// Guaranteed properties implemented here:
//   * one atomic D1 batch per accept and per projection commit;
//   * requestId idempotency by content hash, replay returns the original
//     receipt plus the current effect;
//   * guarded-batch commits: the first batch statement inserts a
//     commit_guards row whose triggers validate task owner/lease_epoch/
//     lease_until, catalog_revision, node lifecycle and (when applicable) the
//     snapshot revision. A lost CAS aborts the whole batch, so a snapshot, a
//     version row, a request effect and a task state can never partially
//     commit against a stale lease;
//   * acceptance order per node: a task is only claimed when no earlier task
//     for the same node is still pending/processing;
//   * deletion freeze: a gate is created atomically at accept together with
//     node.lifecycle='deleting' and catalog_revision+1; later descendant writes
//     are rejected by accept, by the gate/catalog guards and by the snapshots
//     triggers, and late creates for a deleted/tombstoned node are rejected
//     with target_deleted.
import {
  API_VERSION,
  BUDGETS,
  PROTOCOL,
  PRODUCT_NAME,
  RdsError,
  bytesOf,
  canonicalRequest,
  normalizeName,
  normalizePath,
  stableStringify,
  validateEpoch,
  validateRequest
} from "./contracts.js";
import { applyChanges, classifyDependency, hasDependencyCycle } from "./merge.js";

export const TASK_LEASE_SECONDS = 300;
export const FAILURE_BACKOFF_SECONDS = [30, 60, 120, 240, 480];
export const FAILURE_COUNT_THRESHOLD = 5;
export const DELETE_PAGE_SIZE = 20;
export const REDACTED_EVENT_CLOSED_EFFECT = "cancelled";

// Operations the store applies itself; every other operation is either a read
// (never accepted) or the admin-only task.retry path.
const PROJECTABLE_OPERATIONS = new Set([
  "directory.create",
  "directory.rename",
  "directory.move",
  "directory.delete",
  "snapshot.create",
  "snapshot.patch",
  "snapshot.delete",
  "conflict.resolve"
]);

const encoder = new TextEncoder();
const fail = (code, detail) => {
  throw new RdsError(code, detail);
};

const addSeconds = (iso, seconds) => new Date(Date.parse(iso) + seconds * 1000).toISOString();
const jsonOf = (value) => JSON.stringify(value);
const placeholders = (count) => new Array(count).fill("?").join(", ");
const isUniqueViolation = (error) => /UNIQUE constraint failed/i.test(String(error?.message ?? ""));
const messageOf = (error) => String(error?.message ?? error ?? "");

// Trigger abort reasons are the only failures that mean "the world moved under
// this batch". Everything else is a real failure of the attempt.
const GUARD_ABORT_REASONS = [
  "stale_task_write",
  "stale_catalog_revision",
  "stale_node_state",
  "stale_snapshot_revision",
  "deletion_gate_blocks_write",
  "snapshot_revision_regression"
];
function guardAbortReason(error) {
  const message = messageOf(error);
  return GUARD_ABORT_REASONS.find((reason) => message.includes(reason)) ?? null;
}

async function sha256Hex(text) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const deriveId = async (prefix, ...parts) => `${prefix}_${(await sha256Hex(parts.join("\u0000"))).slice(0, 40)}`;

const contentHashOf = (envelope) => sha256Hex(stableStringify(canonicalRequest(envelope)));
const payloadHashOf = (envelope) => sha256Hex(stableStringify({
  operation: envelope.operation,
  baseRevision: envelope.baseRevision ?? null,
  changes: envelope.changes ?? null
}));

const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,127}$/;
function requireNodeId(value) {
  if (typeof value !== "string" || !NODE_ID_PATTERN.test(value)) fail("invalid_target", "nodeId");
  return value;
}

function encodeCursor(payload) {
  return `rds1:${encodeURIComponent(JSON.stringify(payload))}`;
}

function decodeCursor(cursor) {
  const match = /^rds1:(\S+)$/.exec(String(cursor ?? ""));
  if (!match) fail("cursor_invalid");
  try {
    const parsed = JSON.parse(decodeURIComponent(match[1]));
    if (parsed === null || typeof parsed !== "object") fail("cursor_invalid");
    return parsed;
  } catch (error) {
    if (error instanceof RdsError) throw error;
    fail("cursor_invalid");
  }
}

const ALL_TASK_STATES = ["pending", "queued", "processing", "completed", "needs_attention", "cancelled"];
void ALL_TASK_STATES;

/**
 * Writes/rotates the workspace identity. The migration seeds a placeholder row
 * so read paths have a stable shape; deployment calls this before serving so
 * clients of an old workspace can never replay into the new one.
 */
export async function initWorkspace(db, { epoch, force = false } = {}) {
  validateEpoch(epoch);
  if (!db) fail("invalid_store", "db");
  const existing = await db.prepare("SELECT workspace_epoch FROM workspace_meta WHERE id = 1").first();
  const used = await db.prepare("SELECT COUNT(1) AS total FROM requests").first();
  const requestCount = Number(used?.total ?? 0);
  if (!existing) {
    await db.prepare(
      `INSERT INTO workspace_meta (id, workspace_epoch, catalog_revision, protocol, api_version)
       VALUES (1, ?, 0, ?, ?)`
    ).bind(epoch, PROTOCOL, API_VERSION).run();
    return { workspaceEpoch: epoch, catalogRevision: 0, rotated: false };
  }
  if (existing.workspace_epoch === epoch) return { workspaceEpoch: epoch, rotated: false };
  // Rotating the epoch is the "full reset" switch (design §5, §13.5). It must
  // never silently strand accepted requests in the old workspace.
  if (requestCount > 0 && !force) fail("workspace_not_empty");
  await db.prepare("UPDATE workspace_meta SET workspace_epoch = ? WHERE id = 1").bind(epoch).run();
  return { workspaceEpoch: epoch, rotated: true };
}

export function createRdsStore({ db, now, epoch } = {}) {
  if (!db) fail("invalid_store", "db");
  const clock = typeof now === "function"
    ? now
    : (typeof now === "string" ? () => now : () => new Date().toISOString());
  const configuredEpoch = epoch ?? null;
  const stampNow = () => clock();

  const prepare = (text, ...args) => db.prepare(text).bind(...args);
  const firstRow = async (text, ...args) => (await prepare(text, ...args).first()) ?? null;
  const allRows = async (text, ...args) => (await prepare(text, ...args).all()).results ?? [];
  const runSql = (text, ...args) => prepare(text, ...args).run();
  const changesOf = (result) => Number(result?.meta?.changes ?? 0);

  // ---------------------------------------------------------------- metadata
  async function readWorkspace() {
    const row = await firstRow(
      "SELECT workspace_epoch, catalog_revision, protocol, api_version FROM workspace_meta WHERE id = 1"
    );
    if (!row) fail("workspace_not_initialized");
    return {
      workspaceEpoch: row.workspace_epoch,
      catalogRevision: Number(row.catalog_revision),
      protocol: row.protocol,
      apiVersion: Number(row.api_version)
    };
  }

  async function initializeWorkspace(options = {}) {
    const target = options.epoch ?? configuredEpoch;
    if (!target) fail("invalid_workspace_epoch", "missing");
    return initWorkspace(db, { epoch: target, force: options.force === true });
  }

  async function capabilities() {
    const meta = await readWorkspace();
    return {
      product: PRODUCT_NAME,
      protocol: meta.protocol,
      apiVersion: meta.apiVersion,
      workspaceEpoch: meta.workspaceEpoch,
      catalogRevision: meta.catalogRevision
    };
  }

  // ------------------------------------------------------------------ reads
  async function readNode(nodeId) {
    if (!nodeId) return null;
    return firstRow(
      `SELECT node_id, parent_id, name, kind, lifecycle, title, default_snapshot_id, revision
       FROM nodes WHERE node_id = ?`,
      nodeId
    );
  }

  async function readGate(nodeId) {
    if (!nodeId) return null;
    return firstRow(
      `SELECT node_id, request_id, frozen_catalog_revision, manifest_cursor, complete
       FROM deletion_gates WHERE node_id = ?`,
      nodeId
    );
  }

  // Walks the node and its ancestors (bounded) and reports the first row that
  // is no longer writable: a tombstone/deleting/deleted node or a deletion gate.
  async function blockedAncestor(nodeId) {
    if (!nodeId) return null;
    return firstRow(
      `WITH RECURSIVE chain(node_id, parent_id) AS (
         SELECT node_id, parent_id FROM nodes WHERE node_id = ?
         UNION ALL
         SELECT n.node_id, n.parent_id FROM nodes n JOIN chain c ON n.node_id = c.parent_id
         WHERE c.parent_id IS NOT NULL
       )
       SELECT c.node_id AS node_id, n.lifecycle AS lifecycle, g.node_id AS gate_node_id
       FROM chain c
       JOIN nodes n ON n.node_id = c.node_id
       LEFT JOIN deletion_gates g ON g.node_id = c.node_id
       WHERE n.lifecycle <> 'active' OR g.node_id IS NOT NULL
       LIMIT 1`,
      nodeId
    );
  }

  async function subtreeIds(nodeId, { limit = DELETE_PAGE_SIZE + 1, offset = 0 } = {}) {
    const rows = await allRows(
      `WITH RECURSIVE sub(node_id) AS (
         SELECT node_id FROM nodes WHERE node_id = ?
         UNION ALL
         SELECT n.node_id FROM nodes n JOIN sub s ON n.parent_id = s.node_id
       )
       SELECT node_id FROM sub ORDER BY node_id LIMIT ? OFFSET ?`,
      nodeId,
      limit,
      offset
    );
    return rows.map((row) => row.node_id);
  }

  async function resolveActivePath(path, { allowRoot = false } = {}) {
    let parentId = null;
    let last = null;
    for (const name of path) {
      const row = await firstRow(
        `SELECT node_id, parent_id, name, kind, lifecycle, revision
         FROM nodes WHERE COALESCE(parent_id, '') = ? AND name = ? AND lifecycle = 'active'`,
        parentId ?? "",
        name
      );
      if (!row) return null;
      parentId = row.node_id;
      last = row;
    }
    if (path.length === 0) return allowRoot ? { nodeId: null, path: [] } : null;
    return { ...last, nodeId: last.node_id, path: [...path] };
  }

  /** Resolves a target to an existing active node. */
  async function resolveTargetNode(target) {
    if (!target) fail("invalid_target");
    if (target.nodeId !== undefined) {
      const node = await readNode(requireNodeId(target.nodeId));
      if (!node) fail("target_not_found");
      return node;
    }
    if (target.path !== undefined) {
      const path = normalizePath(target.path);
      if (path.length === 0) fail("invalid_target", "root_target");
      const resolved = await resolveActivePath(path);
      if (!resolved) fail("target_not_found");
      return readNode(resolved.nodeId);
    }
    fail("invalid_target");
  }

  /**
   * Accept-time parent validation. A parent that is only provisionally known
   * (a create already accepted with this node id and still pending) is allowed:
   * dependent requests are accepted before their parent has been projected, and
   * the apply-time guard refuses to create under a parent that never arrived.
   */
  async function assertCreateParent(parentId, requestId) {
    if (parentId === null || parentId === undefined) return null;
    const parent = await readNode(parentId);
    if (!parent) {
      const pending = await firstRow(
        `SELECT request_id FROM requests
         WHERE target_node_id = ? AND request_id <> ?
           AND operation IN ('directory.create', 'snapshot.create') AND effect = 'pending'`,
        parentId,
        requestId
      );
      if (!pending) fail("target_not_found", "parent");
      return { provisional: true };
    }
    if (parent.lifecycle !== "active") fail("target_deleted");
    if (parent.kind === "snapshot") fail("invalid_target", "parent_is_snapshot");
    const gate = await readGate(parentId);
    if (gate) fail("target_deleted");
    const blocked = await blockedAncestor(parentId);
    if (blocked) fail("target_deleted");
    return parent;
  }

  async function siblingNamed(parentId, name, { exceptNodeId = null } = {}) {
    const row = await firstRow(
      `SELECT node_id, lifecycle FROM nodes
       WHERE COALESCE(parent_id, '') = ? AND name = ? AND lifecycle <> 'deleted'`,
      parentId ?? "",
      name
    );
    if (!row) return null;
    if (exceptNodeId && row.node_id === exceptNodeId) return null;
    return row;
  }

  async function requestRow(requestId) {
    return firstRow(
      `SELECT request_id, content_hash, operation, target_node_id, workspace_epoch, receipt_json,
              effect, target_deleted, resolved_by, created_at
       FROM requests WHERE request_id = ?`,
      requestId
    );
  }

  async function snapshotRow(nodeId) {
    return firstRow(
      "SELECT node_id, content_json, revision, updated_at FROM snapshots WHERE node_id = ?",
      nodeId
    );
  }

  function replayReceipt(row, contentHash) {
    if (row.content_hash !== contentHash) fail("request_id_conflict");
    const receipt = JSON.parse(row.receipt_json);
    return {
      ...receipt,
      effect: row.effect,
      status: "d1_committed",
      duplicate: true,
      targetDeleted: Number(row.target_deleted) === 1,
      resolvedBy: row.resolved_by ?? null
    };
  }

  // ----------------------------------------------------------------- accept
  async function accept(envelope) {
    validateRequest(envelope);
    if (!PROJECTABLE_OPERATIONS.has(envelope.operation)) {
      fail("unsupported_operation", envelope.operation);
    }
    const meta = await readWorkspace();
    if (envelope.workspaceEpoch !== meta.workspaceEpoch) fail("workspace_epoch_mismatch");
    const contentHash = await contentHashOf(envelope);
    const existing = await requestRow(envelope.requestId);
    if (existing) return replayReceipt(existing, contentHash);

    const stamp = stampNow();
    const dependsOn = envelope.dependsOn ?? [];
    await assertDependencies(envelope, dependsOn, meta);
    const target = await planAcceptTarget(envelope, meta);
    const eventId = await deriveId("evt", envelope.requestId);
    const taskId = await deriveId("tsk", envelope.requestId);
    const receipt = {
      protocol: PROTOCOL,
      apiVersion: API_VERSION,
      product: PRODUCT_NAME,
      requestId: envelope.requestId,
      status: "d1_committed",
      effect: "pending",
      operation: envelope.operation,
      targetNodeId: target.nodeId,
      targetParentId: target.parentId ?? null,
      eventId,
      taskId,
      workspaceEpoch: meta.workspaceEpoch,
      acceptedAt: stamp
    };

    const statements = [];
    if (target.tombstone) {
      // Deletion reserve marker (design §11.1): a delete for a node id the
      // server has never seen still has to prevent a late create from
      // resurrecting that identity.
      statements.push(prepare(
        `INSERT INTO nodes (node_id, parent_id, name, kind, lifecycle, revision, created_at, updated_at)
         VALUES (?, NULL, NULL, NULL, 'deleted', 0, ?, ?)`,
        target.nodeId, stamp, stamp
      ));
    } else if (target.gate) {
      statements.push(prepare(
        `UPDATE nodes SET lifecycle = 'deleting', revision = revision + 1, updated_at = ?
         WHERE node_id = ? AND lifecycle = 'active' AND revision = ?`,
        stamp, target.nodeId, target.nodeRevision
      ));
      statements.push(prepare("UPDATE workspace_meta SET catalog_revision = catalog_revision + 1 WHERE id = 1"));
    }
    statements.push(prepare(
      `INSERT INTO requests
        (request_id, content_hash, operation, target_node_id, workspace_epoch, receipt_json,
         effect, target_deleted, resolved_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?)`,
      envelope.requestId, contentHash, envelope.operation, target.nodeId,
      meta.workspaceEpoch, stableStringify(receipt), stamp
    ));
    // A replacement names the stale requests it supersedes. Old events stay
    // immutable; only their effect/status is closed, with an auditable link.
    let replacementGuardId = null;
    if (Array.isArray(envelope.replaces) && envelope.replaces.length) {
      for (const replacedId of envelope.replaces) {
        const old = await firstRow(
          "SELECT workspace_epoch, effect, operation FROM requests WHERE request_id = ?", replacedId
        );
        if (!old || old.workspace_epoch !== meta.workspaceEpoch) fail("replace_target_not_found", replacedId);
        // Only a stale, still-pending content request may be superseded. A
        // deletion control request owns an erasure gate; replacing it would
        // strand the subtree. A conflict original is immutable evidence of the
        // conflict and must stay effect=conflict.
        if (old.effect !== "pending"
          || old.operation === "directory.delete"
          || old.operation === "conflict.resolve"
          || old.operation === "task.retry") {
          fail("replace_target_not_allowed", replacedId);
        }
      }
      // Eligibility is re-proven INSIDE the atomic batch: if another caller
      // superseded these requests after our pre-check, the CHECK constraint
      // fails and the whole batch rolls back (no request/event/task remains).
      replacementGuardId = `repl_${envelope.requestId}`;
      statements.unshift(prepare(
        `INSERT INTO accept_guards (guard_id, expected, observed)
         VALUES (?, ?, (SELECT COUNT(*) FROM requests
                        WHERE request_id IN (${placeholders(envelope.replaces.length)})
                          AND workspace_epoch = ? AND effect = 'pending'
                          AND operation NOT IN ('directory.delete', 'conflict.resolve', 'task.retry')))`,
        replacementGuardId, envelope.replaces.length, ...envelope.replaces, meta.workspaceEpoch
      ));
      statements.push(prepare(
        `UPDATE requests SET effect = 'cancelled', resolved_by = ?
         WHERE request_id IN (${placeholders(envelope.replaces.length)})
           AND workspace_epoch = ? AND effect = 'pending'
           AND operation NOT IN ('directory.delete', 'conflict.resolve', 'task.retry')`,
        envelope.requestId, ...envelope.replaces, meta.workspaceEpoch
      ));
      // The superseded requests will never run; cancel their tasks so they do
      // not block the replacement as "predecessor pending" on the same node.
      statements.push(prepare(
        `UPDATE tasks SET state = 'cancelled', lease_owner = NULL, lease_until = NULL, updated_at = ?
         WHERE state IN ('pending', 'queued', 'processing')
           AND event_seq IN (SELECT event_seq FROM events
                             WHERE request_id IN (${placeholders(envelope.replaces.length)})
                               AND operation NOT IN ('directory.delete', 'conflict.resolve', 'task.retry'))`,
        stamp, ...envelope.replaces
      ));
    }
    statements.push(prepare(
      `INSERT INTO events
        (event_id, request_id, node_id, operation, base_revision, depends_on_json, request_json,
         payload_hash, target_parent_id, redacted, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      eventId, envelope.requestId, target.nodeId, envelope.operation,
      envelope.baseRevision ?? null,
      dependsOn.length ? jsonOf(dependsOn) : null,
      stableStringify(canonicalRequest(envelope)),
      await payloadHashOf(envelope),
      target.parentId ?? null,
      stamp
    ));
    statements.push(prepare(
      `INSERT INTO tasks
        (task_id, event_seq, state, lease_owner, lease_epoch, lease_until, failure_count,
         available_at, last_error, created_at, updated_at)
       SELECT ?, event_seq, 'pending', NULL, 0, NULL, 0, ?, NULL, ?, ?
       FROM events WHERE request_id = ?`,
      taskId, stamp, stamp, stamp, envelope.requestId
    ));
    if (target.gate) {
      // The gate froze membership at catalog_revision+1 for a real delete; a
      // tombstone (unknown node id) changes no structure and therefore does not
      // bump the revision.
      const frozenRevision = target.tombstone ? meta.catalogRevision : meta.catalogRevision + 1;
      const manifest = target.tombstone
        ? jsonOf({ ids: [target.nodeId], index: 1, complete: true })
        : null;
      statements.push(prepare(
        `INSERT INTO deletion_gates
          (node_id, request_id, frozen_catalog_revision, manifest_cursor, complete, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        target.nodeId, envelope.requestId, frozenRevision, manifest,
        target.tombstone ? 1 : 0, stamp
      ));
    }

    if (replacementGuardId) {
      // The guard only lives for the duration of its batch.
      statements.push(prepare("DELETE FROM accept_guards WHERE guard_id = ?", replacementGuardId));
    }

    try {
      await db.batch(statements);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const fresh = await requestRow(envelope.requestId);
      if (fresh) return replayReceipt(fresh, contentHash);
      if (/nodes/i.test(messageOf(error))) fail("target_exists");
      if (/deletion_gates/i.test(messageOf(error))) fail("target_deleted");
      fail("request_id_conflict");
    }
    return {
      requestId: envelope.requestId,
      status: "d1_committed",
      effect: "pending",
      targetNodeId: target.nodeId,
      targetParentId: target.parentId ?? null,
      eventId,
      taskId
    };
  }

  async function assertDependencies(envelope, dependsOn, meta) {
    if (dependsOn.length === 0) return;
    const rows = await allRows(
      `SELECT r.request_id, r.workspace_epoch, r.effect, r.target_deleted, e.depends_on_json
       FROM requests r
       LEFT JOIN events e ON e.request_id = r.request_id
       WHERE r.request_id IN (${placeholders(dependsOn.length)})`,
      ...dependsOn
    );
    const byId = new Map(rows.map((row) => [row.request_id, row]));
    for (const dependency of dependsOn) {
      const row = byId.get(dependency);
      if (!row) fail("dependency_missing", dependency);
      if (row.workspace_epoch !== meta.workspaceEpoch) fail("dependency_epoch_mismatch", dependency);
    }
    const lookupRequest = (id) => {
      const row = byId.get(id);
      if (!row) return null;
      return { requestId: id, dependsOn: row.depends_on_json ? JSON.parse(row.depends_on_json) : [] };
    };
    if (hasDependencyCycle(envelope.requestId, dependsOn, lookupRequest)) fail("dependency_cycle");
  }

  async function planAcceptTarget(envelope, meta) {
    const target = envelope.target ?? {};
    const operation = envelope.operation;

    if (operation === "directory.create" || operation === "snapshot.create") {
      let parentId = null;
      let name;
      if (target.path !== undefined) {
        const path = normalizePath(target.path);
        if (path.length === 0) fail("invalid_path", "empty");
        name = path.at(-1);
        // A frozen parentId is the target identity. The readable path is kept
        // for display and supplies the new node's name; it must never redirect
        // an offline request after a rename, move, delete, or same-name create.
        if (Object.hasOwn(target, "parentId")) {
          parentId = target.parentId;
          if (parentId !== null) requireNodeId(parentId);
        } else if (path.length > 1) {
          const parent = await resolveActivePath(path.slice(0, -1));
          if (!parent) fail("target_not_found", "parent");
          parentId = parent.nodeId;
        }
      } else {
        name = normalizeName(target.name);
        parentId = target.parentId ?? null;
        if (parentId !== null) requireNodeId(parentId);
      }
      // Directory creation defaults: a child of an explicit parent is a
      // directory; a root-level entry is a domain.
      const kind = operation === "snapshot.create"
        ? "snapshot"
        : (target.kind ?? (parentId === null ? "domain" : "directory"));
      if (!["domain", "directory", "snapshot"].includes(kind)) fail("invalid_target", "kind");
      if (kind === "domain" && parentId !== null) fail("invalid_target", "domain_parent");
      if (kind !== "domain" && parentId === null) fail("invalid_target", "missing_parent");
      await assertCreateParent(parentId, envelope.requestId);
      if (await siblingNamed(parentId, name)) fail("name_conflict");
      const nodeId = target.nodeId !== undefined
        ? requireNodeId(target.nodeId)
        : await deriveId("node", envelope.requestId);
      const existingNode = await readNode(nodeId);
      if (existingNode) {
        if (existingNode.lifecycle === "deleted") fail("target_deleted");
        fail("target_exists");
      }
      const pendingNode = await firstRow(
        `SELECT request_id FROM requests WHERE target_node_id = ? AND request_id <> ? AND effect = 'pending'`,
        nodeId, envelope.requestId
      );
      if (pendingNode) fail("target_exists");
      return { nodeId, parentId, kind, name, gate: false, tombstone: false };
    }

    // A delete may name a node id the server has never seen (a create whose
    // result is still unknown). It still establishes a reserve tombstone so a
    // late create cannot resurrect that identity (design §11.1, J31).
    if (operation === "directory.delete" && target.nodeId !== undefined && target.path === undefined) {
      const nodeId = requireNodeId(target.nodeId);
      const existing = await readNode(nodeId);
      if (!existing) {
        const pendingDelete = await firstRow(
          `SELECT request_id FROM requests WHERE target_node_id = ? AND request_id <> ? AND operation = 'directory.delete' AND effect = 'pending'`,
          nodeId, envelope.requestId
        );
        if (pendingDelete) fail("target_deleted");
        return { nodeId, parentId: null, gate: true, tombstone: true };
      }
    }

    const node = await resolveTargetNode(target);
    const gate = await readGate(node.node_id);
    if (node.lifecycle === "deleted" || node.lifecycle === "deleting" || gate) fail("target_deleted");
    if (await blockedAncestor(node.node_id)) fail("target_deleted");

    switch (operation) {
      case "snapshot.patch": {
        if (node.kind !== "snapshot") fail("invalid_target", "not_snapshot");
        if (!Number.isInteger(envelope.baseRevision)) fail("invalid_base_revision", "required");
        return { nodeId: node.node_id, parentId: node.parent_id ?? null, gate: false, tombstone: false };
      }
      case "snapshot.delete": {
        if (node.kind !== "snapshot") fail("invalid_target", "not_snapshot");
        return { nodeId: node.node_id, parentId: node.parent_id ?? null, gate: false, tombstone: false };
      }
      case "directory.rename": {
        if (node.kind === "snapshot") fail("invalid_target", "not_a_directory");
        const name = renameTargetName(envelope);
        const sibling = await siblingNamed(node.parent_id ?? null, name, { exceptNodeId: node.node_id });
        if (sibling) fail("name_conflict");
        return { nodeId: node.node_id, parentId: node.parent_id ?? null, gate: false, tombstone: false };
      }
      case "directory.move": {
        if (node.kind === "snapshot") fail("invalid_target", "not_a_directory");
        if (node.kind === "domain") fail("invalid_target", "cannot_move_domain");
        const newParentId = await moveParentId(envelope);
        if (newParentId === node.node_id) fail("invalid_target", "move_into_self");
        if (newParentId !== null) {
          const newParent = await readNode(newParentId);
          if (!newParent || newParent.lifecycle !== "active") fail("target_not_found", "parent");
          if (newParent.kind === "snapshot") fail("invalid_target", "parent_is_snapshot");
          if (await readGate(newParentId)) fail("target_deleted");
          const ancestor = await descendantOrSelf(newParentId, node.node_id);
          if (ancestor) fail("invalid_target", "move_into_descendant");
        }
        const sibling = await siblingNamed(newParentId, node.name, { exceptNodeId: node.node_id });
        if (sibling) fail("name_conflict");
        return { nodeId: node.node_id, parentId: newParentId, gate: false, tombstone: false };
      }
      case "directory.delete": {
        if (node.kind === "snapshot") fail("invalid_target", "not_a_directory");
        return {
          nodeId: node.node_id,
          parentId: node.parent_id ?? null,
          nodeRevision: Number(node.revision),
          gate: true,
          tombstone: false
        };
      }
      case "conflict.resolve": {
        if (node.kind !== "snapshot") fail("invalid_target", "not_snapshot");
        const open = await firstRow(
          "SELECT COUNT(1) AS total FROM conflicts WHERE node_id = ? AND status = 'open'",
          node.node_id
        );
        if (Number(open?.total ?? 0) === 0) fail("conflict_not_found");
        return { nodeId: node.node_id, parentId: node.parent_id ?? null, gate: false, tombstone: false };
      }
      default:
        fail("unsupported_operation", operation);
    }
  }

  function renameTargetName(envelope) {
    const target = envelope.target ?? {};
    if (target.name !== undefined) return normalizeName(target.name);
    const change = (envelope.changes ?? []).find(
      (item) => item.op === "set" && Array.isArray(item.path) && item.path.length === 1 && item.path[0] === "name"
    );
    if (change && typeof change.value === "string") return normalizeName(change.value);
    fail("invalid_target", "name_required");
  }

  async function moveParentId(envelope) {
    const target = envelope.target ?? {};
    if (target.parentId !== undefined) {
      return target.parentId === null ? null : requireNodeId(target.parentId);
    }
    if (target.path !== undefined) {
      const path = normalizePath(target.path);
      if (path.length === 0) return null;
      const parent = await resolveActivePath(path);
      if (!parent) fail("target_not_found", "parent");
      return parent.nodeId;
    }
    fail("invalid_target", "parent_required");
  }

  // True when candidateAncestor is the node itself or one of its descendants.
  async function descendantOrSelf(nodeId, candidateAncestor) {
    const rows = await allRows(
      `WITH RECURSIVE chain(node_id, parent_id) AS (
         SELECT node_id, parent_id FROM nodes WHERE node_id = ?
         UNION ALL
         SELECT n.node_id, n.parent_id FROM nodes n JOIN chain c ON n.node_id = c.parent_id
         WHERE c.parent_id IS NOT NULL
       )
       SELECT node_id FROM chain WHERE node_id = ? LIMIT 1`,
      nodeId,
      candidateAncestor
    );
    return rows.length > 0;
  }

  // ---------------------------------------------------------------- claiming
  async function dependencyState(event, request, meta) {
    const dependsOn = event.depends_on_json ? JSON.parse(event.depends_on_json) : [];
    if (dependsOn.length === 0) return { ready: true };
    const rows = await allRows(
      `SELECT r.request_id, r.effect, r.workspace_epoch, r.target_deleted, r.resolved_by, e.depends_on_json
       FROM requests r
       LEFT JOIN events e ON e.request_id = r.request_id
       WHERE r.request_id IN (${placeholders(dependsOn.length)})`,
      ...dependsOn
    );
    const byId = new Map(rows.map((row) => [row.request_id, row]));
    const lookupEffect = (id) => {
      const row = byId.get(id);
      if (!row) return null;
      return {
        effect: row.effect,
        workspaceEpoch: row.workspace_epoch,
        targetDeleted: Number(row.target_deleted) === 1,
        supersededBy: row.effect === "cancelled" ? row.resolved_by : null
      };
    };
    const lookupRequest = (id) => {
      const row = byId.get(id);
      if (!row) return null;
      return { requestId: id, dependsOn: row.depends_on_json ? JSON.parse(row.depends_on_json) : [] };
    };
    return classifyDependency({
      request: {
        requestId: request.request_id,
        dependsOn,
        workspaceEpoch: meta.workspaceEpoch
      },
      lookupEffect,
      lookupRequest,
      epoch: meta.workspaceEpoch
    });
  }

  async function predecessorPending(nodeId, eventSeq, taskId) {
    if (!nodeId) return false;
    const row = await firstRow(
      `SELECT COUNT(1) AS total
       FROM tasks t JOIN events e ON e.event_seq = t.event_seq
       WHERE e.node_id = ? AND t.task_id <> ? AND t.event_seq < ?
         AND t.state NOT IN ('completed', 'cancelled')`,
      nodeId, taskId, eventSeq
    );
    return Number(row?.total ?? 0) > 0;
  }

  /**
   * Claims the earliest ready task. Dependency readiness requires the real
   * applied/applied_noop effect (a D1 receipt is not enough), and a node's next
   * task waits for every earlier task of the same node (accept order per file).
   */
  /**
   * One-time dispatch handoff: the dispatcher holds the task, then releases it
   * as `queued` so a consumer can claim it. This is deliberately NOT a lease
   * takeover: a duplicate Queue message finds the task processing with an
   * unexpired lease and must fail instead of bumping the epoch under the
   * consumer that is already working.
   */
  async function queueTask({ taskId, owner, epoch, now: at } = {}) {
    if (typeof taskId !== "string" || !taskId) fail("invalid_task");
    if (typeof owner !== "string" || !owner.length) fail("invalid_owner");
    const stamp = at ?? stampNow();
    const result = await prepare(
      `UPDATE tasks SET state = 'queued', lease_owner = NULL, lease_until = NULL,
         available_at = ?, updated_at = ?
       WHERE task_id = ? AND state = 'processing' AND lease_owner = ? AND lease_epoch = ?
         AND lease_until IS NOT NULL AND lease_until > ?`,
      addSeconds(stamp, TASK_LEASE_SECONDS), stamp, taskId, owner, epoch, stamp
    ).run();
    return { queued: Number(result?.meta?.changes ?? 0) === 1 };
  }

  /** Release a handoff immediately when Queue.send fails before delivery. */
  async function releaseQueuedTask({ taskId, epoch, error = "queue_send_failed", now: at } = {}) {
    if (typeof taskId !== "string" || !taskId) fail("invalid_task");
    if (!Number.isSafeInteger(epoch) || epoch < 1) fail("invalid_task_epoch");
    const stamp = at ?? stampNow();
    const result = await prepare(
      `UPDATE tasks SET state = 'pending', available_at = ?, last_error = ?, updated_at = ?
       WHERE task_id = ? AND state = 'queued' AND lease_epoch = ?`,
      stamp, String(error).slice(0, 500), stamp, taskId, epoch
    ).run();
    return { released: Number(result?.meta?.changes ?? 0) === 1 };
  }

  /**
   * Claim ONE task named by a Queue message. Only a queued/pending task or an
   * EXPIRED processing lease may be taken over; a live lease always wins.
   */
  async function claimTaskById({ taskId, owner, now: at } = {}) {
    if (typeof taskId !== "string" || !taskId) fail("invalid_task");
    if (typeof owner !== "string" || !owner.length) fail("invalid_owner");
    const stamp = at ?? stampNow();
    const meta = await readWorkspace();
    const candidate = await firstRow(
      `SELECT t.task_id, t.event_seq, e.node_id, e.operation
       FROM tasks t JOIN events e ON e.event_seq = t.event_seq WHERE t.task_id = ?`,
      taskId
    );
    if (!candidate) return null;
    const request = await firstRow(
      `SELECT r.request_id, r.effect, r.workspace_epoch FROM requests r
       JOIN events e ON e.request_id = r.request_id WHERE e.event_seq = ?`,
      candidate.event_seq
    );
    if (!request) return null;
    const event = await firstRow("SELECT depends_on_json FROM events WHERE event_seq = ?", candidate.event_seq);
    const readiness = await dependencyState(
      { depends_on_json: event?.depends_on_json ?? null }, request, meta
    );
    if (!readiness.ready) return { blocked: true, code: readiness.code };
    if (await predecessorPending(candidate.node_id, Number(candidate.event_seq), taskId)) {
      return { blocked: true, code: "predecessor_pending" };
    }
    const leaseUntil = addSeconds(stamp, TASK_LEASE_SECONDS);
    const claimed = await prepare(
      `UPDATE tasks
       SET state = 'processing', lease_owner = ?, lease_until = ?, lease_epoch = lease_epoch + 1, updated_at = ?
       WHERE task_id = ?
         AND (state IN ('pending', 'queued')
           OR (state = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?))
       RETURNING task_id, lease_epoch, lease_until`,
      owner, leaseUntil, stamp, taskId, stamp
    ).all();
    const row = claimed.results?.[0];
    if (!row) return null;
    return {
      taskId,
      eventSeq: Number(candidate.event_seq),
      owner,
      epoch: Number(row.lease_epoch),
      leaseUntil: row.lease_until ?? leaseUntil,
      operation: candidate.operation,
      nodeId: candidate.node_id ?? null,
      dependency: readiness
    };
  }

  async function claimTask({ owner, now: at, includeQueued = true } = {}) {
    if (typeof owner !== "string" || !owner.length) fail("invalid_owner");
    const stamp = at ?? stampNow();
    const meta = await readWorkspace();
    const candidates = await allRows(
      `SELECT t.task_id, t.event_seq, t.state, t.failure_count, e.node_id, e.operation
       FROM tasks t JOIN events e ON e.event_seq = t.event_seq
       WHERE ((t.state = 'pending' AND t.available_at <= ?)
          OR (? = 1 AND t.state = 'queued' AND t.available_at <= ?)
          OR (t.state = 'processing' AND t.lease_until IS NOT NULL AND t.lease_until <= ?))
       ORDER BY t.event_seq, t.task_id LIMIT 200`,
      stamp, includeQueued ? 1 : 0, stamp, stamp
    );
    for (const candidate of candidates) {
      if (await predecessorPending(candidate.node_id, Number(candidate.event_seq), candidate.task_id)) continue;
      const request = await firstRow(
        `SELECT r.request_id, r.effect, r.workspace_epoch FROM requests r
         JOIN events e ON e.request_id = r.request_id WHERE e.event_seq = ?`,
        candidate.event_seq
      );
      const event = await firstRow(
        "SELECT depends_on_json FROM events WHERE event_seq = ?",
        candidate.event_seq
      );
      if (!request) continue;
      const readiness = await dependencyState(
        { depends_on_json: event?.depends_on_json ?? null },
        request,
        meta
      );
      if (!readiness.ready) continue;
      const leaseUntil = addSeconds(stamp, TASK_LEASE_SECONDS);
      const claimed = await prepare(
        `UPDATE tasks
         SET state = 'processing', lease_owner = ?, lease_until = ?, lease_epoch = lease_epoch + 1, updated_at = ?
         WHERE task_id = ?
           AND ((state IN ('pending', 'queued') AND available_at <= ?)
             OR (state = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?))
         RETURNING task_id, lease_epoch, lease_until`,
        owner, leaseUntil, stamp, candidate.task_id, stamp, stamp
      ).all();
      const row = claimed.results?.[0];
      if (!row) continue;
      return {
        taskId: candidate.task_id,
        eventSeq: Number(candidate.event_seq),
        owner,
        epoch: Number(row.lease_epoch),
        leaseUntil: row.lease_until ?? leaseUntil,
        operation: candidate.operation,
        nodeId: candidate.node_id ?? null,
        dependency: readiness
      };
    }
    return null;
  }

  // ------------------------------------------------------------- projection
  function guardStatement({ task, owner, epoch, stamp, nodeId = null, catalogRevision = null, snapshotRevision = null }) {
    const guardId = `grd_${task.task_id}_${epoch}`;
    return {
      guardId,
      statement: prepare(
        `INSERT INTO commit_guards
          (guard_id, task_id, owner, expected_epoch, expected_node_id,
           expected_catalog_revision, expected_snapshot_revision, now_utc, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        guardId, task.task_id, owner, epoch, nodeId, catalogRevision, snapshotRevision, stamp, stamp
      )
    };
  }

  function conflictStatements({ requestId, nodeId, baseRevision, currentRevision, conflicts, stamp }) {
    return conflicts.map((conflict, index) => prepare(
      `INSERT INTO conflicts
        (conflict_id, node_id, request_id, base_revision, current_revision, details_json, status, resolved_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', NULL, ?)`,
      `cfl_${(index).toString(16).padStart(2, "0")}_${requestId}`.slice(0, 96),
      nodeId, requestId, baseRevision ?? null, currentRevision ?? null,
      jsonOf(conflict), stamp
    ));
  }

  function completionStatements({ task, owner, epoch, requestId, stamp, effect, taskState = "completed" }) {
    return [
      prepare(
        `UPDATE requests SET effect = ? WHERE request_id = ? AND effect = 'pending'`,
        effect, requestId
      ),
      prepare(
        `UPDATE tasks SET state = ?, lease_owner = NULL, lease_until = NULL, failure_count = 0, updated_at = ?
         WHERE task_id = ? AND state = 'processing'
           AND lease_owner = ? AND lease_epoch = ? AND lease_until > ?`,
        taskState, stamp, task.task_id, owner, epoch, stamp
      )
    ];
  }

  function snapshotWriteStatements({ nodeId, contentJson, revision, existingRevision, stamp }) {
    if (existingRevision === null || existingRevision === 0) {
      return [prepare(
        `INSERT INTO snapshots (node_id, content_json, revision, updated_at) VALUES (?, ?, ?, ?)`,
        nodeId, contentJson, revision, stamp
      )];
    }
    return [prepare(
      `UPDATE snapshots SET content_json = ?, revision = ?, updated_at = ?
       WHERE node_id = ? AND revision = ?`,
      contentJson, revision, stamp, nodeId, existingRevision
    )];
  }

  function versionStatement({ nodeId, revision, contentJson, requestId, stamp }) {
    return prepare(
      `INSERT INTO snapshot_versions (node_id, revision, content_json, request_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      nodeId, revision, contentJson, requestId, stamp
    );
  }

  function catalogBumpStatement() {
    return prepare("UPDATE workspace_meta SET catalog_revision = catalog_revision + 1 WHERE id = 1");
  }

  function nodeRevisionStatement({ nodeId, revision, stamp, alsoSnapshotRevision = true }) {
    if (alsoSnapshotRevision) {
      return prepare(
        "UPDATE nodes SET revision = ?, updated_at = ? WHERE node_id = ? AND lifecycle = 'active'",
        revision, stamp, nodeId
      );
    }
    return prepare("UPDATE nodes SET updated_at = ? WHERE node_id = ?", stamp, nodeId);
  }

  function shapeSnapshot(snap) {
    if (!snap) return { revision: 0, content: null, updatedAt: null };
    return {
      revision: Number(snap.revision),
      content: JSON.parse(snap.content_json),
      updatedAt: snap.updated_at
    };
  }

  async function planProjection({ meta, stamp, task, event, request, envelope }) {
    const operation = event.operation;
    const nodeId = event.node_id;

    if (operation === "directory.create" || operation === "snapshot.create") {
      const parentId = event.target_parent_id ?? null;
      if (parentId !== null) {
        const parent = await readNode(parentId);
        if (!parent || parent.lifecycle !== "active") {
          return { kind: "terminal", effect: "cancelled", error: "target_deleted" };
        }
        if (await readGate(parentId)) return { kind: "terminal", effect: "cancelled", error: "target_deleted" };
        if (await blockedAncestor(parentId)) return { kind: "terminal", effect: "cancelled", error: "target_deleted" };
      }
      const existingNode = await readNode(nodeId);
      if (existingNode) {
        return {
          kind: "terminal",
          effect: "cancelled",
          error: existingNode.lifecycle === "deleted" ? "target_deleted" : "target_exists"
        };
      }
      // The resolved kind is not duplicated in a column: it follows from the
      // operation, the frozen parent (NULL means root) and the optional
      // explicit target.kind validated at accept time.
      const kind = operation === "snapshot.create"
        ? "snapshot"
        : (envelope.target?.kind ?? (parentId === null ? "domain" : "directory"));
      const name = envelope.target?.path !== undefined
        ? normalizeName(envelope.target.path.at(-1))
        : normalizeName(envelope.target?.name);
      const sibling = await siblingNamed(parentId, name);
      if (sibling) return { kind: "terminal", effect: "needs_attention", error: "name_conflict" };

      const statements = [prepare(
        `INSERT INTO nodes
          (node_id, parent_id, name, kind, lifecycle, title, default_snapshot_id, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', NULL, NULL, ?, ?, ?)`,
        nodeId, parentId, name, kind, operation === "snapshot.create" ? 1 : 0, stamp, stamp
      )];
      let revision = 0;
      if (kind === "snapshot") {
        let content = {};
        if (operation === "snapshot.create" && Array.isArray(envelope.changes) && envelope.changes.length) {
          const merged = applyChanges({ base: {}, current: {}, changes: envelope.changes });
          if (merged.status === "conflict") {
            return {
              kind: "terminal",
              effect: "conflict",
              conflicts: merged.conflicts,
              baseRevision: null,
              currentRevision: 0
            };
          }
          content = merged.value ?? {};
        }
        const contentJson = jsonOf(content);
        if (bytesOf(contentJson) > BUDGETS.maxSnapshotBytes) {
          return { kind: "terminal", effect: "needs_attention", error: "snapshot_too_large" };
        }
        revision = 1;
        statements.push(...snapshotWriteStatements({
          nodeId, contentJson, revision, existingRevision: null, stamp
        }));
        statements.push(versionStatement({ nodeId, revision, contentJson, requestId: event.request_id, stamp }));
        statements.push(nodeRevisionStatement({ nodeId, revision, stamp }));
      }
      statements.push(catalogBumpStatement());
      return {
        kind: "apply",
        effect: "applied",
        guard: { nodeId: parentId, catalogRevision: meta.catalogRevision, snapshotRevision: null },
        statements
      };
    }

    if (operation === "directory.rename") {
      const node = await readNode(nodeId);
      if (!node || node.lifecycle !== "active") {
        return { kind: "terminal", effect: "cancelled", error: "target_deleted" };
      }
      if (await readGate(nodeId)) return { kind: "terminal", effect: "cancelled", error: "target_deleted" };
      const name = renameTargetName(envelope);
      const sibling = await siblingNamed(node.parent_id ?? null, name, { exceptNodeId: nodeId });
      if (sibling) return { kind: "terminal", effect: "needs_attention", error: "name_conflict" };
      if (name === node.name) {
        return {
          kind: "apply",
          effect: "applied_noop",
          guard: { nodeId, catalogRevision: meta.catalogRevision, snapshotRevision: null },
          statements: []
        };
      }
      return {
        kind: "apply",
        effect: "applied",
        guard: { nodeId, catalogRevision: meta.catalogRevision, snapshotRevision: null },
        statements: [
          prepare(
            `UPDATE nodes SET name = ?, revision = revision + 1, updated_at = ?
             WHERE node_id = ? AND lifecycle = 'active' AND name = ?`,
            name, stamp, nodeId, node.name
          ),
          catalogBumpStatement()
        ]
      };
    }

    if (operation === "directory.move") {
      const node = await readNode(nodeId);
      if (!node || node.lifecycle !== "active") {
        return { kind: "terminal", effect: "cancelled", error: "target_deleted" };
      }
      if (await readGate(nodeId)) return { kind: "terminal", effect: "cancelled", error: "target_deleted" };
      // A move accepted before a deletion fence must not smuggle a member out
      // of the frozen subtree: the fence is evaluated at apply time, not at
      // accept time (design §11.2).
      if (await blockedAncestor(nodeId)) {
        return { kind: "terminal", effect: "cancelled", error: "target_deleted" };
      }
      const newParentId = event.target_parent_id ?? null;
      if (newParentId !== null) {
        const parent = await readNode(newParentId);
        if (!parent || parent.lifecycle !== "active" || parent.kind === "snapshot") {
          return { kind: "terminal", effect: "cancelled", error: "target_deleted" };
        }
        if (await readGate(newParentId)) return { kind: "terminal", effect: "cancelled", error: "target_deleted" };
        if (await blockedAncestor(newParentId)) {
          return { kind: "terminal", effect: "cancelled", error: "target_deleted" };
        }
        if (await descendantOrSelf(newParentId, nodeId)) {
          return { kind: "terminal", effect: "needs_attention", error: "move_cycle" };
        }
      }
      if ((node.parent_id ?? null) === newParentId) {
        return {
          kind: "apply",
          effect: "applied_noop",
          guard: { nodeId, catalogRevision: meta.catalogRevision, snapshotRevision: null },
          statements: []
        };
      }
      const sibling = await siblingNamed(newParentId, node.name, { exceptNodeId: nodeId });
      if (sibling) return { kind: "terminal", effect: "needs_attention", error: "name_conflict" };
      return {
        kind: "apply",
        effect: "applied",
        guard: { nodeId, catalogRevision: meta.catalogRevision, snapshotRevision: null },
        statements: [
          prepare(
            `UPDATE nodes SET parent_id = ?, revision = revision + 1, updated_at = ?
             WHERE node_id = ? AND lifecycle = 'active'`,
            newParentId, stamp, nodeId
          ),
          catalogBumpStatement()
        ]
      };
    }

    if (operation === "directory.delete") return planDirectoryDelete({ meta, stamp, task, event });

    if (operation === "snapshot.patch") return planSnapshotPatch({ meta, stamp, event, envelope });

    if (operation === "snapshot.delete") {
      const node = await readNode(nodeId);
      if (!node || node.lifecycle !== "active") {
        return { kind: "terminal", effect: "cancelled", error: "target_deleted" };
      }
      if (await readGate(nodeId)) return { kind: "terminal", effect: "cancelled", error: "target_deleted" };
      const snapshot = await snapshotRow(nodeId);
      return {
        kind: "apply",
        effect: "applied",
        guard: {
          nodeId,
          catalogRevision: meta.catalogRevision,
          snapshotRevision: snapshot ? Number(snapshot.revision) : null
        },
        statements: [
          prepare("DELETE FROM snapshots WHERE node_id = ?", nodeId),
          prepare("DELETE FROM snapshot_versions WHERE node_id = ?", nodeId),
          prepare("UPDATE conflicts SET details_json = NULL WHERE node_id = ?", nodeId),
          prepare(
            `UPDATE nodes SET lifecycle = 'deleted', revision = revision + 1, updated_at = ?
             WHERE node_id = ? AND lifecycle = 'active'`,
            stamp, nodeId
          ),
          catalogBumpStatement()
        ]
      };
    }

    if (operation === "conflict.resolve") return planConflictResolve({ meta, stamp, event, envelope });

    return { kind: "terminal", effect: "needs_attention", error: "unsupported_operation" };
  }

  async function planSnapshotPatch({ meta, stamp, event, envelope, resolution = false }) {
    const nodeId = event.node_id;
    const node = await readNode(nodeId);
    if (!node || node.lifecycle !== "active") {
      return { kind: "terminal", effect: "cancelled", error: "target_deleted" };
    }
    if (node.kind !== "snapshot") return { kind: "terminal", effect: "needs_attention", error: "not_a_snapshot" };
    if (await readGate(nodeId)) return { kind: "terminal", effect: "cancelled", error: "target_deleted" };
    if (await blockedAncestor(nodeId)) return { kind: "terminal", effect: "cancelled", error: "target_deleted" };

    const snapshot = await snapshotRow(nodeId);
    const currentRevision = snapshot ? Number(snapshot.revision) : 0;
    const current = snapshot ? JSON.parse(snapshot.content_json) : {};
    const changes = envelope.changes ?? [];

    let base = current;
    if (!resolution) {
      const baseRevision = Number(event.base_revision);
      if (baseRevision === currentRevision) {
        base = current;
      } else {
        const baseRow = await firstRow(
          "SELECT content_json FROM snapshot_versions WHERE node_id = ? AND revision = ?",
          nodeId, baseRevision
        );
        if (!baseRow) {
          return { kind: "terminal", effect: "needs_attention", error: "base_revision_missing" };
        }
        base = JSON.parse(baseRow.content_json);
      }
    }

    let merged;
    try {
      merged = applyChanges({ base, current, changes });
    } catch (error) {
      return { kind: "terminal", effect: "needs_attention", error: error.code ?? "invalid_changes" };
    }
    if (merged.status === "conflict") {
      return {
        kind: "terminal",
        effect: "conflict",
        conflicts: merged.conflicts,
        baseRevision: resolution ? currentRevision : Number(event.base_revision),
        currentRevision
      };
    }
    if (merged.status === "applied_noop") {
      return {
        kind: "apply",
        effect: "applied_noop",
        guard: {
          nodeId,
          catalogRevision: meta.catalogRevision,
          snapshotRevision: snapshot ? currentRevision : null
        },
        statements: []
      };
    }
    const contentJson = jsonOf(merged.value ?? {});
    if (bytesOf(contentJson) > BUDGETS.maxSnapshotBytes) {
      return { kind: "terminal", effect: "needs_attention", error: "snapshot_too_large" };
    }
    const revision = currentRevision + 1;
    return {
      kind: "apply",
      effect: "applied",
      guard: {
        nodeId,
        catalogRevision: meta.catalogRevision,
        snapshotRevision: snapshot ? currentRevision : null
      },
      statements: [
        ...snapshotWriteStatements({
          nodeId, contentJson, revision,
          existingRevision: snapshot ? currentRevision : null,
          stamp
        }),
        versionStatement({ nodeId, revision, contentJson, requestId: event.request_id, stamp }),
        nodeRevisionStatement({ nodeId, revision, stamp })
      ]
    };
  }

  async function planConflictResolve({ meta, stamp, event, envelope }) {
    const nodeId = event.node_id;
    const open = await allRows(
      `SELECT conflict_id, request_id, details_json FROM conflicts
       WHERE node_id = ? AND status = 'open'`,
      nodeId
    );
    if (open.length === 0) return { kind: "terminal", effect: "needs_attention", error: "conflict_not_found" };

    // A resolution is an ordinary version-checked write: it must use the
    // revision the user saw. If the file moved on, this becomes a fresh
    // conflict instead of overwriting the newer value. A caller that states no
    // revision is resolving against what it just read (current revision).
    let effectiveEvent = event;
    if (event.base_revision === null || event.base_revision === undefined) {
      const snapshot = await snapshotRow(nodeId);
      effectiveEvent = { ...event, base_revision: snapshot ? Number(snapshot.revision) : 0 };
    }
    const plan = await planSnapshotPatch({ meta, stamp, event: effectiveEvent, envelope });
    if (plan.kind !== "apply") return plan;

    const overlap = (left, right) => {
      if (left.length === 0 || right.length === 0) return left.length === right.length;
      const length = Math.min(left.length, right.length);
      for (let index = 0; index < length; index += 1) {
        if (left[index] !== right[index]) return false;
      }
      return true;
    };
    // Effective changed paths: item operations touch field/itemId, so a
    // collection conflict is only addressed by a change to that same item.
    const changed = (envelope.changes ?? []).map((change) => {
      if (change.op === "item_set" || change.op === "item_remove") {
        return [...(change.path ?? []), change.field, change.itemId];
      }
      return change.path ?? [];
    });
    const explicit = Array.isArray(envelope.conflictIds) ? new Set(envelope.conflictIds) : null;
    const addressed = open.filter((conflict) => {
      if (explicit) return explicit.has(conflict.conflict_id);
      let details = [];
      try {
        const parsed = JSON.parse(conflict.details_json ?? "null");
        details = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
      } catch {
        details = [];
      }
      const paths = Array.isArray(details)
        ? details.map((detail) => (Array.isArray(detail?.path) ? detail.path : [])).filter((path) => path.length)
        : [];
      // No locatable path: never close it implicitly.
      if (paths.length === 0) return false;
      return paths.some((path) => changed.some((change) => overlap(path, change)));
    });
    if (addressed.length === 0) return plan;

    const conflictIds = addressed.map((conflict) => conflict.conflict_id);
    const requestIds = [...new Set(addressed.map((conflict) => conflict.request_id))];
    return {
      ...plan,
      statements: [
        ...plan.statements,
        prepare(
          `UPDATE conflicts SET status = 'resolved', resolved_by = ?
           WHERE conflict_id IN (${placeholders(conflictIds.length)}) AND status = 'open'`,
          event.request_id, ...conflictIds
        ),
        prepare(
          `UPDATE requests SET resolved_by = ?
           WHERE request_id IN (${placeholders(requestIds.length)}) AND resolved_by IS NULL`,
          event.request_id, ...requestIds
        )
      ]
    };
  }

  async function planDirectoryDelete({ meta, stamp, task, event }) {
    const nodeId = event.node_id;
    const gate = await readGate(nodeId);
    const node = await readNode(nodeId);
    if (!gate) {
      if (node && node.lifecycle === "deleted") return { kind: "terminal", effect: "applied" };
      return { kind: "terminal", effect: "needs_attention", error: "gate_missing" };
    }
    // A delete accepted before the node ever existed: the reserve marker is
    // already a tombstone, nothing to clean.
    if (Number(gate.complete) === 1 && node && node.lifecycle === "deleted") {
      return { kind: "terminal", effect: "applied" };
    }
    if (!node) return { kind: "terminal", effect: "needs_attention", error: "gate_node_missing" };
    if (node.lifecycle !== "deleting") {
      return { kind: "terminal", effect: "needs_attention", error: "gate_node_not_deleting" };
    }

    const cursor = gate.manifest_cursor ? JSON.parse(gate.manifest_cursor) : null;
    const start = Number(cursor?.offset ?? cursor?.index ?? 0);
    if (!Number.isSafeInteger(start) || start < 0) {
      return { kind: "terminal", effect: "needs_attention", error: "manifest_cursor_invalid" };
    }
    // Legacy serialized ID cursors remain readable, but new deletions only
    // fetch one bounded keyset page at a time. The gate prevents membership
    // changes while this deterministic node_id order is traversed.
    const candidates = Array.isArray(cursor?.ids)
      ? cursor.ids.slice(start, start + DELETE_PAGE_SIZE + 1)
      : await subtreeIds(nodeId, { limit: DELETE_PAGE_SIZE + 1, offset: start });
    const page = candidates.slice(0, DELETE_PAGE_SIZE);
    const hasMore = candidates.length > DELETE_PAGE_SIZE;
    const nextIndex = start + page.length;
    const isLast = !hasMore;
    const statements = [];

    if (page.length) {
      const list = placeholders(page.length);
      statements.push(prepare(`DELETE FROM snapshots WHERE node_id IN (${list})`, ...page));
      statements.push(prepare(`DELETE FROM snapshot_versions WHERE node_id IN (${list})`, ...page));
      statements.push(prepare(`UPDATE conflicts SET details_json = NULL WHERE node_id IN (${list})`, ...page));
      // Events keep identity/dedupe columns but lose the frozen request body.
      // The deletion control event itself is excluded: it must survive so the
      // deletion can still be propagated (design §11.1.1/§11.1.6). Pending
      // creations that never materialised are matched by their frozen parent
      // so their bodies cannot survive the delete.
      statements.push(prepare(
        `UPDATE events SET redacted = 1, request_json = NULL
         WHERE request_id <> ? AND redacted = 0
           AND (node_id IN (${list}) OR target_parent_id IN (${list}))`,
        event.request_id, ...page, ...page
      ));
    }

    const nextCursor = jsonOf({ offset: nextIndex, complete: isLast });
    statements.push(prepare(
      "UPDATE deletion_gates SET manifest_cursor = ?, complete = ? WHERE node_id = ?",
      nextCursor, isLast ? 1 : 0, nodeId
    ));

    if (!isLast) {
      // Persisted continuation: the next apply pass resumes at nextIndex.
      statements.push(prepare(
        `UPDATE tasks SET state = 'pending', lease_owner = NULL, lease_until = NULL,
           available_at = ?, updated_at = ?
         WHERE task_id = ? AND state = 'processing' AND lease_owner = ? AND lease_epoch = ? AND lease_until > ?`,
        stamp, stamp, task.task_id, task.lease_owner, task.lease_epoch, stamp
      ));
      return { kind: "apply", effect: "pending", guard: { nodeId, catalogRevision: meta.catalogRevision }, statements };
    }

    // Final page: mark every member deleted, clear residual bodies, cancel the
    // subtree's outstanding requests/tasks and publish the applied effect.
    statements.push(prepare(
      `UPDATE nodes SET lifecycle = 'deleted', revision = revision + 1, updated_at = ?
       WHERE node_id = ? AND lifecycle = 'deleting'`,
      stamp, nodeId
    ));
    statements.push(catalogBumpStatement());
    statements.push(prepare(
      `WITH RECURSIVE sub(node_id) AS (
         SELECT node_id FROM nodes WHERE node_id = ?
         UNION ALL
         SELECT n.node_id FROM nodes n JOIN sub s ON n.parent_id = s.node_id
       )
       UPDATE tasks SET state = 'cancelled', lease_owner = NULL, lease_until = NULL, updated_at = ?
       WHERE task_id <> ? AND state IN ('pending', 'queued', 'processing')
         AND event_seq IN (SELECT e.event_seq FROM events e
                           WHERE e.node_id IN (SELECT node_id FROM sub)
                              OR e.target_parent_id IN (SELECT node_id FROM sub))`,
      nodeId, stamp, task.task_id
    ));
    statements.push(prepare(
      `WITH RECURSIVE sub(node_id) AS (
         SELECT node_id FROM nodes WHERE node_id = ?
         UNION ALL
         SELECT n.node_id FROM nodes n JOIN sub s ON n.parent_id = s.node_id
       )
       UPDATE requests SET effect = 'cancelled', target_deleted = 1
       WHERE request_id <> ? AND effect = 'pending'
         AND request_id IN (SELECT e.request_id FROM events e
                            WHERE e.node_id IN (SELECT node_id FROM sub)
                               OR e.target_parent_id IN (SELECT node_id FROM sub))`,
      nodeId, event.request_id
    ));
    return { kind: "apply", effect: "applied", guard: { nodeId, catalogRevision: meta.catalogRevision }, statements };
  }

  async function applyOne({ taskId, owner, epoch } = {}) {
    if (typeof taskId !== "string" || !taskId) fail("invalid_task");
    if (typeof owner !== "string" || !owner.length) fail("invalid_owner");
    const task = await firstRow(
      `SELECT task_id, event_seq, state, lease_owner, lease_epoch, lease_until, failure_count
       FROM tasks WHERE task_id = ?`,
      taskId
    );
    if (!task) return { ok: false, code: "task_not_found" };
    // The JavaScript check is only a fast path: the commit guard trigger is the
    // authority for owner, lease_epoch and expiry, so a stale caller still runs
    // into a database-level abort below (and cannot write anything).
    if (task.state !== "processing") return { ok: false, code: "lease_not_held", stale: true };
    const leaseEpoch = epoch ?? Number(task.lease_epoch);
    const stamp = stampNow();
    const event = await firstRow(
      `SELECT event_seq, event_id, request_id, node_id, operation, base_revision,
              depends_on_json, request_json, target_parent_id, redacted
       FROM events WHERE event_seq = ?`,
      task.event_seq
    );
    if (!event) return { ok: false, code: "event_missing" };
    if (Number(event.redacted) === 1 || event.request_json === null) {
      // A redacted event is never rebuilt into content (design §11.1.6, J34).
      const closed = await closeTask({
        task, owner, epoch: leaseEpoch, stamp,
        effect: REDACTED_EVENT_CLOSED_EFFECT, taskState: "cancelled", error: "event_redacted"
      });
      return { ok: closed, code: closed ? "redacted_event" : "stale_commit", effect: REDACTED_EVENT_CLOSED_EFFECT };
    }
    const request = await firstRow(
      `SELECT request_id, content_hash, operation, target_node_id, workspace_epoch, receipt_json,
              effect, target_deleted, resolved_by
       FROM requests WHERE request_id = ?`,
      event.request_id
    );
    if (!request) return { ok: false, code: "request_missing" };
    if (request.effect !== "pending") {
      // Already projected (Queue duplicate delivery): close the duplicate task
      // without a second business effect.
      const closed = await closeTask({
        task, owner, epoch: leaseEpoch, stamp,
        effect: request.effect, taskState: "completed", error: null
      });
      return { ok: closed, code: "already_applied", effect: request.effect };
    }

    const meta = await readWorkspace();
    const envelope = JSON.parse(event.request_json);
    const plan = await planProjection({ meta, stamp, task, event, request, envelope });

    if (plan.kind === "defer") {
      await deferTask({ task, owner, epoch: leaseEpoch, stamp, seconds: plan.delaySeconds ?? 30 });
      return { ok: false, code: plan.code, deferred: true };
    }

    const guard = guardStatement({
      task, owner, epoch: leaseEpoch, stamp,
      nodeId: plan.kind === "apply" ? plan.guard.nodeId ?? null : null,
      catalogRevision: plan.kind === "apply" ? plan.guard.catalogRevision ?? null : null,
      snapshotRevision: plan.kind === "apply" ? plan.guard.snapshotRevision ?? null : null
    });
    const statements = [guard.statement];
    if (plan.kind === "terminal" && plan.conflicts) {
      statements.push(...conflictStatements({
        requestId: event.request_id,
        nodeId: event.node_id,
        baseRevision: plan.baseRevision ?? null,
        currentRevision: plan.currentRevision ?? null,
        conflicts: plan.conflicts,
        stamp
      }));
    }
    if (plan.kind === "apply") statements.push(...plan.statements);
    if (plan.kind === "terminal") {
      const taskState = plan.effect === "needs_attention" ? "needs_attention"
        : (plan.effect === "cancelled" ? "cancelled" : "completed");
      statements.push(...completionStatements({
        task, owner, epoch: leaseEpoch, requestId: event.request_id, stamp,
        effect: plan.effect, taskState
      }));
    } else if (plan.effect !== "pending") {
      statements.push(...completionStatements({
        task, owner, epoch: leaseEpoch, requestId: event.request_id, stamp, effect: plan.effect
      }));
    }
    statements.push(prepare("DELETE FROM commit_guards WHERE guard_id = ?", guard.guardId));

    try {
      await db.batch(statements);
    } catch (error) {
      return handleCommitFailure({
        error, task, owner, epoch: leaseEpoch, stamp,
        requestId: event.request_id, operation: event.operation
      });
    }
    return {
      ok: true,
      effect: plan.effect,
      taskId: task.task_id,
      requestId: event.request_id,
      deferred: plan.effect === "pending"
    };
  }

  async function handleCommitFailure({ error, task, owner, epoch, stamp, requestId, operation }) {
    const reason = guardAbortReason(error);
    if (reason) {
      const held = await taskHeldBy(task.task_id, owner, epoch);
      if (!held) return { ok: false, code: "stale_commit", reason };
      await deferTask({ task, owner, epoch, stamp, seconds: 30 });
      return { ok: false, code: "stale_commit", reason, deferred: true };
    }
    if (isUniqueViolation(error)) {
      const fresh = await requestRow(requestId);
      if (fresh && fresh.effect !== "pending") {
        const closed = await closeTask({
          task, owner, epoch, stamp, effect: fresh.effect, taskState: "completed", error: null
        });
        return { ok: closed, code: "already_applied", effect: fresh.effect };
      }
      const terminal = await closeTask({
        task, owner, epoch, stamp,
        effect: "needs_attention", taskState: "needs_attention",
        error: uniqueReason(error, operation)
      });
      return { ok: false, code: "unique_conflict", reason: uniqueReason(error, operation), closed: terminal };
    }
    const failures = Number(task.failure_count ?? 0) + 1;
    if (failures >= FAILURE_COUNT_THRESHOLD) {
      const closed = await closeTask({
        task, owner, epoch, stamp,
        effect: "needs_attention", taskState: "needs_attention", error: messageOf(error).slice(0, 500)
      });
      return { ok: false, code: "needs_attention", closed };
    }
    const backoff = FAILURE_BACKOFF_SECONDS[Math.min(failures - 1, FAILURE_BACKOFF_SECONDS.length - 1)];
    await prepare(
      `UPDATE tasks SET state = 'pending', lease_owner = NULL, lease_until = NULL,
         failure_count = ?, available_at = ?, last_error = ?, updated_at = ?
       WHERE task_id = ? AND state = 'processing' AND lease_owner = ? AND lease_epoch = ? AND lease_until > ?`,
      failures, addSeconds(stamp, backoff), messageOf(error).slice(0, 500), stamp,
      task.task_id, owner, epoch, stamp
    ).run();
    return { ok: false, code: "commit_failed", error: messageOf(error), retryInSeconds: backoff };
  }

  function uniqueReason(error, operation) {
    const message = messageOf(error);
    if (message.includes("nodes_sibling_name_unique")) return "name_conflict";
    if (message.includes("snapshot_versions")) return "snapshot_version_conflict";
    if (message.includes("nodes.")) return "node_identity_conflict";
    return `${operation ?? "operation"}_conflict`;
  }

  async function taskHeldBy(taskId, owner, epoch) {
    const row = await firstRow(
      `SELECT task_id FROM tasks WHERE task_id = ? AND state = 'processing'
         AND lease_owner = ? AND lease_epoch = ? AND lease_until > ?`,
      taskId, owner, epoch, stampNow()
    );
    return Boolean(row);
  }

  async function deferTask({ task, owner, epoch, stamp, seconds }) {
    await prepare(
      `UPDATE tasks SET state = 'pending', lease_owner = NULL, lease_until = NULL,
         available_at = ?, updated_at = ?
       WHERE task_id = ? AND state = 'processing'
         AND lease_owner = ? AND lease_epoch = ? AND lease_until > ?`,
      addSeconds(stamp, seconds), stamp, task.task_id, owner, epoch, stamp
    ).run();
  }

  /**
   * A terminal (non-effect) outcome still needs the lease guard, so a stale
   * owner cannot even record a failure. The guard carries no node/revision
   * expectations: recording a conflict/cancel is not a content write.
   */
  async function closeTask({ task, owner, epoch, stamp, effect, taskState, error }) {
    const event = await firstRow(
      "SELECT request_id FROM events WHERE event_seq = ?", task.event_seq
    );
    if (!event) return false;
    const guard = guardStatement({ task, owner, epoch, stamp });
    const statements = [guard.statement];
    if (error) {
      statements.push(prepare(
        "UPDATE tasks SET last_error = ? WHERE task_id = ?",
        String(error).slice(0, 500), task.task_id
      ));
    }
    statements.push(...completionStatements({
      task, owner, epoch, requestId: event.request_id, stamp, effect, taskState
    }));
    statements.push(prepare("DELETE FROM commit_guards WHERE guard_id = ?", guard.guardId));
    try {
      await db.batch(statements);
      return true;
    } catch {
      return false;
    }
  }

  async function projectAll({ owner, maxTasks = 100 } = {}) {
    if (typeof owner !== "string" || !owner.length) fail("invalid_owner");
    const results = [];
    for (let index = 0; index < maxTasks; index += 1) {
      const lease = await claimTask({ owner });
      if (!lease) break;
      const outcome = await applyOne({ taskId: lease.taskId, owner, epoch: lease.epoch });
      results.push({ ...lease, ...outcome });
      if (!outcome.ok && !outcome.deferred && outcome.code === "lease_not_held") break;
    }
    return { processed: results.length, results };
  }

  // ------------------------------------------------------------ admin/query
  async function retryTask({ taskId, reason = "admin_retry" } = {}) {
    if (typeof taskId !== "string" || !taskId) fail("invalid_task");
    const stamp = stampNow();
    const target = await firstRow(
      `SELECT e.request_id FROM tasks t JOIN events e ON e.event_seq = t.event_seq
       WHERE t.task_id = ? AND t.state = 'needs_attention'`,
      taskId
    );
    if (!target) fail("task_not_retryable");
    const guardId = await deriveId("retry", taskId, stamp, Math.random());
    try {
      await db.batch([
        prepare(
          `INSERT INTO task_retry_guards (guard_id, expected, observed)
           VALUES (?, 1, (SELECT COUNT(*) FROM tasks t JOIN events e ON e.event_seq = t.event_seq
                          JOIN requests r ON r.request_id = e.request_id
                          WHERE t.task_id = ? AND t.state = 'needs_attention' AND r.effect = 'needs_attention'))`,
          guardId, taskId
        ),
        prepare(
          `UPDATE tasks
           SET state = 'pending', lease_owner = NULL, lease_until = NULL,
             lease_epoch = lease_epoch + 1, failure_count = 0, available_at = ?,
             last_error = ?, updated_at = ?
           WHERE task_id = ? AND state = 'needs_attention'`,
          stamp, String(reason).slice(0, 500), stamp, taskId
        ),
        prepare("UPDATE requests SET effect = 'pending' WHERE request_id = ? AND effect = 'needs_attention'", target.request_id),
        prepare("DELETE FROM task_retry_guards WHERE guard_id = ?", guardId)
      ]);
    } catch (error) {
      if (/CHECK constraint failed|UNIQUE constraint failed/i.test(messageOf(error))) {
        fail("task_not_retryable");
      }
      throw error;
    }
    return { taskId, state: "pending", retriedAt: stamp };
  }

  async function taskStatus(options = {}) {
    const taskId = typeof options === "string" ? options : options.taskId;
    const row = await firstRow(
      `SELECT t.task_id, t.event_seq, t.state, t.lease_owner, t.lease_epoch, t.lease_until,
              t.failure_count, t.available_at, t.last_error, t.created_at, t.updated_at,
              e.operation, e.node_id, e.request_id
       FROM tasks t LEFT JOIN events e ON e.event_seq = t.event_seq
       WHERE t.task_id = ?`,
      taskId
    );
    if (!row) fail("task_not_found");
    return {
      taskId: row.task_id,
      eventSeq: Number(row.event_seq),
      state: row.state,
      operation: row.operation,
      nodeId: row.node_id,
      requestId: row.request_id,
      leaseOwner: row.lease_owner,
      leaseEpoch: Number(row.lease_epoch),
      leaseUntil: row.lease_until,
      failureCount: Number(row.failure_count),
      availableAt: row.available_at,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  async function requestStatus(options = {}) {
    // Accepts either { requestId } or a bare requestId (the Worker route passes
    // params.requestId directly).
    const requestId = typeof options === "string" ? options : options.requestId;
    const row = await requestRow(requestId);
    if (!row) fail("request_not_found");
    const event = await firstRow(
      `SELECT event_seq, node_id, operation, base_revision, depends_on_json, redacted, created_at
       FROM events WHERE request_id = ?`,
      requestId
    );
    const meta = await readWorkspace();
    const dependsOn = event?.depends_on_json ? JSON.parse(event.depends_on_json) : [];
    let dependency = { ready: true };
    if (dependsOn.length) {
      dependency = await dependencyState({ depends_on_json: event.depends_on_json }, row, meta);
    }
    return {
      requestId: row.request_id,
      status: "d1_committed",
      effect: row.effect,
      operation: row.operation,
      targetNodeId: row.target_node_id,
      targetDeleted: Number(row.target_deleted) === 1,
      resolvedBy: row.resolved_by,
      supersededBy: row.effect === "cancelled" ? row.resolved_by : null,
      workspaceEpoch: row.workspace_epoch,
      eventSeq: event ? Number(event.event_seq) : null,
      eventRedacted: Number(event?.redacted ?? 0) === 1,
      dependsOn,
      dependency,
      receipt: JSON.parse(row.receipt_json),
      createdAt: row.created_at
    };
  }

  async function conflictList({ nodeId = null, requestId = null, status = "open" } = {}) {
    const conditions = ["status = ?"];
    const args = [status];
    if (nodeId) {
      conditions.push("node_id = ?");
      args.push(nodeId);
    }
    if (requestId) {
      conditions.push("request_id = ?");
      args.push(requestId);
    }
    const rows = await allRows(
      `SELECT conflict_id, node_id, request_id, base_revision, current_revision, details_json,
              status, resolved_by, created_at
       FROM conflicts WHERE ${conditions.join(" AND ")} ORDER BY created_at, conflict_id`,
      ...args
    );
    return {
      conflicts: rows.map((row) => ({
        conflictId: row.conflict_id,
        nodeId: row.node_id,
        requestId: row.request_id,
        baseRevision: row.base_revision === null ? null : Number(row.base_revision),
        currentRevision: row.current_revision === null ? null : Number(row.current_revision),
        details: row.details_json ? JSON.parse(row.details_json) : null,
        status: row.status,
        resolvedBy: row.resolved_by,
        createdAt: row.created_at
      }))
    };
  }

  async function deletionManifest({ requestId, cursor = null, limit = 50 } = {}) {
    if (typeof requestId !== "string" || !requestId) fail("invalid_request_id");
    const gate = await firstRow(
      `SELECT node_id, request_id, frozen_catalog_revision, manifest_cursor, complete
       FROM deletion_gates WHERE request_id = ?`,
      requestId
    );
    if (!gate) fail("deletion_not_found");
    const size = Math.min(Math.max(Number(limit) || 20, 1), BUDGETS.maxPageSize);
    let offset = 0;
    if (cursor !== null) {
      const parsed = decodeCursor(cursor);
      if (parsed.op !== "deletion.manifest"
        || parsed.requestId !== requestId
        || parsed.frozenCatalogRevision !== Number(gate.frozen_catalog_revision)) {
        fail("cursor_stale");
      }
      offset = parsed.offset;
    }
    if (!Number.isSafeInteger(offset) || offset < 0) fail("cursor_invalid");
    const candidates = await subtreeIds(gate.node_id, { limit: size + 1, offset });
    const nodes = candidates.slice(0, size);
    const hasMore = candidates.length > size;
    const next = offset + nodes.length;
    return {
      requestId,
      nodeId: gate.node_id,
      frozenCatalogRevision: Number(gate.frozen_catalog_revision),
      complete: Number(gate.complete) === 1,
      waiting: false,
      enumerationComplete: !hasMore,
      nodes,
      nextCursor: hasMore
        ? encodeCursor({
          op: "deletion.manifest",
          requestId,
          frozenCatalogRevision: Number(gate.frozen_catalog_revision),
          offset: next
        })
        : null
    };
  }

  async function listDirectory({ parentId = null, page = 0, limit = 20, cursor = null } = {}) {
    const meta = await readWorkspace();
    const size = Math.min(Math.max(Number(limit) || 20, 1), BUDGETS.maxPageSize);
    if (parentId !== null) {
      const parent = await readNode(parentId);
      if (!parent) fail("target_not_found");
      if (parent.lifecycle !== "active") fail("target_deleted");
      if (await blockedAncestor(parentId)) fail("target_deleted");
    }
    let offset = Math.max(Number(page) || 0, 0) * size;
    let after = null;
    if (cursor) {
      const parsed = decodeCursor(cursor);
      if (parsed.catalogRevision !== meta.catalogRevision) fail("cursor_stale");
      if ((parsed.parentId ?? null) !== (parentId ?? null)) fail("cursor_stale");
      after = parsed.after ?? null;
      offset = 0;
    }
    const args = [parentId ?? ""];
    let where = "COALESCE(parent_id, '') = ? AND lifecycle = 'active'";
    if (after !== null) {
      where += " AND name > ?";
      args.push(after);
    }
    args.push(size, offset);
    const result = await prepare(
      `SELECT node_id, parent_id, name, kind, lifecycle, revision
       FROM nodes WHERE ${where} ORDER BY name LIMIT ? OFFSET ?`,
      ...args
    ).all();
    const rows = result.results ?? [];
    const nodes = rows.map((row) => ({
      nodeId: row.node_id,
      parentId: row.parent_id,
      name: row.name,
      kind: row.kind,
      lifecycle: row.lifecycle,
      revision: Number(row.revision)
    }));
    const last = nodes.at(-1);
    const nextCursor = rows.length === size && last
      ? encodeCursor({ parentId: parentId ?? null, catalogRevision: meta.catalogRevision, after: last.name })
      : null;
    return {
      catalogRevision: meta.catalogRevision,
      parentId: parentId ?? null,
      nodes,
      cursor: nextCursor,
      nextCursor,
      complete: rows.length < size,
      page: Math.floor(offset / size),
      pageSize: size,
      rowsRead: Number(result.meta?.rows_read ?? rows.length)
    };
  }

  async function resolvePath(path) {
    const meta = await readWorkspace();
    const normalized = normalizePath(path);
    if (normalized.length === 0) {
      return { nodeId: null, parentId: null, kind: "root", path: [], revision: 0, catalogRevision: meta.catalogRevision };
    }
    const resolved = await resolveActivePath(normalized);
    if (!resolved) fail("target_not_found");
    if (await blockedAncestor(resolved.nodeId)) fail("target_deleted");
    return {
      nodeId: resolved.nodeId,
      parentId: resolved.parent_id ?? null,
      name: resolved.name,
      kind: resolved.kind,
      lifecycle: resolved.lifecycle,
      revision: Number(resolved.revision),
      path: normalized,
      catalogRevision: meta.catalogRevision
    };
  }

  async function readSnapshot({ nodeId, requiredRequestId = null } = {}) {
    const meta = await readWorkspace();
    const node = await readNode(nodeId);
    if (!node || node.lifecycle === "deleted") fail("target_deleted");
    if (node.lifecycle === "deleting") fail("target_deleted");
    if (node.kind !== "snapshot") fail("invalid_target", "not_snapshot");
    if (await blockedAncestor(nodeId)) fail("target_deleted");
    const snap = await snapshotRow(nodeId);
    const snapshot = shapeSnapshot(snap);
    if (!requiredRequestId) {
      return {
        nodeId,
        revision: snapshot.revision,
        content: snapshot.content,
        snapshot,
        waiting: false,
        effect: null,
        stale: false,
        catalogRevision: meta.catalogRevision,
        updatedAt: snapshot.updatedAt
      };
    }
    const request = await requestRow(requiredRequestId);
    if (!request) fail("request_not_found");
    const applied = request.effect === "applied" || request.effect === "applied_noop";
    return {
      nodeId,
      revision: snapshot.revision,
      content: snapshot.content,
      snapshot,
      waiting: !applied,
      effect: request.effect,
      // The old snapshot is explicitly marked as not containing this request.
      stale: !applied,
      catalogRevision: meta.catalogRevision,
      updatedAt: snapshot.updatedAt
    };
  }

  /**
   * Subtree metadata query (design §6.3): no snapshot body is read. The
   * returned rowsRead/contentRead evidence is what J03 checks.
   */
  async function snapshotQuery({ nodeId, path, limit = 50, cursor = null } = {}) {
    const meta = await readWorkspace();
    let rootId = nodeId ?? null;
    if (!rootId && path !== undefined) {
      const resolved = await resolvePath(path);
      rootId = resolved.nodeId;
    }
    if (!rootId) fail("invalid_target");
    const root = await readNode(rootId);
    if (!root || root.lifecycle === "deleted") fail("target_deleted");
    if (await blockedAncestor(rootId)) fail("target_deleted");

    // A cursor is bound to the tree version it was issued for: a page from an
    // older catalog revision must be re-read, never stitched together.
    let after = null;
    if (cursor !== null && cursor !== undefined) {
      const payload = decodeCursor(cursor);
      if (payload.op !== "snapshot.query" || payload.root !== rootId) fail("cursor_invalid");
      if (Number(payload.catalogRevision) !== Number(meta.catalogRevision)) fail("cursor_stale");
      after = typeof payload.after === "string" ? payload.after : null;
    }

    const size = Math.min(Math.max(Number(limit) || 20, 1), BUDGETS.maxPageSize);
    const result = await prepare(
      `WITH RECURSIVE sub(node_id) AS (
         SELECT node_id FROM nodes WHERE node_id = ?
         UNION ALL
         SELECT n.node_id FROM nodes n JOIN sub s ON n.parent_id = s.node_id
       )
       SELECT n.node_id, n.parent_id, n.name, n.kind, n.lifecycle, n.revision
       FROM nodes n JOIN sub ON sub.node_id = n.node_id
       WHERE n.lifecycle <> 'deleted' AND (? IS NULL OR n.node_id > ?)
       ORDER BY n.node_id LIMIT ?`,
      rootId, after, after, size + 1
    ).all();
    const fetched = result.results ?? [];
    const rows = fetched.slice(0, size);
    let nextCursor = null;
    if (fetched.length > size) {
      nextCursor = encodeCursor({
        op: "snapshot.query",
        root: rootId,
        after: rows.at(-1)?.node_id ?? after,
        catalogRevision: meta.catalogRevision
      });
    }
    return {
      catalogRevision: meta.catalogRevision,
      root: {
        nodeId: root.node_id,
        name: root.name,
        kind: root.kind,
        revision: Number(root.revision)
      },
      nodes: rows.map((row) => ({
        nodeId: row.node_id,
        parentId: row.parent_id,
        name: row.name,
        kind: row.kind,
        lifecycle: row.lifecycle,
        revision: Number(row.revision)
      })),
      nextCursor,
      complete: nextCursor === null,
      contentRead: false,
      contentBytesRead: 0,
      rowsRead: Number(result.meta?.rows_read ?? rows.length)
    };
  }

  /**
   * Version metadata for one snapshot (design §6.3 snapshot.history). Bodies are
   * not returned by default: the history endpoint exists to locate a revision
   * before an explicit snapshot.read.
   */
  async function snapshotHistory(options = {}) {
    const params = typeof options === "string" ? { nodeId: options } : options;
    const nodeId = params.nodeId;
    const size = Math.min(Math.max(Number(params.limit) || 20, 1), BUDGETS.maxPageSize);
    const node = await readNode(nodeId);
    if (!node || node.lifecycle === "deleted") fail("target_deleted");
    if (node.kind !== "snapshot") fail("invalid_target", "not_snapshot");
    if (await blockedAncestor(nodeId)) fail("target_deleted");
    const result = await prepare(
      `SELECT revision, request_id, created_at, length(CAST(content_json AS BLOB)) AS bytes
       FROM snapshot_versions WHERE node_id = ?
       ORDER BY revision DESC LIMIT ?`,
      nodeId, size
    ).all();
    const rows = result.results ?? [];
    const current = await snapshotRow(nodeId);
    return {
      nodeId,
      currentRevision: current ? Number(current.revision) : 0,
      versions: rows.map((row) => ({
        revision: Number(row.revision),
        requestId: row.request_id,
        bytes: Number(row.bytes ?? 0),
        createdAt: row.created_at
      })),
      complete: rows.length < size,
      rowsRead: Number(result.meta?.rows_read ?? rows.length)
    };
  }

  return {
    // lifecycle
    initializeWorkspace,
    capabilities,
    // write path
    accept,
    claimTask,
    claimTaskById,
    queueTask,
    releaseQueuedTask,
    applyOne,
    projectAll,
    // admin
    retryTask,
    // queries
    listDirectory,
    resolvePath,
    readSnapshot,
    snapshotQuery,
    snapshotHistory,
    requestStatus,
    conflictList,
    taskStatus,
    deletionManifest,
    // Aliases consumed by src/routes.js (READ_DISPATCH).
    querySnapshots: snapshotQuery,
    listConflicts: conflictList
  };
}

export const STORE_LIMITS = Object.freeze({
  leaseSeconds: TASK_LEASE_SECONDS,
  failureThreshold: FAILURE_COUNT_THRESHOLD,
  failureBackoffSeconds: FAILURE_BACKOFF_SECONDS,
  deletePageSize: DELETE_PAGE_SIZE
});
