// Pure generic-profile contract shared by the Worker and the local MCP
// delivery layer. No Drive, D1, HTTP or Node-only imports are allowed here so
// both sides validate identical event shapes without drifting.
export const GENERIC_PROFILE_SCHEMA_VERSION = "1.0";
export const GENERIC_PROFILE_ACTIONS = Object.freeze(["observe", "supersede", "invalidate"]);
export const GENERIC_PROFILE_OUTCOMES = Object.freeze([
  "observed", "consulted", "stuck", "incorrect", "partial",
  "completed", "correct", "passed", "failed"
]);
export const GENERIC_PROFILE_CONFIDENCES = Object.freeze(["high", "medium", "low"]);
export const GENERIC_PROFILE_RESERVED_DOMAINS = Object.freeze([
  "algorithm", "interview", "resume-knowledge", "system", "profile"
]);
const DOMAIN = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function genericProfileEnabled(env = {}) {
  return env.GENERIC_PROFILE_ENABLED === "true";
}

export function validateGenericProfileDomain(domain) {
  if (typeof domain !== "string" || !DOMAIN.test(domain)
    || GENERIC_PROFILE_RESERVED_DOMAINS.includes(domain)
    || /%2f|%5c/i.test(domain)) {
    throw new Error("invalid_domain");
  }
  return domain;
}

export function validateGenericProfileEvent(event, { boundIdentity, domain } = {}) {
  const baseFields = [
    "schemaVersion", "eventId", "eventKey", "observedAt",
    "sourceSkill", "action", "observations"
  ];
  const bound = boundIdentity !== undefined || domain !== undefined;
  if ((boundIdentity === undefined) !== (domain === undefined)) throw new Error("invalid_profile_event");
  const allowed = new Set([
    ...baseFields,
    "targetEventKey",
    ...(bound ? ["userId", "username", "domain"] : [])
  ]);
  const validObject = event && typeof event === "object" && !Array.isArray(event);
  const exact = validObject
    && baseFields.every((field) => Object.hasOwn(event, field))
    && Object.keys(event).every((field) => allowed.has(field));
  const observationsValid = Array.isArray(event?.observations)
    && event.observations.every((item) => {
      const fields = new Set([
        "dimensionKey", "subjectKey", "outcome", "evidence", "confidence", "sourceRef"
      ]);
      return item && typeof item === "object" && !Array.isArray(item)
        && Object.keys(item).length === fields.size
        && Object.keys(item).every((field) => fields.has(field))
        && [item.dimensionKey, item.subjectKey, item.evidence, item.sourceRef]
          .every((value) => typeof value === "string" && value.trim())
        && GENERIC_PROFILE_OUTCOMES.includes(item.outcome)
        && GENERIC_PROFILE_CONFIDENCES.includes(item.confidence);
    });
  const actionValid = event?.action === "observe"
    ? event.observations?.length > 0 && event.targetEventKey === undefined
    : event?.action === "supersede"
      ? event.observations?.length > 0 && typeof event.targetEventKey === "string" && event.targetEventKey.trim()
      : event?.action === "invalidate"
        ? event.observations?.length === 0 && typeof event.targetEventKey === "string" && event.targetEventKey.trim()
        : false;
  const boundValid = !bound || (UUID.test(boundIdentity?.userId)
    && typeof boundIdentity?.username === "string" && boundIdentity.username.trim()
    && event.userId === boundIdentity.userId && event.username === boundIdentity.username
    && event.domain === validateGenericProfileDomain(domain));
  if (!exact || event.schemaVersion !== GENERIC_PROFILE_SCHEMA_VERSION
    || !UUID.test(event.eventId) || typeof event.eventKey !== "string" || !event.eventKey.trim()
    || !RFC3339.test(event.observedAt) || Number.isNaN(Date.parse(event.observedAt))
    || typeof event.sourceSkill !== "string" || !event.sourceSkill.trim()
    || !observationsValid || !actionValid || !boundValid) {
    throw new Error("invalid_profile_event");
  }
  return structuredClone(event);
}
