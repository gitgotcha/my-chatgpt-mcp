// Atomic event acceptance (Rev 6 plan T04 / addendum §4). One invocation
// entry receives one envelope, decides idempotency with the shared pure
// decideIntent, and — for a new submission — records event, request receipt,
// projection head seed, projection task and original-event archive task in a
// single D1 batch. accept NEVER sends Queue messages: dispatch is the
// recovery/dispatcher concern, which keeps the receipt's cloudPersistence
// claim strictly "D1 committed".
import {
  classifySubmission,
  SUBMISSION_REJECTION_CODES,
  canonicalJson,
  hashJson,
  contentHashOf,
  businessKeyFor,
  businessKeyConfiguredFor,
  decideIntent
} from "../../../../../shared/rds2-protocol.mjs";
import { lookupIntent, deriveTaskId, eventIdentifiers } from "./repository.js";

export { lookupIntent, deriveTaskId } from "./repository.js";

export const MAX_ENVELOPE_BYTES = 256 * 1024;

// The projection scope an event feeds. profile.evidence.recorded binds the
// validated domain as projectionName; the algorithm and resume-knowledge
// event families each share one projection per namespace.
const EVENT_PROJECTIONS = {
  "algorithm.learning.completed": "learning",
  "algorithm.daily-plan-created": "learning",
  "interview.session.completed": "interview",
  "interview.review.completed": "interview",
  "resume-knowledge.resume-ingested": "resume-knowledge",
  "resume-knowledge.claim-confirmed": "resume-knowledge",
  "resume-knowledge.claim-rejected": "resume-knowledge",
  "resume-knowledge.question-bank-created": "resume-knowledge",
  "resume-knowledge.daily-plan-created": "resume-knowledge",
  "resume-knowledge.answer-scored": "resume-knowledge"
};

export function projectionForEventType(eventType, payload = {}) {
  if (eventType === "profile.evidence.recorded") {
    const domain = payload?.domain;
    if (typeof domain !== "string" || !domain.trim()) throw acceptError("invalid_domain", 400);
    return domain;
  }
  const projectionName = EVENT_PROJECTIONS[eventType];
  if (!projectionName) throw acceptError("unsupported_write_type", 400);
  return projectionName;
}

