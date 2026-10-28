// RDS-JBryon protocol contracts (design 2026-10-26, §6–§7, §12).
//
// Single-user by construction: there is no user table, no username/userId in
// the protocol, and no account resolution. Every request carries the workspace
// epoch so an old client can never replay into a reset workspace.
//
// This module is pure: no D1, no network, no file system. Names, paths, request
// envelopes and budgets are validated here so the Worker, the local Outbox and
// the tests share one definition.
export const PROTOCOL = "rds-jbryon";
export const API_VERSION = 1;
export const PRODUCT_NAME = "RDS-JBryon";
export const DISPLAY_NAME = "乔炳源";

export const KINDS = Object.freeze(["domain", "directory", "snapshot"]);
export const LIFECYCLES = Object.freeze(["active", "deleting", "deleted"]);

export const READ_OPERATIONS = Object.freeze([
  "capabilities",
  "directory.list",
  "directory.resolve",
  "snapshot.read",
  "snapshot.query",
  "snapshot.history",
  "request.status",
  "conflict.list",
  "task.status",
  "deletion.manifest"
]);

export const WRITE_OPERATIONS = Object.freeze([
  "directory.create",
  "directory.rename",
  "directory.move",
  "directory.delete",
  "snapshot.create",
  "snapshot.patch",
  "snapshot.delete",
  "conflict.resolve",
  "task.retry"
]);

export const OPERATIONS = Object.freeze([...READ_OPERATIONS, ...WRITE_OPERATIONS]);

// Engineering initial budgets (design §12). They are reviewable defaults, not
// claims about the user's study volume.
export const BUDGETS = Object.freeze({
  maxDepth: 16,
  maxNameCharacters: 128,
  maxNameBytes: 512,
  maxRequestBytes: 256 * 1024,
  maxSnapshotBytes: 256 * 1024,
  maxQueryResponseBytes: 256 * 1024,
  maxPageSize: 50,
  maxPatchOperations: 64
});

export class RdsError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = "RdsError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

const fail = (code, detail) => {
  throw new RdsError(code, detail);
};

export const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value) => typeof value === "string" && value.length > 0;

export function bytesOf(value) {
  return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).length;
}

/**
 * Name rule: NFC, non-empty, no separators or dot segments, bounded in both
 * characters and UTF-8 bytes. Names are compared after NFC, never lowercased:
 * "JVM" and "jvm" are different user-visible names.
 */
export function normalizeName(raw) {
  if (typeof raw !== "string") fail("invalid_name", typeof raw);
  const name = raw.normalize("NFC");
  if (!name.length) fail("invalid_name", "empty");
  if (name === "." || name === "..") fail("invalid_name", "dot_segment");
  if (name.includes("/") || name.includes("\\")) fail("invalid_name", "separator");
  if ([...name].length > BUDGETS.maxNameCharacters) fail("invalid_name", "characters");
  if (bytesOf(name) > BUDGETS.maxNameBytes) fail("invalid_name", "bytes");
  return name;
}

/** External path: array of names from the root; the root itself is []. */
export function normalizePath(raw) {
  if (!Array.isArray(raw)) fail("invalid_path", "not_array");
  if (raw.length > BUDGETS.maxDepth) fail("invalid_path", "depth");
  return raw.map((segment) => normalizeName(segment));
}

/** Display form only; the protocol always carries the array. */
export const displayPath = (path) => normalizePath(path).join("/");

export function validateEpoch(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/i.test(value)) fail("invalid_workspace_epoch");
  return value;
}

export function validateRequestId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
    fail("invalid_request_id");
  }
  return value;
}

/** Content hash input: stable key order, protocol-level fields only. */
export function canonicalRequest(request) {
  const fields = ["workspaceEpoch", "requestId", "operation", "target", "dependsOn",
    "baseRevision", "changes", "confirmation", "replaces"];
  const canonical = {};
  for (const field of fields) {
    if (request[field] !== undefined) canonical[field] = request[field];
  }
  return canonical;
}

export function stableStringify(value) {
  const seen = new Set();
  const walk = (node) => {
    if (node === null) return "null";
    const type = typeof node;
    if (type === "string") return JSON.stringify(node);
    if (type === "number") return Number.isFinite(node) ? JSON.stringify(node) : "null";
    if (type === "boolean") return node ? "true" : "false";
    if (Array.isArray(node)) {
      if (seen.has(node)) fail("invalid_request", "circular");
      seen.add(node);
      const items = node.map(walk);
      seen.delete(node);
      return `[${items.join(",")}]`;
    }
    if (type !== "object") fail("invalid_request", "unrepresentable");
    if (seen.has(node)) fail("invalid_request", "circular");
    seen.add(node);
    const entries = Object.keys(node).sort().map((key) => `${JSON.stringify(key)}:${walk(node[key])}`);
    seen.delete(node);
    return `{${entries.join(",")}}`;
  };
  return walk(value);
}

