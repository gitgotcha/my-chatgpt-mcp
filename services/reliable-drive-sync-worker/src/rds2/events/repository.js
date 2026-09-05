// RDS V2 event repository: deterministic id derivation and the idempotency
// row lookups. Pure data access — no queue sends, no HTTP, no business rules.
import { canonicalJson, hashJson, businessKeyFor, businessKeyConfiguredFor } from "../../../../../shared/rds2-protocol.mjs";
import { hashText } from "../identity/hashing.js";

// Task and artifact ids are derived from scope + eventId + role with SHA-256,
// so a receipt can name its tasks without depending on the not-yet-assigned
// autoincrement event_seq. event_seq is only an ordering cursor.
export function deriveTaskId(scope, eventId, role) {
  return hashText(canonicalJson([scope.userId, scope.namespace, scope.projectionName, eventId, role]));
}

export function eventIdentifiers(envelope) {
  const event = envelope.payload?.event ?? {};
  return { eventId: event.eventId, eventKey: event.eventKey };
}

function rowOrFirst(result) {
  return result?.results?.[0] ?? null;
}

// One D1 batch resolves all four idempotency rows for decideIntent. The same
// rows (and the same decideIntent call) serve the pre-check and the post-
// UNIQUE recheck, so both paths can never disagree.
export async function lookupIntent({ db, principal, envelope }) {
  const { eventId, eventKey } = eventIdentifiers(envelope);
  const configured = businessKeyConfiguredFor(envelope.eventType);
  const statements = [
    db.prepare(
      "SELECT request_id, envelope_hash, canonical_event_id, receipt_json FROM rds2_requests WHERE user_id = ? AND request_id = ?"
    ).bind(principal.userId, envelope.requestId),
    db.prepare(
      `SELECT event_id, content_hash, created_by_request, namespace, projection_name
       FROM rds2_events WHERE user_id = ? AND event_id = ?`
    ).bind(principal.userId, eventId),
    db.prepare(
      `SELECT event_id, content_hash, created_by_request, namespace, projection_name
       FROM rds2_events WHERE user_id = ? AND namespace = ? AND event_key = ?`
    ).bind(principal.userId, envelope.namespace, eventKey)
  ];
  if (configured) {
    const businessKey = await businessKeyFor(envelope, principal.userId);
    statements.push(db.prepare(
      `SELECT event_id, content_hash, created_by_request, namespace, projection_name
       FROM rds2_events WHERE user_id = ? AND business_key = ?`
    ).bind(principal.userId, businessKey));
  }
  const results = await db.batch(statements);
  const request = rowOrFirst(results[0]);
  const eventById = rowOrFirst(results[1]);
  const eventByKey = rowOrFirst(results[2]);
  const businessKeyRow = configured ? rowOrFirst(results[3]) : null;
  return {
    request: request
      ? {
          requestId: request.request_id,
          envelopeHash: request.envelope_hash,
          canonicalEventId: request.canonical_event_id,
          receipt: JSON.parse(request.receipt_json)
        }
      : null,
    eventById: eventById ? shapeEventRow(eventById) : null,
    eventByKey: eventByKey ? shapeEventRow(eventByKey) : null,
    businessKey: businessKeyRow ? shapeEventRow(businessKeyRow) : null
  };
}

function shapeEventRow(row) {
  return {
    eventId: row.event_id,
    contentHash: row.content_hash,
    createdByRequest: row.created_by_request,
    namespace: row.namespace,
    projectionName: row.projection_name
  };
}

export { hashJson };
