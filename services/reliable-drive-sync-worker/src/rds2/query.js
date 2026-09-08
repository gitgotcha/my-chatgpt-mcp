// T10: the V2 read executor. One independent DTO per operation, every read
// authenticated by the caller, params extra fields refused, cursors bound to
// the principal + operation + scope + revision and valid for 15 minutes,
// limit clamped to 50 and responses capped at 256 KiB. Pure reads: nothing
// here writes a task, a request row or an outbox entry.
import { authenticate } from "./identity/auth.js";
import { canonicalJson } from "../../../../shared/rds2-protocol.mjs";
import { deriveTaskId } from "./events/repository.js";

export const MAX_PAGE_LIMIT = 50;
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_RESPONSE_BYTES = 256 * 1024;
export const CURSOR_TTL_MS = 15 * 60 * 1000;

const OPERATIONS = new Set([
  "capabilities",
  "user.resolve",
  "projection.read",
  "interview.session.list",
  "interview.session.load",
  "event.status"
]);

function fail(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function refError(code) {
  const error = new Error(code);
  error.code = code;
  error.status = code === "cursor_scope_mismatch" ? 403 : 400;
  return error;
}

function requireObject(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw fail("invalid_params", 400);
  }
  return params;
}

function requireFields(params, allowed, required) {
  requireObject(params);
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) throw fail("invalid_params", 400);
  }
  for (const key of required) {
    if (params[key] === undefined) throw fail("invalid_params", 400);
  }
}

function domains(env) {
  const raw = typeof env?.RDS2_ENABLED_DOMAINS === "string"
    ? env.RDS2_ENABLED_DOMAINS
    : typeof env?.RDS2_V2_DOMAINS === "string" ? env.RDS2_V2_DOMAINS : "";
  return raw.split(",").map((value) => value.trim()).filter(Boolean);
}