/** Structural request validation shared by the Outbox and the Worker. */
export function validateRequest(request) {
  if (!isObject(request)) fail("invalid_request");
  const allowed = new Set([
    "protocol", "apiVersion", "workspaceEpoch", "requestId", "operation", "target",
    "dependsOn", "baseRevision", "changes", "confirmation", "replaces"
  ]);
  for (const key of Object.keys(request)) {
    if (!allowed.has(key)) fail("invalid_request", key);
  }
  if (request.protocol !== PROTOCOL) fail("unsupported_protocol");
  if (request.apiVersion !== API_VERSION) fail("unsupported_api_version");
  validateEpoch(request.workspaceEpoch);
  validateRequestId(request.requestId);
  if (!OPERATIONS.includes(request.operation)) fail("unsupported_operation");
  if (request.target !== undefined) {
    if (!isObject(request.target)) fail("invalid_target");
    for (const key of Object.keys(request.target)) {
      if (!["nodeId", "parentId", "name", "kind", "path"].includes(key)) fail("invalid_target", key);
    }
    if (request.target.path !== undefined) normalizePath(request.target.path);
    if (request.target.name !== undefined) normalizeName(request.target.name);
  }
  if (request.dependsOn !== undefined) {
    if (!Array.isArray(request.dependsOn) || request.dependsOn.length > 32) fail("invalid_dependencies");
    request.dependsOn.forEach(validateRequestId);
  }
  if (request.replaces !== undefined) {
    if (!Array.isArray(request.replaces) || request.replaces.length > 8) fail("invalid_replaces");
    request.replaces.forEach(validateRequestId);
    if (request.replaces.includes(request.requestId)) fail("invalid_replaces", "self");
  }
  if (request.baseRevision !== undefined && request.baseRevision !== null
    && (!Number.isInteger(request.baseRevision) || request.baseRevision < 0)) {
    fail("invalid_base_revision");
  }
  if (request.changes !== undefined) {
    if (!Array.isArray(request.changes) || request.changes.length > BUDGETS.maxPatchOperations) {
      fail("invalid_changes");
    }
    request.changes.forEach(validateChange);
  }
  if (bytesOf(canonicalRequest(request)) > BUDGETS.maxRequestBytes) fail("request_too_large");
  return request;
}

const CHANGE_FIELDS = new Set(["op", "path", "value", "field", "itemId"]);

export function validateChange(change) {
  if (!isObject(change) || typeof change.op !== "string") fail("invalid_change");
  for (const key of Object.keys(change)) {
    if (!CHANGE_FIELDS.has(key)) fail("invalid_change", key);
  }
  if (change.op === "set" || change.op === "remove") {
    if (change.op === "set" && !("value" in change)) fail("invalid_change", "value");
  } else if (change.op === "item_set" || change.op === "item_remove") {
    if (!nonEmptyString(change.field) || !nonEmptyString(change.itemId)) fail("invalid_change", "item");
    if (change.op === "item_set" && !("value" in change)) fail("invalid_change", "value");
  } else {
    fail("invalid_change", "op");
  }
  if (change.path !== undefined) normalizePath(change.path);
  return change;
}

/** Status vocabulary shared by requests, tasks and the local Outbox. */
export const ACCEPT_STATUS = Object.freeze(["d1_committed"]);
export const EFFECT_STATUS = Object.freeze([
  "pending", "applied", "applied_noop", "conflict", "cancelled", "needs_attention"
]);
export const LOCAL_STATUS = Object.freeze([
  "local_pending", "sending", "cloud_acknowledged", "waiting_dependency",
  "delivery_blocked", "cancelled"
]);

/** A user may see "projected" only for a real applied/applied_noop effect. */
export function displayStatus({ local, effect }) {
  if (LOCAL_STATUS.includes(local) === false) fail("invalid_local_status", local);
  if (effect !== undefined && effect !== null && EFFECT_STATUS.includes(effect) === false) {
    fail("invalid_effect_status", effect);
  }
  if (local === "cancelled") return "cancelled";
  if (local !== "cloud_acknowledged") return local;
  if (effect === "applied" || effect === "applied_noop") return "projected";
  if (effect === "conflict") return "conflict";
  if (effect === "needs_attention") return "needs_attention";
  if (effect === "cancelled") return "cancelled";
  return "d1_committed";
}
