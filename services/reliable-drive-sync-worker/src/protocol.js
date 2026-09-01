import { SCORE_DIMENSIONS, SCORE_DIMENSION_KEYS, SCORE_TOTAL, EVIDENCE_LEVELS, QUESTION_TYPES } from "./resume-knowledge-model.js";
import { DAILY_SLOT_PLAN } from "./daily-plan-selector.js";

export const SCHEMA_VERSION = "1.2";
export const ALLOWED_NAMESPACES = new Set(["system", "algorithm", "interview", "resume-knowledge"]);
export const ALLOWED_EVENT_TYPES = new Set([
  "system.user-registered",
  "system.legacy-migration-requested",
  "algorithm.learning.completed",
  "algorithm.daily-plan-created",
  "interview.session.list",
  "interview.session.load",
  "interview.session.completed",
  "interview.review.completed",
  "resume-knowledge.resume-ingested",
  "resume-knowledge.claim-confirmed",
  "resume-knowledge.claim-rejected",
  "resume-knowledge.question-bank-created",
  "resume-knowledge.daily-plan-created",
  "resume-knowledge.answer-scored"
]);
const ALLOWED_ENVELOPE_FIELDS = new Set(["schemaVersion", "namespace", "eventType", "identity", "payload", "requestId"]);
const IDENTITY_FIELDS = new Set(["userId", "username"]);
const LEGACY_MODES = new Set(["dry-run", "execute"]);
// The migration can only ever carry data out of these pre-normalization roots.
const LEGACY_MIGRATION_DOMAINS = new Set(["algorithm", "interview"]);
const COMMON_OPTIONAL = ["userId", "username"];
const PAYLOAD_SCHEMA = new Map([
  ["system.user-registered", { required: ["displayName"], optional: [...COMMON_OPTIONAL] }],
  ["system.legacy-migration-requested", {
    required: ["displayName", "mode"],
    optional: [...COMMON_OPTIONAL, "domains", "migrationId", "approvedPlanHash"]
  }],
  ["algorithm.learning.completed", { required: ["event"], optional: [...COMMON_OPTIONAL] }],
  ["algorithm.daily-plan-created", { required: ["event"], optional: [...COMMON_OPTIONAL] }],
  ["interview.session.list", { required: [], optional: [...COMMON_OPTIONAL] }],
  ["interview.session.load", { required: ["sessionId"], optional: [...COMMON_OPTIONAL] }],
  ["interview.session.completed", { required: ["event"], optional: [...COMMON_OPTIONAL] }],
  ["interview.review.completed", { required: ["event"], optional: [...COMMON_OPTIONAL] }],
  ["resume-knowledge.resume-ingested", { required: ["event"], optional: [...COMMON_OPTIONAL] }],
  ["resume-knowledge.claim-confirmed", { required: ["event"], optional: [...COMMON_OPTIONAL] }],
  ["resume-knowledge.claim-rejected", { required: ["event"], optional: [...COMMON_OPTIONAL] }],
  ["resume-knowledge.question-bank-created", { required: ["event"], optional: [...COMMON_OPTIONAL] }],
  ["resume-knowledge.daily-plan-created", { required: ["event"], optional: [...COMMON_OPTIONAL] }],
  ["resume-knowledge.answer-scored", { required: ["event"], optional: [...COMMON_OPTIONAL] }]
]);
const namespaceFor = (eventType) => eventType.split(".")[0];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_ID = /^(MOCK|REAL)-[^/\\]+$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const SESSION_FIELDS = new Set([
  "schemaVersion", "eventId", "eventKey", "eventType", "userId", "username", "sessionId",
  "interviewType", "domain", "startedAt", "completedAt", "status", "resumeContext", "questions"
]);
const QUESTION_FIELDS = new Set([
  "questionId", "domain", "sourceTags", "topicTags", "resumeClaimIds", "weaknessId",
  "question", "originalQuestion", "originalAnswer", "followUps", "timeline"
]);
const REVIEW_FIELDS = new Set([
  "schemaVersion", "eventId", "eventKey", "eventType", "userId", "username", "sessionId",
  "interviewType", "domain", "completedAt", "reviewVersion", "sourceSessionEventId", "sourceType",
  "evidenceType", "evidenceConfidence", "questionReviews", "profileChanges", "recommendations",
  "applyProfileChanges"
]);
const QUESTION_REVIEW_FIELDS = new Set(["questionId", "assessment", "evidence", "recommendations"]);
const PROFILE_CHANGE_FIELDS = new Set([
  "kind", "outcome", "domain", "weaknessId", "variantId", "competencyId", "title", "evidenceRefs"
]);
const ALGORITHM_FIELDS = new Set([
  "schemaVersion", "eventId", "eventKey", "eventType", "userId", "username", "observedAt", "source",
  "topic", "problem", "evidence", "outcome", "tags", "confidence"
]);
const ALGORITHM_PLAN_FIELDS = new Set([
  "schemaVersion", "eventId", "eventKey", "eventType", "userId", "username",
  "localDate", "planId", "timezone", "generatedAt", "items"
]);
const RESUME_INGESTED_FIELDS = new Set([
  "schemaVersion", "eventId", "eventKey", "eventType", "userId", "username",
  "resumeVersion", "fingerprint", "activatedAt", "claims", "claimRelations", "techTags", "evidenceLocations"
]);
const RESUME_CLAIM_FIELDS = new Set([
  "schemaVersion", "eventId", "eventKey", "eventType", "userId", "username",
  "resumeVersion", "claimId", "decidedAt", "note"
]);
const RESUME_BANK_FIELDS = new Set([
  "schemaVersion", "eventId", "eventKey", "eventType", "userId", "username",
  "resumeVersion", "generatedAt", "questions"
]);
const BANK_QUESTION_FIELDS = new Set([
  "questionKey", "knowledgePointId", "evidence", "type", "prompt", "answerChain",
  "scoringPoints", "referenceAnswer", "resumeEvidenceRefs", "conditional", "confirmed",
  "masteryScore", "lastScoredLocalDate"
]);
const RESUME_PLAN_FIELDS = new Set([
  "schemaVersion", "eventId", "eventKey", "eventType", "userId", "username",
  "resumeVersion", "localDate", "planId", "timezone", "generatedAt", "items"
]);
const RESUME_PLAN_ITEM_FIELDS = new Set([
  "questionKey", "slot", "knowledgePointId", "evidence", "type", "prompt"
]);
const ANSWER_SCORED_FIELDS = new Set([
  "schemaVersion", "eventId", "eventKey", "eventType", "userId", "username",
  "questionKey", "localDate", "resumeVersion", "scoredAt", "scores", "total", "feedback"
]);
const FEEDBACK_FIELDS = new Set(["strengths", "issues", "issueCategories", "answerChain", "referenceAnswer"]);
const RESUME_CLAIM_TYPES = new Set(["resume-knowledge.claim-confirmed", "resume-knowledge.claim-rejected"]);
const DAILY_SLOTS = new Set(DAILY_SLOT_PLAN.map((entry) => entry.slot));

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_ID = /^[0-9a-z-]+$/i;
// Semantically stable question keys only: rewording a question must not create
// a new key and thereby escape the once-per-day scoring limit.
const QUESTION_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hasExactFields = (value, fields) => isObject(value) && Object.keys(value).every((field) => fields.has(field));
const nonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;
const uuid = (value) => typeof value === "string" && UUID.test(value);
const timestamp = (value) => typeof value === "string" && RFC3339.test(value) && !Number.isNaN(Date.parse(value));
const stringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
const nonEmptyStringArray = (value) => stringArray(value) && value.every(nonEmptyString);
const objectArray = (value) => Array.isArray(value) && value.every(isObject);
const number = (value) => typeof value === "number" && Number.isFinite(value);

