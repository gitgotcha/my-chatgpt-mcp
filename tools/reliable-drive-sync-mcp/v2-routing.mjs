// T10: the fixed V1→V2 read mapping.
//
// The five V1 read messages map to exactly these V2 operations — the mapping
// is frozen, extra operations cannot appear, and write events are never
// routable through it. The profile read binds its domain as the projection
// name; the resolve call carries only the display name, exactly as the
// addendum §5 response contract demands.
export const V2_OPERATIONS = Object.freeze({
  "system.capabilities.read": "capabilities",
  "system.user.resolve": "user.resolve",
  "interview.session.list": "interview.session.list",
  "interview.session.load": "interview.session.load",
  "profile.snapshot.read": "projection.read"
});

export function isV2ReadMessage(envelope) {
  return typeof envelope?.eventType === "string"
    && Object.hasOwn(V2_OPERATIONS, envelope.eventType);
}

function statusInputError() {
  const error = new Error("invalid_v2_status_input");
  error.code = "invalid_v2_status_input";
  return error;
}

// The V2 status query has an explicit schema: {storageVersion:2,
// operation:'event.status', params:{targetRequestId | targetEventId}} with
// exactly one target. A V1 event type is never forged into this shape.
export function parseV2StatusInput(input) {
  if (!input || typeof input !== "object") throw statusInputError();
  if (input.storageVersion !== 2 || input.operation !== "event.status") throw statusInputError();
  const params = input.params ?? {};
  if (typeof params !== "object" || Array.isArray(params)) throw statusInputError();
  const allowed = new Set(["targetRequestId", "targetEventId"]);
  for (const key of Object.keys(params)) {
    if (!allowed.has(key)) throw statusInputError();
  }
  const hasRequest = params.targetRequestId !== undefined;
  const hasEvent = params.targetEventId !== undefined;
  if (hasRequest === hasEvent) throw statusInputError();
  if (hasRequest && (typeof params.targetRequestId !== "string" || !params.targetRequestId.trim())) {
    throw statusInputError();
  }
  if (hasEvent && (typeof params.targetEventId !== "string" || !params.targetEventId.trim())) {
    throw statusInputError();
  }
  return { storageVersion: 2, operation: "event.status", params: { ...params } };
}

export function toV2Query(envelope) {
  const operation = isV2ReadMessage(envelope) ? V2_OPERATIONS[envelope.eventType] : null;
  if (!operation) {
    const error = new Error("not_a_v2_read");
    error.code = "not_a_v2_read";
    throw error;
  }
  const payload = envelope.payload ?? {};
  switch (operation) {
    case "capabilities":
      return { storageVersion: 2, operation, params: {} };
    case "user.resolve":
      // The resolve response only ever exposes the display name, so only the
      // display name is sent.
      return { storageVersion: 2, operation, params: { displayName: payload.displayName } };
    case "projection.read": {
      // The profile read's domain is bound as the projection name.
      const params = { namespace: "profile", projectionName: payload.domain };
      if (payload.limit !== undefined) params.limit = payload.limit;
      if (payload.cursor !== undefined) params.cursor = payload.cursor;
      return { storageVersion: 2, operation, params };
    }
    case "interview.session.list": {
      const params = {};
      if (payload.limit !== undefined) params.limit = payload.limit;
      if (payload.cursor !== undefined) params.cursor = payload.cursor;
      return { storageVersion: 2, operation, params };
    }
    case "interview.session.load":
      return { storageVersion: 2, operation, params: { sessionId: payload.sessionId } };
    default:
      throw new Error("not_a_v2_read");
  }
}