function acceptError(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function isUniqueViolation(error) {
  return /UNIQUE constraint failed/i.test(String(error?.message ?? ""));
}

function crossCheckIdentity(principal, envelope) {
  const identityUserId = envelope.identity?.userId;
  if (identityUserId !== undefined && identityUserId !== principal.userId) {
    throw acceptError("identity_mismatch", 403);
  }
  const eventUserId = envelope.payload?.event?.userId;
  if (eventUserId !== undefined && eventUserId !== principal.userId) {
    throw acceptError("identity_mismatch", 403);
  }
}

export async function acceptEvent({ io, principal, envelope, now }) {
  const { kind } = classifySubmission(envelope);
  if (kind !== "write") {
    throw acceptError(SUBMISSION_REJECTION_CODES[kind], 400);
  }
  crossCheckIdentity(principal, envelope);

  // Freeze the canonical bytes first; the 256 KiB inbound limit is enforced
  // on the canonical form before any I/O happens.
  const canonical = canonicalJson(envelope);
  if (new TextEncoder().encode(canonical).length > MAX_ENVELOPE_BYTES) {
    throw acceptError("payload_too_large", 413);
  }

  const { eventId, eventKey } = eventIdentifiers(envelope);
  const requestId = envelope.requestId;
  const envelopeHash = await hashJson(envelope);
  const contentHash = await contentHashOf(envelope);
  const businessKey = await businessKeyFor(envelope, principal.userId);
  const incoming = {
    requestId,
    eventId,
    eventKey,
    eventType: envelope.eventType,
    envelopeHash,
    contentHash,
    businessKeyConfigured: businessKeyConfiguredFor(envelope.eventType)
  };

  const intent = () => lookupIntent({ db: io.db, principal, envelope });
  // One submission owns exactly one full race recheck, shared by the commit
  // batch and the alias request-row write; neither catch may retry on its own.
  let recheckBudget = 1;
  const recheck = async () => {
    if (recheckBudget <= 0) throw acceptError("unresolved_intent_race", 503);
    recheckBudget -= 1;
    const freshRows = await intent();
    const freshDecision = decideIntent(freshRows, incoming);
    if (freshDecision.outcome === "new") throw acceptError("unresolved_intent_race", 503);
    return { rows: freshRows, decision: freshDecision };
  };
  let rows = await intent();
  let decision = decideIntent(rows, incoming);
  let acceptedReceipt = null;
  if (decision.outcome === "new") {
    try {
      acceptedReceipt = await commitNewEvent({ io, principal, envelope, now, businessKey });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Unique-constraint race: re-query and re-decide with the SAME pure
      // function. A still-"new" verdict is a retryable anomaly, never
      // silently reported as success.
      ({ rows, decision } = await recheck());
    }
  }

  switch (decision.outcome) {
    case "new":
      return acceptedReceipt;
    case "replay":
      return rows.request.receipt;
    case "alias":
    case "firstResult": {
      const receipt = await buildReferencedReceipt(decision, principal, requestId, envelope);
      try {
        await recordRequestRow({ io, principal, envelopeHash, receipt, now });
        return receipt;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // The requestId was bound concurrently while we were writing the alias
        // row. Only a re-decided consistent outcome may be returned: a replay
        // requires the very same envelope hash, anything else is a stable 409.
        ({ rows, decision } = await recheck());
        if (decision.outcome === "replay") return rows.request.receipt;
        if (decision.outcome === "conflict") throw acceptError(decision.code, 409);
        throw acceptError("unresolved_intent_race", 503);
      }
    }
    case "conflict":
      throw acceptError(decision.code, 409);
    default:
      throw acceptError("unresolved_intent_race", 503);
  }
}

async function buildReferencedReceipt(decision, principal, requestId, envelope) {
  const scope = {
    userId: principal.userId,
    namespace: envelope.namespace,
    projectionName: projectionForEventType(envelope.eventType, envelope.payload)
  };
  return {
    storageVersion: 2,
    attemptedRequestId: requestId,
    canonicalRequestId: decision.createdByRequest,
    eventId: decision.eventId,
    jobId: await deriveTaskId(scope, decision.eventId, "projection"),
    userId: principal.userId,
    disposition: "already_recorded",
    ignoredDuplicate: decision.ignoredDuplicate,
    cloudPersistence: "d1_committed"
  };
}

async function recordRequestRow({ io, principal, envelopeHash, receipt, now }) {
  const timestamp = now ?? new Date().toISOString();
  // UNIQUE violations are handled by the caller's unified recheck, never by
  // reading the conflicting row's receipt here: that row may belong to a
  // different event.
  await io.db.batch([
    io.db.prepare(
      `INSERT INTO rds2_requests (user_id, request_id, envelope_hash, canonical_event_id, receipt_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      principal.userId,
      receipt.attemptedRequestId,
      envelopeHash,
      receipt.eventId,
      canonicalJson(receipt),
      timestamp
    )
  ]);
}

async function commitNewEvent({ io, principal, envelope, now, businessKey }) {
  const timestamp = now ?? new Date().toISOString();
  const { eventId, eventKey } = eventIdentifiers(envelope);
  const scope = {
    userId: principal.userId,
    namespace: envelope.namespace,
    projectionName: projectionForEventType(envelope.eventType, envelope.payload)
  };
  const projectionTaskId = await deriveTaskId(scope, eventId, "projection");
  const archiveTaskId = await deriveTaskId(scope, eventId, "archive");
  const artifactId = await deriveTaskId(scope, eventId, "artifact-event");
  const receipt = {
    storageVersion: 2,
    attemptedRequestId: envelope.requestId,
    canonicalRequestId: envelope.requestId,
    eventId,
    jobId: projectionTaskId,
    userId: principal.userId,
    disposition: "accepted",
    ignoredDuplicate: false,
    cloudPersistence: "d1_committed"
  };

  await io.db.batch([
    io.db.prepare(
      `INSERT INTO rds2_events
        (user_id, namespace, projection_name, event_id, event_key, business_key, event_type,
         created_by_request, envelope_json, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      scope.userId, scope.namespace, scope.projectionName, eventId, eventKey,
      businessKey, envelope.eventType, envelope.requestId,
      canonicalJson(envelope), await contentHashOf(envelope), timestamp
    ),
    io.db.prepare(
      `INSERT INTO rds2_requests (user_id, request_id, envelope_hash, canonical_event_id, receipt_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(scope.userId, envelope.requestId, await hashJson(envelope), eventId, canonicalJson(receipt), timestamp),
    io.db.prepare(
      `INSERT INTO rds2_projections (user_id, namespace, projection_name, revision, last_event_seq,
         active_generation, building, summary_json, updated_at)
       VALUES (?, ?, ?, 0, 0, 0, 0, NULL, ?)
       ON CONFLICT (user_id, namespace, projection_name) DO NOTHING`
    ).bind(scope.userId, scope.namespace, scope.projectionName, timestamp),
    io.db.prepare(
      `INSERT INTO rds2_tasks (task_id, type, user_id, namespace, projection_name, event_seq, artifact_id,
         state, available_at, lease_epoch, created_at, updated_at)
       SELECT ?, 'projection', ?, ?, ?, event_seq, NULL, 'pending', ?, 0, ?, ?
       FROM rds2_events WHERE user_id = ? AND event_id = ?`
    ).bind(projectionTaskId, scope.userId, scope.namespace, scope.projectionName, timestamp, timestamp, timestamp,
      scope.userId, eventId),
    io.db.prepare(
      `INSERT INTO rds2_archive_deliveries (artifact_id, user_id, namespace, projection_name, object_type,
         object_name, frozen_json, content_hash, created_at)
       VALUES (?, ?, ?, ?, 'event', ?, ?, ?, ?)`
    ).bind(artifactId, scope.userId, scope.namespace, scope.projectionName,
      `${artifactId}.json`, canonicalJson(envelope), await contentHashOf(envelope), timestamp),
    io.db.prepare(
      `INSERT INTO rds2_tasks (task_id, type, user_id, namespace, projection_name, event_seq, artifact_id,
         state, available_at, lease_epoch, created_at, updated_at)
       VALUES (?, 'archive_event', ?, ?, ?, NULL, ?, 'pending', ?, 0, ?, ?)`
    ).bind(archiveTaskId, scope.userId, scope.namespace, scope.projectionName, artifactId, timestamp, timestamp, timestamp)
  ]);
  return receipt;
}