function validateQuestion(question) {
  if (!hasExactFields(question, QUESTION_FIELDS)
    || !nonEmptyString(question.questionId) || !nonEmptyString(question.domain)
    || !stringArray(question.sourceTags) || !stringArray(question.topicTags)
    || (question.resumeClaimIds !== undefined && !stringArray(question.resumeClaimIds))
    || (question.weaknessId !== undefined && question.weaknessId !== null && !nonEmptyString(question.weaknessId))
    || !nonEmptyString(question.originalQuestion) || typeof question.originalAnswer !== "string"
    || !Array.isArray(question.followUps) || !question.followUps.every(isObject)
    || !Array.isArray(question.timeline) || !question.timeline.every(isObject)) {
    throw new ProtocolError("invalid_event");
  }
}

function validateSessionEvent(event) {
  if (!hasExactFields(event, SESSION_FIELDS)
    || event.schemaVersion !== SCHEMA_VERSION || event.eventType !== "interview.session.completed"
    || !uuid(event.eventId) || !nonEmptyString(event.eventKey) || !uuid(event.userId)
    || !nonEmptyString(event.username) || !nonEmptyString(event.sessionId) || !SESSION_ID.test(event.sessionId)
    || !["mock", "real"].includes(event.interviewType)
    || ((event.sessionId.startsWith("MOCK-") ? "mock" : "real") !== event.interviewType)
    || !nonEmptyString(event.domain) || !timestamp(event.startedAt) || !timestamp(event.completedAt)
    || event.status !== "review_pending" || !isObject(event.resumeContext)
    || Object.keys(event.resumeContext).some((field) => !["used", "source", "claims"].includes(field))
    || typeof event.resumeContext.used !== "boolean" || !nonEmptyString(event.resumeContext.source)
    || !stringArray(event.resumeContext.claims) || !Array.isArray(event.questions)) {
    throw new ProtocolError("invalid_event");
  }
  event.questions.forEach(validateQuestion);
}

