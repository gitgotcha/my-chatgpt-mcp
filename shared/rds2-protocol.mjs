// RDS V2 protocol contracts shared by the Worker and the local MCP tooling.
// Reuses the existing pure V1 envelope validator instead of duplicating the
// 18 payload schemas. No D1, Queue, HTTP or Node-only imports are allowed
// here so Wrangler can bundle this module from both sides.
import {
  validateEnvelope,
  ProtocolError,
  ALLOWED_NAMESPACES,
  SCHEMA_VERSION
} from "../services/reliable-drive-sync-worker/src/protocol.js";

export { validateEnvelope, ProtocolError, SCHEMA_VERSION };

const READ_EVENT_TYPES = new Set([
  "system.capabilities.read",
  "system.user.resolve",
  "interview.session.list",
  "interview.session.load",
  "profile.snapshot.read"
]);
const ADMIN_ONLY_EVENT_TYPES = new Set(["system.user-registered"]);
const DISABLED_EVENT_TYPES = new Set(["system.legacy-migration-requested"]);

// V2 submissions that must never be accepted as ordinary writes are rejected
// with stable codes before any storage happens:
// - read kinds belong to /v2/query, never to the write endpoint;
// - system.user-registered is only served by the admin initialization entry;
// - system.legacy-migration-requested stays disabled in V2.
export const SUBMISSION_REJECTION_CODES = Object.freeze({
  read: "read_only_event",
  adminOnly: "unsupported_write_type",
  disabled: "migration_disabled"
});

export function classifySubmission(input) {
  const envelope = validateEnvelope(input);
  if (READ_EVENT_TYPES.has(envelope.eventType)) return { kind: "read", envelope };
  if (ADMIN_ONLY_EVENT_TYPES.has(envelope.eventType)) return { kind: "adminOnly", envelope };
  if (DISABLED_EVENT_TYPES.has(envelope.eventType)) return { kind: "disabled", envelope };
  return { kind: "write", envelope };
}

