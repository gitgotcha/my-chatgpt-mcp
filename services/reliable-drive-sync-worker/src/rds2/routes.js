// T10: the V2 entry points.
//
// handleV2Request  POST /v2/query  — one independent DTO per read operation,
//   every operation authenticated against rds2_credentials, domains
//   fail-closed on the configured whitelist, and every response field
//   constructed here (never a raw payload passthrough).
// handleV2Write    POST /v2/events — a bounded body, credential-bound
//   principal, classifySubmission allowing WRITES only, then acceptEvent and
//   the real WriteReceipt.
// handleV2Queue    the queue CONSUMERS: one message per invocation, the
//   message type only selects the business entry point (projectOne /
//   continueBuild / archiveOne) while the real task content and type are
//   loaded from D1 and cross-checked; a fresh budgeted io per task type.
// handleV2Scheduled the recovery wake: expired leases come back, due tasks
//   are dispatched under the recovery budget (32).
import { createV2QueryExecutor, OPERATIONS } from "./query.js";
import { authenticate } from "./identity/auth.js";
import { hashText } from "./identity/hashing.js";
import { initializeUser } from "./identity/initialize.js";
import { createInvocationIo } from "./io/invocation-io.js";
import { splitQueueBatch } from "./tasks/dispatcher.js";
import { getTask } from "./tasks/repository.js";
import { handleDlq } from "./tasks/dlq.js";
import { recoverOnce } from "./tasks/recovery.js";
import { continueBuild } from "./projection/builds.js";
import { projectOne } from "./projection/engine.js";
import { archiveOne } from "./archive/archiver.js";
import { reducerForScope } from "./projection/registry.js";
import { classifySubmission, SUBMISSION_REJECTION_CODES } from "../../../../shared/rds2-protocol.mjs";
import { acceptEvent } from "./events/accept.js";
import { accessToken } from "../google-drive.js";
import { createArchiveClient } from "./archive/drive-client.js";

export const PROJECTION_BUDGET = 24;
export const ARCHIVE_BUDGET = 16;
export const RECOVERY_BUDGET = 32;
export const WRITE_BUDGET = 20;
export const MAX_ENVELOPE_BYTES = 256 * 1024;

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
  response_too_large: 413,
  envelope_too_large: 413,
  read_only_event: 400,
  unsupported_write_type: 400,
  migration_disabled: 400,
  v2_query_disabled: 503,
  v2_write_disabled: 503,
  v2_init_disabled: 503,
  admin_not_configured: 500,
  admin_credential_rejected: 403,
  invalid_display_name: 400,
  invalid_user_id: 400,
  identity_conflict: 409,
  credential_conflict: 409
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function errorResponse(code, statusOverride) {
  const status = statusOverride ?? STATUS_BY_CODE[code] ?? 500;
  return jsonResponse({ error: { code } }, status);
}

function credentialFrom(request) {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * Admin-only synthetic/real identity initialization. The endpoint is kept
 * separate from /v2/events: a normal user credential can never create a
 * user, and the one-time plaintext credential is returned only in this
 * response. The admin secret itself is compared through its hash and is
 * never included in a response or diagnostic.
 */
export async function handleV2Init(request, env, ctx, deps = {}) {
  const db = deps.db ?? env?.DB;
  try {
    if (!featureEnabled(env, "RDS2_INIT_ENABLED")) {
      return errorResponse("v2_init_disabled");
    }
    if (request.method !== "POST") return errorResponse("invalid_params", 405);
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > 64 * 1024) {
      return errorResponse("invalid_params");
    }
    let body;
    try { body = JSON.parse(raw); } catch { return errorResponse("invalid_params"); }
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some((key) => !["displayName", "userId"].includes(key))) {
      return errorResponse("invalid_params");
    }
    if (typeof body.displayName !== "string" || !body.displayName.trim()) {
      return errorResponse("invalid_display_name");
    }
    const adminToken = env?.RDS2_ADMIN_TOKEN;
    if (typeof adminToken !== "string" || !adminToken) {
      return errorResponse("admin_not_configured");
    }
    const adminCredential = credentialFrom(request);
    const expectedAdminHash = await hashText(adminToken);
    const randomUUID = deps.randomUUID ?? (() => crypto.randomUUID());
    const credential = deps.randomCredential
      ? await deps.randomCredential()
      : `rds2_${randomUUID()}_${randomUUID()}`;
    const credentialHash = await hashText(credential);
    const result = await initializeUser({
      db,
      adminCredential,
      expectedAdminHash,
      displayName: body.displayName,
      userIdOverride: body.userId,
      credentialHash,
      now: deps.now ? deps.now() : undefined
    });
    return jsonResponse({
      storageVersion: 2,
      userId: result.userId,
      displayName: result.username,
      credential,
      created: Boolean(result.created),
      credentialBound: Boolean(result.credentialBound)
    }, 201);
  } catch (error) {
    const code = error?.code ?? "internal_error";
    return errorResponse(code, error?.status);
  }
}