function validateQuestionReview(item) {
  if (!hasExactFields(item, QUESTION_REVIEW_FIELDS) || !nonEmptyString(item.questionId)
    || typeof item.assessment !== "string" || !isObject(item.evidence)
    || !Array.isArray(item.recommendations) || !item.recommendations.every(nonEmptyString)) {
    throw new ProtocolError("invalid_event");
  }
}

function validateProfileChange(item) {
  if (!hasExactFields(item, PROFILE_CHANGE_FIELDS) || !nonEmptyString(item.kind)
    || !["failed", "passed", "observed", "improving", "closed"].includes(item.outcome)) {
    throw new ProtocolError("invalid_event");
  }
  for (const field of ["domain", "weaknessId", "variantId", "competencyId", "title"]) {
    if (item[field] !== undefined && typeof item[field] !== "string") throw new ProtocolError("invalid_event");
  }
  if (item.evidenceRefs !== undefined && !stringArray(item.evidenceRefs)) throw new ProtocolError("invalid_event");
}

function validateReviewEvent(event) {
  if (!hasExactFields(event, REVIEW_FIELDS)
    || event.schemaVersion !== SCHEMA_VERSION || event.eventType !== "interview.review.completed"
    || !uuid(event.eventId) || !nonEmptyString(event.eventKey) || !uuid(event.userId)
    || !nonEmptyString(event.username) || !SESSION_ID.test(event.sessionId)
    || !["mock", "real"].includes(event.interviewType) || !nonEmptyString(event.domain)
    || !timestamp(event.completedAt) || !Number.isInteger(event.reviewVersion) || event.reviewVersion < 1
    || !uuid(event.sourceSessionEventId) || !["mock", "real"].includes(event.sourceType)
    || event.sourceType !== event.interviewType
    || !["full_transcript", "partial_transcript", "user_recall", "structured_notes", "live_notes"].includes(event.evidenceType)
    || !["high", "medium", "low"].includes(event.evidenceConfidence)
    || !Array.isArray(event.questionReviews) || !Array.isArray(event.profileChanges)
    || !Array.isArray(event.recommendations) || !event.recommendations.every(nonEmptyString)
    || typeof event.applyProfileChanges !== "boolean") {
    throw new ProtocolError("invalid_event");
  }
  event.questionReviews.forEach(validateQuestionReview);
  event.profileChanges.forEach(validateProfileChange);
}