function requireDomain(env, namespace) {
  if (!domains(env).includes(namespace)) throw fail("domain_disabled", 403);
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function base64url(text) {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value) {
  return atob(value.replace(/-/g, "+").replace(/_/g, "/"));
}

async function encodeCursor({ secret, payload }) {
  const body = base64url(JSON.stringify(payload));
  const signature = await hmac(secret, body);
  return `${body}.${signature}`;
}

async function decodeCursor({ secret, cursor, now }) {
  if (typeof cursor !== "string" || !cursor.includes(".")) throw refError("cursor_invalid");
  const [body, signature] = cursor.split(".");
  const expected = await hmac(secret, body);
  if (signature !== expected) throw refError("cursor_invalid");
  let payload;
  try {
    payload = JSON.parse(fromBase64url(body));
  } catch {
    throw refError("cursor_invalid");
  }
  if (typeof payload?.e !== "number" || payload.e <= Date.parse(now())) {
    throw refError("cursor_expired");
  }
  return payload;
}

export function createV2QueryExecutor({ db, principal, env, deps = {} }) {
  const now = deps.now ?? (() => new Date().toISOString());
  const secret = env?.RDS2_CURSOR_SECRET;
  if (typeof secret !== "string" || !secret.trim()) throw fail("cursor_secret_missing", 500);

  const requirePageScope = (params) => {
    requireFields(params, ["namespace", "projectionName", "limit", "cursor"], ["namespace", "projectionName"]);
    requireDomain(env, params.namespace);
    if (typeof params.projectionName !== "string" || !params.projectionName.trim()) {
      throw fail("invalid_params", 400);
    }
    if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || params.limit < 1)) {
      throw fail("invalid_params", 400);
    }
  };

  const readProjectionPage = async ({ namespace, projectionName, limit, cursorPayload, rowKind }) => {
    const head = await db.prepare(
      `SELECT revision, last_event_seq, active_generation, summary_json, building
       FROM rds2_projections WHERE user_id = ? AND namespace = ? AND projection_name = ?`
    ).bind(principal.userId, namespace, projectionName).first();
    if (!head) throw fail("projection_not_found", 404);

    if (cursorPayload && Number(cursorPayload.v) !== Number(head.revision)) {
      throw fail("projection_changed", 409);
    }

    const limitClamped = Math.min(Math.max(limit ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);
    const statement = cursorPayload
      ? db.prepare(
          `SELECT row_kind, row_key, value_json, COALESCE(sort_key, '') AS sort_key FROM rds2_projection_rows
           WHERE user_id = ? AND namespace = ? AND projection_name = ?
             AND generation = ? AND (? IS NULL OR row_kind = ?)
             AND (row_kind, COALESCE(sort_key, ''), row_key) > (?, ?, ?)
           ORDER BY row_kind, COALESCE(sort_key, ''), row_key LIMIT ?`
        ).bind(principal.userId, namespace, projectionName,
          Number(head.active_generation), rowKind ?? null, rowKind ?? null, cursorPayload.k, cursorPayload.s, cursorPayload.r, limitClamped + 1)
      : db.prepare(
          `SELECT row_kind, row_key, value_json, COALESCE(sort_key, '') AS sort_key FROM rds2_projection_rows
           WHERE user_id = ? AND namespace = ? AND projection_name = ? AND generation = ?
             AND (? IS NULL OR row_kind = ?)
           ORDER BY row_kind, COALESCE(sort_key, ''), row_key LIMIT ?`
        ).bind(principal.userId, namespace, projectionName,
          Number(head.active_generation), rowKind ?? null, rowKind ?? null, limitClamped + 1);

    const rows = (await statement.all()).results ?? [];
    // Byte cap: a row that would push the response past 256 KiB ends the page
    // here instead of being truncated mid-entry.
    const entries = [];
    let bytes = Buffer.byteLength(head.summary_json ?? "null", "utf8") + 2048;
    let exhausted = rows.length <= limitClamped;
    const page = rows.slice(0, limitClamped);
    for (const row of page) {
      const entry = { rowKind: row.row_kind, rowKey: row.row_key, sortKey: row.sort_key, value: JSON.parse(row.value_json) };
      bytes += Buffer.byteLength(canonicalJson(entry), "utf8");
      if (bytes > MAX_RESPONSE_BYTES) {
        if (entries.length === 0) throw fail("response_too_large", 413);
        exhausted = false;
        break;
      }
      entries.push(entry);
    }
    let nextCursor = null;
    if (!exhausted && entries.length > 0) {
      const last = entries[entries.length - 1];
      nextCursor = await encodeCursor({
        secret,
        payload: {
          u: principal.userId, o: "projection.read", n: namespace, p: projectionName,
          k: last.rowKind, s: last.sortKey, r: last.rowKey, f: rowKind ?? null, v: Number(head.revision),
          e: Date.parse(now()) + CURSOR_TTL_MS
        }
      });
    }
    return {
      revision: Number(head.revision),
      building: Boolean(head.building),
      lastEventSeq: Number(head.last_event_seq),
      summary: JSON.parse(head.summary_json ?? "null"),
      entries,
      nextCursor
    };
  };

  return {
    domainWhitelist: domains(env),

    async capabilities() {
      return {
        domains: domains(env),
        storageVersion: 2,
        writes: { accepted: true, durableReceipt: true }
      };
    },

    async userResolve(params) {
      requireFields(params, ["displayName"], ["displayName"]);
      if (typeof params.displayName !== "string") throw fail("invalid_params", 400);
      // Only the credential-bound user can be resolved: a name that does not
      // match the principal is a refusal, never a lookup.
      if (params.displayName.normalize("NFKC").trim() !== principal.username) {
        throw fail("user_mismatch", 403);
      }
      return { userId: principal.userId, displayName: principal.username };
    },

    async projectionRead(params) {
      requirePageScope(params);
      const cursorPayload = params.cursor
        ? await decodeCursor({ secret, cursor: params.cursor, now })
        : null;
      if (cursorPayload) {
        if (cursorPayload.u !== principal.userId
          || cursorPayload.o !== "projection.read"
          || cursorPayload.n !== params.namespace
          || cursorPayload.p !== params.projectionName || cursorPayload.f != null) {
          throw fail("cursor_scope_mismatch", 403);
        }
      }
      return readProjectionPage({
        namespace: params.namespace,
        projectionName: params.projectionName,
        limit: params.limit,
        cursorPayload
      });
    },

    async interviewSessionList(params, extras) {
      requireFields(params, ["limit", "cursor"], []);
      requireDomain(env, "interview");
      if (typeof extras?.interviewRead === "function") return extras.interviewRead({ kind: "interview.session.list", params, principal });
      if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || params.limit < 1)) throw fail("invalid_params", 400);
      const cursorPayload = params.cursor ? await decodeCursor({ secret, cursor: params.cursor, now }) : null;
      if (cursorPayload && (cursorPayload.u !== principal.userId || cursorPayload.o !== "projection.read"
        || cursorPayload.n !== "interview" || cursorPayload.p !== "interview" || cursorPayload.f !== "session")) throw fail("cursor_scope_mismatch", 403);
      let page;
      try {
        page = await readProjectionPage({ namespace: "interview", projectionName: "interview", limit: params.limit, cursorPayload, rowKind: "session" });
      } catch (error) {
        if (error.code === "projection_not_found" && !cursorPayload) return { sessions: [], nextCursor: null };
        throw error;
      }
      return { ...page, entries: undefined, sessions: page.entries.map(({ value }) => ({
        sessionId: value.sessionId, completedAt: value.completedAt, sourceType: value.sourceType,
        status: value.status, questionCount: value.questions?.length ?? 0
      })) };
    },

    async interviewSessionLoad(params, extras) {
      requireFields(params, ["sessionId"], ["sessionId"]);
      requireDomain(env, "interview");
      if (typeof extras?.interviewRead === "function") return extras.interviewRead({ kind: "interview.session.load", params, principal });
      if (typeof params.sessionId !== "string" || !params.sessionId.trim()) throw fail("invalid_params", 400);
      const row = await db.prepare(`SELECT r.value_json FROM rds2_projection_rows r
        JOIN rds2_projections p ON p.user_id=r.user_id AND p.namespace=r.namespace
          AND p.projection_name=r.projection_name AND p.active_generation=r.generation
        WHERE r.user_id=? AND r.namespace='interview' AND r.projection_name='interview'
          AND r.row_kind='session' AND r.row_key=?`).bind(principal.userId, params.sessionId).first();
      if (!row) throw fail("session_not_found", 404);
      return { session: JSON.parse(row.value_json) };
    },

    async eventStatus(params) {
      requireFields(params, ["targetRequestId", "targetEventId"], []);
      const hasRequest = params.targetRequestId !== undefined;
      const hasEvent = params.targetEventId !== undefined;
      if (hasRequest === hasEvent) throw fail("event_status_ambiguous", 400);
      if (hasRequest) {
        if (typeof params.targetRequestId !== "string" || !params.targetRequestId.trim()) {
          throw fail("invalid_params", 400);
        }
        const request = await db.prepare(
          `SELECT request_id, canonical_event_id, receipt_json, created_at
           FROM rds2_requests WHERE user_id = ? AND request_id = ?`
        ).bind(principal.userId, params.targetRequestId).first();
        if (!request) throw fail("event_not_found", 404);
        const event = await db.prepare(
          `SELECT event_seq, namespace, projection_name FROM rds2_events WHERE user_id=? AND event_id=?`
        ).bind(principal.userId, request.canonical_event_id).first();
        if (!event) throw fail("event_not_found", 404);
        const projection = await db.prepare(
          `SELECT revision FROM rds2_projections WHERE user_id = ? AND namespace = ? AND projection_name = ?
           AND last_event_seq >= (SELECT event_seq FROM rds2_events WHERE user_id = ? AND event_id = ?)`
        ).bind(principal.userId, event.namespace, event.projection_name, principal.userId, request.canonical_event_id).first();
        const artifactId = await deriveTaskId({ userId: principal.userId, namespace: event.namespace, projectionName: event.projection_name }, request.canonical_event_id, "artifact-event");
        const archive = await db.prepare(
          `SELECT object_name, drive_file_id, delivered_at FROM rds2_archive_deliveries WHERE user_id = ? AND artifact_id = ?`
        ).bind(principal.userId, artifactId).first();
        return {
          target: { requestId: request.request_id },
          eventId: request.canonical_event_id,
          receipt: JSON.parse(request.receipt_json ?? "null"),
          projection: projection ? "projected" : "pending",
          archive: archive?.delivered_at && archive?.drive_file_id ? "archived" : "pending"
        };
      }
      if (typeof params.targetEventId !== "string" || !params.targetEventId.trim()) {
        throw fail("invalid_params", 400);
      }
      const event = await db.prepare(
        `SELECT event_seq, event_id FROM rds2_events WHERE user_id = ? AND event_id = ?`
      ).bind(principal.userId, params.targetEventId).first();
      if (!event) throw fail("event_not_found", 404);
      const request = await db.prepare(
        `SELECT request_id, receipt_json FROM rds2_requests
         WHERE user_id = ? AND canonical_event_id = ? ORDER BY created_at LIMIT 1`
      ).bind(principal.userId, params.targetEventId).first();
      if (!request) throw fail("event_not_found", 404);
      const result = await this.eventStatus({ targetRequestId: request.request_id });
      return { ...result, target: { eventId: event.event_id } };
    }
  };
}

export { OPERATIONS };
