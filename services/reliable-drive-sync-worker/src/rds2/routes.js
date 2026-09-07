// T10: the V2 entry points.
//
// handleV2Request  POST /v2/query  — one independent DTO per read operation,
//   every operation authenticated against rds2_credentials, domains
//   fail-closed on the configured whitelist, and every response field
//   constructed here (never a raw payload passthrough).
// handleV2Queue    the queue consumers: one message per invocation, a fresh
//   budgeted io per task type (projection 24, archive 16), the rest of the
//   batch asked to retry.
// handleV2Scheduled the recovery wake: expired leases come back, due tasks
//   are dispatched under the recovery budget (32).
import { createV2QueryExecutor, OPERATIONS } from "./query.js";
import { authenticate } from "./identity/auth.js";
import { createInvocationIo } from "./io/invocation-io.js";
import { splitQueueBatch, dispatchOne } from "./tasks/dispatcher.js";
import { recoverOnce } from "./tasks/recovery.js";
import { continueBuild } from "./projection/builds.js";
import { archiveOne } from "./archive/archiver.js";
import { algorithmReducer } from "./projection/algorithm.js";

export const PROJECTION_BUDGET = 24;
export const ARCHIVE_BUDGET = 16;
export const RECOVERY_BUDGET = 32;

const STATUS_BY_CODE = {
  invalid_params: 400,
  cursor_invalid: 400,
  cursor_expired: 400,
  event_status_ambiguous: 400,
  cursor_secret_missing: 500,
  invalid_credential: 401,
  unknown_credential: 401,
  credential_revoked: 401,
  user_disabled: 401,
  domain_disabled: 403,
  cursor_scope_mismatch: 403,
  user_mismatch: 403,
  projection_changed: 409,
  projection_not_found: 404,
  event_not_found: 404,
  response_too_large: 413
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function errorResponse(code) {
  const status = STATUS_BY_CODE[code] ?? 500;
  return jsonResponse({ error: { code } }, status);
}

function credentialFrom(request) {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

export async function handleV2Request(request, env, ctx, deps = {}) {
  const db = deps.db ?? env?.DB;
  const now = deps.now ?? (() => new Date().toISOString());
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || body.storageVersion !== 2
      || typeof body.operation !== "string") {
      return errorResponse("invalid_params");
    }
    if (!OPERATIONS.has(body.operation)) return errorResponse("invalid_params");

    const credential = credentialFrom(request);
    const principal = deps.principal
      ?? await authenticate({ db, credential });

    const executor = createV2QueryExecutor({ db, principal, env, deps: { now, interviewRead: deps.interviewRead } });
    const data = await executor[body.operation === "user.resolve" ? "userResolve"
      : body.operation === "projection.read" ? "projectionRead"
      : body.operation === "interview.session.list" ? "interviewSessionList"
      : body.operation === "interview.session.load" ? "interviewSessionLoad"
      : body.operation === "event.status" ? "eventStatus"
      : "capabilities"](body.params ?? {}, { interviewRead: deps.interviewRead });
    return jsonResponse(data, 200);
  } catch (error) {
    const code = error?.code ?? "internal_error";
    return errorResponse(code);
  }
}

// One budgeted io per task type, created fresh per invocation: the projection
// budget (24) covers claim + build pages, the archive budget (16) covers a
// frozen object delivery.
function budgetedIoFor(type, env) {
  const limit = type === "archive_event" || type === "archive_delta"
    ? ARCHIVE_BUDGET
    : PROJECTION_BUDGET;
  return createInvocationIo({
    db: env.DB,
    queues: {
      RDS2_PROJECTION_QUEUE: env.RDS2_PROJECTION_QUEUE,
      RDS2_ARCHIVE_QUEUE: env.RDS2_ARCHIVE_QUEUE
    },
    limit
  });
}

export async function handleV2Queue(batch, env, ctx, deps = {}) {
  const messages = Array.isArray(batch?.messages) ? batch.messages : [];
  const { first, rest } = splitQueueBatch(messages.map((message) => message.body ?? message));
  if (!first) {
    if (typeof batch?.ackAll === "function") batch.ackAll();
    return { outcome: "noop" };
  }
  const io = budgetedIoFor(first.type, env);
  const result = await dispatchOne({ io, taskId: first.taskId, owner: `v2-queue-${first.type}`, now: deps.now });
  // Ack the processed message; the rest are retried exactly as they came, so
  // a later invocation picks them up one at a time.
  const rawMessages = batch.messages;
  if (typeof rawMessages[0]?.ack === "function") rawMessages[0].ack();
  for (const message of rawMessages.slice(1)) {
    if (typeof message.retry === "function") message.retry();
  }
  return { outcome: result.outcome, taskId: first.taskId, pending: rest.length };
}

export async function handleV2Scheduled(controller, env, ctx, deps = {}) {
  const io = createInvocationIo({
    db: env.DB,
    queues: {
      RDS2_PROJECTION_QUEUE: env.RDS2_PROJECTION_QUEUE,
      RDS2_ARCHIVE_QUEUE: env.RDS2_ARCHIVE_QUEUE
    },
    limit: RECOVERY_BUDGET
  });
  const now = deps.now ?? (() => new Date().toISOString());
  const recovery = await recoverOnce({ io, now: now(), limit: 4 });
  let dispatched = 0;
  for (const taskId of recovery.taskIds ?? []) {
    const result = await dispatchOne({ io, taskId, owner: "v2-recovery", now: now() });
    if (result.outcome === "continued") dispatched += 1;
  }
  return { recovered: recovery.recovered ?? 0, dispatched };
}