function validateAlgorithmEvent(event) {
  if (!hasExactFields(event, ALGORITHM_FIELDS)
    || event.schemaVersion !== SCHEMA_VERSION || event.eventType !== "algorithm.learning.completed"
    || !uuid(event.eventId) || !nonEmptyString(event.eventKey) || !uuid(event.userId)
    || !nonEmptyString(event.username) || !timestamp(event.observedAt) || !nonEmptyString(event.source)
    || !nonEmptyString(event.topic) || !isObject(event.problem) || !nonEmptyString(event.problem.title)
    || !nonEmptyString(event.problem.source) || typeof event.problem.url !== "string"
    || !nonEmptyString(event.evidence) || !["incorrect", "stuck", "partial", "completed", "correct", "consulted"].includes(event.outcome)
    || !stringArray(event.tags) || !["high", "medium", "low"].includes(event.confidence)) {
    throw new ProtocolError("invalid_event");
  }
}

function validateAlgorithmPlanEvent(event) {
  if (!hasExactFields(event, ALGORITHM_PLAN_FIELDS)
    || event.schemaVersion !== SCHEMA_VERSION || event.eventType !== "algorithm.daily-plan-created"
    || !uuid(event.eventId) || !nonEmptyString(event.eventKey) || !uuid(event.userId)
    || !nonEmptyString(event.username) || !LOCAL_DATE.test(event.localDate)
    || !nonEmptyString(event.planId) || !SAFE_ID.test(event.planId)
    || !nonEmptyString(event.timezone) || !timestamp(event.generatedAt)
    || !Array.isArray(event.items) || !event.items.every(isObject)) {
    throw new ProtocolError("invalid_event");
  }
}

function validateResumeIngestedEvent(event) {
  if (!hasExactFields(event, RESUME_INGESTED_FIELDS)
    || event.schemaVersion !== SCHEMA_VERSION || event.eventType !== "resume-knowledge.resume-ingested"
    || !uuid(event.eventId) || !nonEmptyString(event.eventKey) || !uuid(event.userId)
    || !nonEmptyString(event.username) || !nonEmptyString(event.resumeVersion)
    || !SAFE_ID.test(event.resumeVersion) || !nonEmptyString(event.fingerprint)
    || !timestamp(event.activatedAt) || !objectArray(event.claims)
    || !objectArray(event.claimRelations) || !nonEmptyStringArray(event.techTags)
    || !objectArray(event.evidenceLocations)
    || !event.claims.every((claim) => nonEmptyString(claim.claimId) && EVIDENCE_LEVELS.has(claim.evidence))) {
    throw new ProtocolError("invalid_event");
  }
}

function validateResumeClaimEvent(event) {
  if (!hasExactFields(event, RESUME_CLAIM_FIELDS)
    || event.schemaVersion !== SCHEMA_VERSION || !RESUME_CLAIM_TYPES.has(event.eventType)
    || !uuid(event.eventId) || !nonEmptyString(event.eventKey) || !uuid(event.userId)
    || !nonEmptyString(event.username) || !nonEmptyString(event.resumeVersion)
    || !nonEmptyString(event.claimId) || !SAFE_ID.test(event.claimId)
    || !timestamp(event.decidedAt) || (event.note !== undefined && typeof event.note !== "string")) {
    throw new ProtocolError("invalid_event");
  }
}

function validateBankQuestion(question) {
  if (!hasExactFields(question, BANK_QUESTION_FIELDS)
    || !nonEmptyString(question.questionKey) || !QUESTION_KEY.test(question.questionKey)
    || !nonEmptyString(question.knowledgePointId) || !EVIDENCE_LEVELS.has(question.evidence)
    || !QUESTION_TYPES.has(question.type) || !nonEmptyString(question.prompt)
    || !nonEmptyStringArray(question.answerChain) || !nonEmptyStringArray(question.scoringPoints)
    || typeof question.referenceAnswer !== "string" || !nonEmptyStringArray(question.resumeEvidenceRefs)
    || typeof question.conditional !== "boolean" || typeof question.confirmed !== "boolean"
    || !(question.masteryScore === null || number(question.masteryScore))
    || !(question.lastScoredLocalDate === null
      || (typeof question.lastScoredLocalDate === "string" && LOCAL_DATE.test(question.lastScoredLocalDate)))) {
    throw new ProtocolError("invalid_event");
  }
}