// ---------------------------------------------------------------------------
// Canonical JSON + hashing (Web Crypto SHA-256, UTF-8, key-sorted, arrays keep
// their order). Values that cannot be represented in JSON are rejected instead
// of being silently coerced.
// ---------------------------------------------------------------------------
class CanonicalJsonError extends TypeError {
  constructor(message) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

export function canonicalJson(value) {
  const seen = new Set();
  const serialize = (node) => {
    if (node === null) return "null";
    const type = typeof node;
    if (type === "string") return JSON.stringify(node);
    if (type === "boolean") return node ? "true" : "false";
    if (type === "number") {
      if (!Number.isFinite(node)) throw new CanonicalJsonError("non_finite_number");
      return JSON.stringify(node);
    }
    if (type === "bigint" || type === "function" || type === "symbol" || type === "undefined") {
      throw new CanonicalJsonError(`unrepresentable_${type}`);
    }
    if (Array.isArray(node)) {
      if (seen.has(node)) throw new CanonicalJsonError("circular_reference");
      // Sparse arrays would serialize to illegal JSON ("[,]"): they are
      // rejected outright instead of being silently normalized.
      for (let index = 0; index < node.length; index += 1) {
        if (!Object.hasOwn(node, index)) throw new CanonicalJsonError("sparse_array");
      }
      seen.add(node);
      const items = node.map(serialize);
      seen.delete(node);
      return `[${items.join(",")}]`;
    }
    if (seen.has(node)) throw new CanonicalJsonError("circular_reference");
    seen.add(node);
    const entries = Object.keys(node).sort()
      .map((key) => `${JSON.stringify(key)}:${serialize(node[key])}`);
    seen.delete(node);
    return `{${entries.join(",")}}`;
  };
  return serialize(value);
}

export async function hashJson(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const CONTENT_FIELDS = ["schemaVersion", "namespace", "eventType", "identity", "payload"];

// The content view intentionally drops the transport requestId: two submits
// that differ only by requestId carry the same business content.
export function contentView(envelope) {
  const view = {};
  for (const field of CONTENT_FIELDS) {
    if (envelope[field] !== undefined) view[field] = envelope[field];
  }
  return view;
}

export function envelopeHashOf(envelope) {
  return hashJson(envelope);
}

export function contentHashOf(envelope) {
  return hashJson(contentView(envelope));
}

// ---------------------------------------------------------------------------
// Same-day first-score business key. Only the event types listed here use the
// businessKey branch; every other domain must stay free to submit several
// events on one local date.
// ---------------------------------------------------------------------------
export const BUSINESS_KEY_EVENT_TYPES = new Set(["resume-knowledge.answer-scored"]);

export function businessKeyConfiguredFor(eventType) {
  return BUSINESS_KEY_EVENT_TYPES.has(eventType);
}

export function businessKeyFor(envelope, userId) {
  if (!businessKeyConfiguredFor(envelope.eventType)) return Promise.resolve(null);
  const event = envelope.payload?.event;
  if (!event) return Promise.resolve(null);
  return hashJson([userId, envelope.eventType, event.questionKey, event.localDate]);
}

// ---------------------------------------------------------------------------
// Pure idempotency decision. `rows` carries what the repository found in D1:
//   request:    { requestId, envelopeHash, canonicalEventId } | null
//   eventById:  { eventId, contentHash } | null   (row for incoming.eventId)
//   eventByKey: { eventId, contentHash } | null   (row for incoming eventKey)
//   businessKey:{ eventId, contentHash } | null   (configured types only)
// `incoming` carries the computed hashes of the new submission. This function
// performs no I/O so the pre-check and the post-UNIQUE recheck run the exact
// same decision path.
// ---------------------------------------------------------------------------
export function decideIntent(rows, incoming) {
  const referenced = [];
  if (rows.request?.canonicalEventId) {
    referenced.push({ key: "request", eventId: rows.request.canonicalEventId });
  }
  if (rows.eventById) referenced.push({ key: "eventById", eventId: incoming.eventId });
  if (rows.eventByKey) referenced.push({ key: "eventByKey", eventId: rows.eventByKey.eventId });
  if (incoming.businessKeyConfigured && rows.businessKey) {
    referenced.push({ key: "businessKey", eventId: rows.businessKey.eventId });
  }
  const distinctEvents = new Set(referenced.map((entry) => entry.eventId));
  if (distinctEvents.size > 1) {
    return { outcome: "conflict", code: "identity_of_intent_conflict", eventId: null, createdByRequest: null };
  }
  if (rows.request) {
    if (rows.request.envelopeHash === incoming.envelopeHash) {
      return {
        outcome: "replay", code: "already_recorded",
        eventId: rows.request.canonicalEventId, ignoredDuplicate: false,
        createdByRequest: rows.request.canonicalEventId
      };
    }
    return {
      outcome: "conflict", code: "request_id_conflict",
      eventId: rows.request.canonicalEventId, createdByRequest: null
    };
  }
  if (rows.eventById) {
    if (rows.eventById.contentHash === incoming.contentHash) {
      return {
        outcome: "alias", code: "already_recorded", eventId: rows.eventById.eventId,
        ignoredDuplicate: false, createdByRequest: rows.eventById.createdByRequest ?? null
      };
    }
    return { outcome: "conflict", code: "event_id_conflict", eventId: rows.eventById.eventId, createdByRequest: null };
  }
  if (rows.eventByKey) {
    if (rows.eventByKey.contentHash === incoming.contentHash) {
      return {
        outcome: "alias", code: "already_recorded", eventId: rows.eventByKey.eventId,
        ignoredDuplicate: false, createdByRequest: rows.eventByKey.createdByRequest ?? null
      };
    }
    return { outcome: "conflict", code: "event_key_conflict", eventId: rows.eventByKey.eventId, createdByRequest: null };
  }
  if (incoming.businessKeyConfigured && rows.businessKey) {
    return {
      outcome: "firstResult", code: "already_recorded",
      eventId: rows.businessKey.eventId, ignoredDuplicate: true,
      createdByRequest: rows.businessKey.createdByRequest ?? null
    };
  }
  return { outcome: "new", code: null, eventId: incoming.eventId ?? null, ignoredDuplicate: false, createdByRequest: null };
}

// ---------------------------------------------------------------------------
// V2 query DTO validation (spec addendum §5). Exactly three top-level fields,
// every operation enumerates its params, extra params are rejected, limit is
// 1..50 when present.
// ---------------------------------------------------------------------------
class QueryError extends Error {
  constructor(code) {
    super(code);
    this.name = "QueryError";
    this.code = code;
  }
}

const QUERY_OPERATIONS = new Set([
  "capabilities",
  "user.resolve",
  "projection.read",
  "interview.session.list",
  "interview.session.load",
  "event.status"
]);

const nonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;

function exactParams(params, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new QueryError("invalid_query_params");
  const keys = Object.keys(params);
  if (keys.some((key) => !allowed.has(key))) throw new QueryError("invalid_query_params");
  if (required.some((key) => params[key] === undefined)) throw new QueryError("invalid_query_params");
}

function validateLimit(params) {
  if (params.limit === undefined) return;
  if (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 50) {
    throw new QueryError("invalid_query_params");
  }
}

function validateCursor(params) {
  if (params.cursor !== undefined && !nonEmptyString(params.cursor)) {
    throw new QueryError("invalid_query_params");
  }
}

export function validateQuery(dto) {
  if (!dto || typeof dto !== "object" || Array.isArray(dto)) throw new QueryError("invalid_query");
  const keys = Object.keys(dto);
  if (keys.length !== 3 || keys.some((key) => !["storageVersion", "operation", "params"].includes(key))) {
    throw new QueryError("invalid_query");
  }
  if (dto.storageVersion !== 2) throw new QueryError("invalid_query_storage_version");
  if (!QUERY_OPERATIONS.has(dto.operation)) throw new QueryError("invalid_query_operation");
  // params must arrive as a real object; null is never patched into {}.
  const params = dto.params;
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new QueryError("invalid_query_params");
  }
  switch (dto.operation) {
    case "capabilities":
      exactParams(params, []);
      break;
    case "user.resolve":
      exactParams(params, ["displayName"]);
      if (!nonEmptyString(params.displayName)) throw new QueryError("invalid_query_params");
      break;
    case "projection.read":
      exactParams(params, ["namespace", "projectionName"], ["limit", "cursor"]);
      if (!ALLOWED_NAMESPACES.has(params.namespace)) throw new QueryError("invalid_query_params");
      if (!nonEmptyString(params.projectionName)) throw new QueryError("invalid_query_params");
      validateLimit(params);
      validateCursor(params);
      break;
    case "interview.session.list":
      exactParams(params, [], ["limit", "cursor"]);
      validateLimit(params);
      validateCursor(params);
      break;
    case "interview.session.load":
      exactParams(params, ["sessionId"]);
      if (!nonEmptyString(params.sessionId)) throw new QueryError("invalid_query_params");
      break;
    case "event.status": {
      exactParams(params, [], ["targetRequestId", "targetEventId"]);
      const hasRequest = params.targetRequestId !== undefined;
      const hasEvent = params.targetEventId !== undefined;
      if (hasRequest === hasEvent) throw new QueryError("invalid_query_params");
      if (hasRequest && !nonEmptyString(params.targetRequestId)) throw new QueryError("invalid_query_params");
      if (hasEvent && !nonEmptyString(params.targetEventId)) throw new QueryError("invalid_query_params");
      break;
    }
    default:
      throw new QueryError("invalid_query_operation");
  }
  return { storageVersion: 2, operation: dto.operation, params };
}