function featureEnabled(env, name) {
  return env?.[name] === "true";
}

function allowedUserIds(env) {
  const raw = typeof env?.RDS2_ALLOWED_USER_IDS === "string" ? env.RDS2_ALLOWED_USER_IDS : "";
  return raw.split(",").map((value) => value.trim()).filter(Boolean);
}

function domainEnabled(env, namespace) {
  const raw = typeof env?.RDS2_ENABLED_DOMAINS === "string"
    ? env.RDS2_ENABLED_DOMAINS
    : typeof env?.RDS2_V2_DOMAINS === "string" ? env.RDS2_V2_DOMAINS : "";
  return raw.split(",").map((value) => value.trim()).filter(Boolean).includes(namespace);
}

export async function handleV2Request(request, env, ctx, deps = {}) {
  const now = deps.now ?? (() => new Date().toISOString());
  try {
    if (!featureEnabled(env, "RDS2_QUERY_ENABLED")) {
      return errorResponse("v2_query_disabled");
    }
    const db = createInvocationIo({ db: deps.db ?? env?.DB, limit: 20 }).db;
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
    return errorResponse(code, error?.status);
  }
}

export async function handleV2Write(request, env, ctx, deps = {}) {
  const db = deps.db ?? env?.DB;
  const now = deps.now ?? (() => new Date().toISOString());
  try {
    // Bounded read BEFORE parsing: an oversized body is refused on its size,
    // never parsed.
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_ENVELOPE_BYTES) {
      return errorResponse("envelope_too_large");
    }
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      return errorResponse("invalid_params");
    }
    const credential = credentialFrom(request);
    const principal = deps.principal ?? await authenticate({ db, credential });
    // Only writes pass here: read, admin-only and disabled types keep their
    // stable rejection codes instead of being silently accepted.
    const submission = classifySubmission(envelope);
    if (submission.kind !== "write") {
      return errorResponse(SUBMISSION_REJECTION_CODES[submission.kind]);
    }
    if (!featureEnabled(env, "RDS2_WRITE_ENABLED")) {
      return errorResponse("v2_write_disabled");
    }
    if (!domainEnabled(env, submission.envelope.namespace)) {
      return errorResponse("domain_disabled", 403);
    }
    const allowed = allowedUserIds(env);
    if (allowed.length === 0 || !allowed.includes(principal.userId)) {
      return errorResponse("user_disabled", 401);
    }
    const io = createInvocationIo({
      db,
      queues: {
        RDS2_PROJECTION_QUEUE: env?.RDS2_PROJECTION_QUEUE,
        RDS2_ARCHIVE_QUEUE: env?.RDS2_ARCHIVE_QUEUE
      },
      limit: WRITE_BUDGET
    });
    const receipt = await acceptEvent({ io, principal, envelope: submission.envelope, now: now() });
    return jsonResponse(receipt, 200);
  } catch (error) {
    const code = error?.code ?? "internal_error";
    return errorResponse(code, error?.status);
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
  const queueName = batch?.queue;
  const isDlq = queueName === "rds2-projection-dlq" || queueName === "rds2-archive-dlq";
  const requiredSwitch = queueName === "rds2-archive" || queueName === "rds2-archive-dlq"
    ? "RDS2_ARCHIVE_ENABLED" : "RDS2_PROJECTION_ENABLED";

  // Queue bindings remain present during a staged rollout, but consumers are
  // fail-closed while their domain switch is off. Messages are retried rather
  // than acked or mutated, so enabling the switch later resumes work safely.
  if (!featureEnabled(env, requiredSwitch)) {
    for (const message of messages) {
      if (typeof message?.retry === "function") message.retry();
    }
    return { outcome: "retry", code: `${requiredSwitch.toLowerCase()}_disabled`, pending: messages.length };
  }

  // DLQ consumers are real consumers, not ordinary task producers. They use
  // the queue name (rather than a forgeable message type) to enter the
  // authoritative D1 DLQ handler; that handler is idempotent for completed or
  // already parked tasks and only re-dispatches a still-live task.
  if (isDlq) {
    const bodies = messages.map((message) => message.body ?? message);
    const [firstBody, ...restBodies] = bodies;
    const taskId = typeof firstBody === "string" ? firstBody : firstBody?.taskId;
    const io = budgetedIoFor(queueName === "rds2-archive-dlq" ? "archive_event" : "projection", env);
    const now = deps.now ?? (() => new Date().toISOString());
    const result = taskId
      ? await handleDlq({ io, taskId, now: now() })
      : { outcome: "noop", taskId: null, code: "invalid_dlq_message" };
    if (result.outcome === "retry") {
      if (typeof messages[0]?.retry === "function") messages[0].retry();
    } else if (typeof messages[0]?.ack === "function") {
      messages[0].ack();
    }
    for (const message of messages.slice(1)) {
      if (typeof message.retry === "function") message.retry();
    }
    return { outcome: result.outcome, taskId: result.taskId, code: result.code ?? null, pending: restBodies.length };
  }

  const { first, rest } = splitQueueBatch(messages.map((message) => message.body ?? message));
  if (!first) {
    if (typeof batch?.ackAll === "function") batch.ackAll();
    return { outcome: "noop" };
  }
  const io = budgetedIoFor(first.taskType, env);
  const now = deps.now ?? (() => new Date().toISOString());
  const owner = `v2-consumer-${first.taskType}`;

  // The message only SELECTS the entry point; the real task content and type
  // come from D1 and are cross-checked — a stale or lying message is acked,
  // never spun on.
  const task = await getTask(io.db, first.taskId);
  let result;
  if (!task || task.type !== first.taskType) {
    result = { outcome: "noop", taskId: first.taskId, code: "task_type_mismatch" };
  } else if (first.taskType === "projection") {
    result = await projectOne({
      io, taskId: first.taskId, owner, now: now(),
      reducer: deps.reducer ?? reducerForScope(task, deps)
    });
  } else if (first.taskType === "projection_build") {
    result = await continueBuild({
      io, taskId: first.taskId, owner, now: now(),
      reducer: deps.reducer ?? reducerForScope(task, deps)
    });
  } else {
    result = await archiveOne({
      io, taskId: first.taskId, owner, now: now(),
      client: deps.archiveClient ?? createArchiveClient({
        env,
        io,
        folderId: env.RDS2_ARCHIVE_FOLDER_ID ?? env.GOOGLE_DRIVE_FOLDER_ID,
        tokenProvider: () => accessToken(env, io.fetch)
      })
    });
  }

  // Success and a deterministic parking (needs_attention is already recorded
  // in the task state) are acked; a retryable failure asks for the message
  // again. The queue never re-dispatches: dispatchOne is the producer side.
  const settled = result.outcome !== "retry";
  const rawMessages = batch.messages;
  if (settled) {
    if (typeof rawMessages[0]?.ack === "function") rawMessages[0].ack();
  } else if (typeof rawMessages[0]?.retry === "function") {
    rawMessages[0].retry();
  }
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
    const result = await dispatchOneForRecovery({ io, taskId, owner: "v2-recovery", now: now() });
    if (result.outcome === "continued") dispatched += 1;
  }
  return { recovered: recovery.recovered ?? 0, dispatched };
}

// The recovery wake hands expired leases back to their queues — this is the
// one place dispatchOne belongs (it is the producer side), unlike the queue
// consumers above.
async function dispatchOneForRecovery({ io, taskId, owner, now }) {
  const { dispatchOne } = await import("./tasks/dispatcher.js");
  return dispatchOne({ io, taskId, owner, now });
}