function validateResumeQuestionBankEvent(event) {
  if (!hasExactFields(event, RESUME_BANK_FIELDS)
    || event.schemaVersion !== SCHEMA_VERSION || event.eventType !== "resume-knowledge.question-bank-created"
    || !uuid(event.eventId) || !nonEmptyString(event.eventKey) || !uuid(event.userId)
    || !nonEmptyString(event.username) || !nonEmptyString(event.resumeVersion)
    || !timestamp(event.generatedAt) || !objectArray(event.questions)) {
    throw new ProtocolError("invalid_event");
  }
  event.questions.forEach(validateBankQuestion);
}

function validateResumePlanItem(item) {
  if (!hasExactFields(item, RESUME_PLAN_ITEM_FIELDS)
    || !nonEmptyString(item.questionKey) || !QUESTION_KEY.test(item.questionKey)
    || !DAILY_SLOTS.has(item.slot)
    || (item.knowledgePointId !== undefined && !nonEmptyString(item.knowledgePointId))
    || (item.evidence !== undefined && !EVIDENCE_LEVELS.has(item.evidence))
    || (item.type !== undefined && !QUESTION_TYPES.has(item.type))
    || (item.prompt !== undefined && typeof item.prompt !== "string")) {
    throw new ProtocolError("invalid_event");
  }
}

function validateResumePlanEvent(event) {
  if (!hasExactFields(event, RESUME_PLAN_FIELDS)
    || event.schemaVersion !== SCHEMA_VERSION || event.eventType !== "resume-knowledge.daily-plan-created"
    || !uuid(event.eventId) || !nonEmptyString(event.eventKey) || !uuid(event.userId)
    || !nonEmptyString(event.username) || !nonEmptyString(event.resumeVersion)
    || !LOCAL_DATE.test(event.localDate) || !nonEmptyString(event.planId) || !SAFE_ID.test(event.planId)
    || !nonEmptyString(event.timezone) || !timestamp(event.generatedAt) || !objectArray(event.items)) {
    throw new ProtocolError("invalid_event");
  }
  event.items.forEach(validateResumePlanItem);
}

function validateAnswerScoredEvent(event) {
  if (!hasExactFields(event, ANSWER_SCORED_FIELDS)
    || event.schemaVersion !== SCHEMA_VERSION || event.eventType !== "resume-knowledge.answer-scored"
    || !uuid(event.eventId) || !nonEmptyString(event.eventKey) || !uuid(event.userId)
    || !nonEmptyString(event.username) || !nonEmptyString(event.questionKey)
    || !QUESTION_KEY.test(event.questionKey) || !LOCAL_DATE.test(event.localDate)
    || !nonEmptyString(event.resumeVersion) || !timestamp(event.scoredAt)
    || !isObject(event.scores) || !isObject(event.feedback)
    || Object.keys(event.scores).length !== SCORE_DIMENSION_KEYS.length) {
    throw new ProtocolError("invalid_event");
  }
  // Every dimension stays inside its own weight and the four must add up to
  // the reported total, so a score can never be inflated by re-balancing.
  let sum = 0;
  for (const [dimension, weight] of Object.entries(SCORE_DIMENSIONS)) {
    const value = event.scores[dimension];
    if (!number(value) || value < 0 || value > weight) throw new ProtocolError("invalid_event");
    sum += value;
  }
  if (!number(event.total) || event.total < 0 || event.total > SCORE_TOTAL
    || Math.abs(sum - event.total) > 1e-9) {
    throw new ProtocolError("invalid_event");
  }
  const feedback = event.feedback;
  if (!hasExactFields(feedback, FEEDBACK_FIELDS)
    || !nonEmptyStringArray(feedback.strengths) || !nonEmptyStringArray(feedback.issues)
    || !nonEmptyStringArray(feedback.issueCategories) || !nonEmptyStringArray(feedback.answerChain)
    || typeof feedback.referenceAnswer !== "string") {
    throw new ProtocolError("invalid_event");
  }
}

export function validateEventForBoundary(event, eventType) {
  if (eventType === "interview.session.completed") validateSessionEvent(event);
  else if (eventType === "interview.review.completed") validateReviewEvent(event);
  else if (eventType === "algorithm.learning.completed") validateAlgorithmEvent(event);
  else if (eventType === "algorithm.daily-plan-created") validateAlgorithmPlanEvent(event);
  else if (eventType === "resume-knowledge.resume-ingested") validateResumeIngestedEvent(event);
  else if (RESUME_CLAIM_TYPES.has(eventType)) validateResumeClaimEvent(event);
  else if (eventType === "resume-knowledge.question-bank-created") validateResumeQuestionBankEvent(event);
  else if (eventType === "resume-knowledge.daily-plan-created") validateResumePlanEvent(event);
  else if (eventType === "resume-knowledge.answer-scored") validateAnswerScoredEvent(event);
  else throw new ProtocolError("invalid_event_type");
}

export class ProtocolError extends Error {
  constructor(status, message = status) {
    super(message);
    this.status = status;
  }
}

export function inspectEnvelope(input) {
  if (!input || input.schemaVersion !== SCHEMA_VERSION) {
    throw new ProtocolError("invalid_schema_version");
  }
  if (Object.keys(input).some((field) => !ALLOWED_ENVELOPE_FIELDS.has(field))) {
    throw new ProtocolError("invalid_envelope");
  }
  if (!ALLOWED_NAMESPACES.has(input.namespace)) {
    throw new ProtocolError("invalid_namespace");
  }
  if (!ALLOWED_EVENT_TYPES.has(input.eventType)) {
    throw new ProtocolError("invalid_event_type");
  }
  if (namespaceFor(input.eventType) !== input.namespace) {
    throw new ProtocolError("invalid_event_type");
  }
  if (typeof input.requestId !== "string" || !input.requestId.trim()) {
    throw new ProtocolError("invalid_request_id");
  }
  if (input.identity !== undefined && (input.identity === null || Array.isArray(input.identity)
    || typeof input.identity !== "object"
    || Object.keys(input.identity).some((field) => !IDENTITY_FIELDS.has(field))
    || !nonEmptyString(input.identity.username)
    || (input.identity.userId !== undefined && !uuid(input.identity.userId)))) {
    throw new ProtocolError("invalid_identity");
  }
  if (input.payload !== undefined && (input.payload === null || Array.isArray(input.payload) || typeof input.payload !== "object")) {
    throw new ProtocolError("invalid_payload");
  }
  const schema = PAYLOAD_SCHEMA.get(input.eventType);
  if (!schema) throw new ProtocolError("invalid_event_type");
  const payload = input.payload ?? {};
  const allowed = new Set([...schema.required, ...schema.optional]);
  if (Object.keys(payload).some((field) => !allowed.has(field))
    || schema.required.some((field) => payload[field] === undefined)) {
    throw new ProtocolError("invalid_payload");
  }
  if (payload.userId !== undefined && !uuid(payload.userId)) throw new ProtocolError("invalid_payload");
  if (payload.username !== undefined && !nonEmptyString(payload.username)) throw new ProtocolError("invalid_payload");
  if (input.eventType === "system.user-registered" && !nonEmptyString(payload.displayName)) throw new ProtocolError("invalid_payload");
  if (input.eventType === "system.legacy-migration-requested") {
    if (!LEGACY_MODES.has(payload.mode)) throw new ProtocolError("invalid_payload");
    if (payload.domains !== undefined && (!Array.isArray(payload.domains) || payload.domains.length === 0
      || payload.domains.some((domain) => !LEGACY_MIGRATION_DOMAINS.has(domain)))) {
      throw new ProtocolError("invalid_payload");
    }
    // execute without the approval of a concrete dry-run can copy blindly.
    if (payload.mode === "execute"
      && (!uuid(payload.migrationId) || !nonEmptyString(payload.approvedPlanHash))) {
      throw new ProtocolError("invalid_payload");
    }
  }
  if (input.eventType === "interview.session.load" && !SESSION_ID.test(payload.sessionId)) throw new ProtocolError("invalid_payload");
  return structuredClone(input);
}

export function hasEventPayload(eventType) {
  return Boolean(PAYLOAD_SCHEMA.get(eventType)?.required.includes("event"));
}

export function validateEnvelope(input) {
  const envelope = inspectEnvelope(input);
  if (hasEventPayload(envelope.eventType)) {
    validateEventForBoundary(envelope.payload.event, envelope.eventType);
  }
  return envelope;
}
