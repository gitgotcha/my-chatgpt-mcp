// The single input boundary for the account gateway. It deliberately owns
// shape/routing validation only; account authorization and business data stay
// in their respective services.
import { classifySubmission } from "./rds2-protocol.mjs";

const ACCOUNT_OPERATIONS = new Set([
  "account.current",
  "account.find",
  "account.register",
  "account.bind",
  "account.switch",
  "account.unbind",
  "account.transfer.create",
  "account.transfer.redeem"
]);
const QUERY_OPERATIONS = new Set([
  "capabilities",
  "user.resolve",
  "projection.read",
  "interview.session.list",
  "interview.session.load",
  "event.status"
]);
const PUBLIC_OPERATIONS = new Set(["capabilities"]);
const ACCOUNT_WITHOUT_EXPECTED_BINDING = new Set([
  "account.current", "account.find", "account.register", "account.transfer.redeem"
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[\x21-\x7e]{1,200}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/u;

function fail(code, detail) {
  const error = new Error(code);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function exactKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function validateRequestId(value) {
  if (typeof value !== "string" || !REQUEST_ID.test(value)) throw fail("invalid_params");
}

function validateBindingContext(value, { allowNullUser = false } = {}) {
  if (!isPlainObject(value)) throw fail("invalid_binding_context");
  const allowed = new Set(["installationId", "bindingEpoch", "bindingRevision", "userId"]);
  if (!exactKeys(value, allowed)
    || !nonEmptyString(value.installationId)
    || !UUID.test(value.installationId)
    || !UUID.test(value.bindingEpoch)
    || !Number.isSafeInteger(value.bindingRevision)
    || value.bindingRevision < 0) {
    throw fail("invalid_binding_context");
  }
  if (value.userId === null && allowNullUser) return structuredClone(value);
  if (!UUID.test(value.userId)) throw fail("invalid_binding_context");
  return structuredClone(value);
}

function validateExpectedBinding(params) {
  if (!Object.hasOwn(params, "expectedBinding")) throw fail("binding_context_required");
  return validateBindingContext(params.expectedBinding, { allowNullUser: true });
}

function validateLimit(value) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 50)) {
    throw fail("invalid_params");
  }
}

function validateCursor(value) {
  if (value !== undefined && !nonEmptyString(value)) throw fail("invalid_params");
}

function validateAccountParams(operation, params) {
  if (!isPlainObject(params)) throw fail("invalid_params");
  switch (operation) {
    case "account.current":
      if (Object.keys(params).length !== 0) throw fail("invalid_params");
      break;
    case "account.find":
      if (!exactKeys(params, new Set(["displayName", "cursor"]))) throw fail("invalid_params");
      if (params.displayName !== undefined && !nonEmptyString(params.displayName)) throw fail("invalid_params");
      validateCursor(params.cursor);
      break;
    case "account.register":
      if (!exactKeys(params, new Set(["displayName", "requestId"]))
        || !nonEmptyString(params.displayName)) throw fail("invalid_params");
      validateRequestId(params.requestId);
      break;
    case "account.bind":
    case "account.switch":
      if (!exactKeys(params, new Set(["accountHandle", "expectedBinding"]))
        || !nonEmptyString(params.accountHandle)) throw fail("invalid_params");
      validateExpectedBinding(params);
      break;
    case "account.unbind":
      if (!exactKeys(params, new Set(["expectedBinding"]))) throw fail("invalid_params");
      validateExpectedBinding(params);
      break;
    case "account.transfer.create":
      if (Object.keys(params).length !== 0) throw fail("invalid_params");
      break;
    case "account.transfer.redeem":
      if (!exactKeys(params, new Set(["requestId"]))) throw fail("invalid_params");
      validateRequestId(params.requestId);
      break;
    default:
      throw fail("invalid_operation");
  }
}

function validateQueryParams(operation, params) {
  if (!isPlainObject(params)) throw fail("invalid_params");
  switch (operation) {
    case "capabilities":
      if (Object.keys(params).length !== 0) throw fail("invalid_params");
      break;
    case "user.resolve":
      if (!exactKeys(params, new Set(["displayName"])) || !nonEmptyString(params.displayName)) throw fail("invalid_params");
      break;
    case "projection.read":
      if (!exactKeys(params, new Set(["namespace", "projectionName", "limit", "cursor"]))
        || !nonEmptyString(params.namespace) || !nonEmptyString(params.projectionName)) throw fail("invalid_params");
      validateLimit(params.limit);
      validateCursor(params.cursor);
      break;
    case "interview.session.list":
      if (!exactKeys(params, new Set(["limit", "cursor"]))) throw fail("invalid_params");
      validateLimit(params.limit);
      validateCursor(params.cursor);
      break;
    case "interview.session.load":
      if (!exactKeys(params, new Set(["sessionId"])) || !nonEmptyString(params.sessionId)) throw fail("invalid_params");
      break;
    case "event.status": {
      if (!exactKeys(params, new Set(["targetRequestId", "targetEventId"]))) throw fail("invalid_params");
      const request = params.targetRequestId;
      const event = params.targetEventId;
      if ((request === undefined) === (event === undefined)
        || (request !== undefined && !nonEmptyString(request))
        || (event !== undefined && !nonEmptyString(event))) throw fail("invalid_params");
      break;
    }
    default:
      throw fail("invalid_operation");
  }
}

function parseStorageInput(input) {
  const allowed = new Set(["storageVersion", "operation", "params", "bindingContext"]);
  if (!isPlainObject(input) || input.storageVersion !== 2 || !exactKeys(input, allowed)
    || typeof input.operation !== "string" || !isPlainObject(input.params)) {
    throw fail("invalid_input_shape");
  }
  const operation = input.operation;
  const kind = ACCOUNT_OPERATIONS.has(operation) ? "account" : QUERY_OPERATIONS.has(operation) ? "query" : null;
  if (!kind) throw fail("invalid_operation");
  const bindingContext = input.bindingContext === undefined
    ? null
    : validateBindingContext(input.bindingContext, { allowNullUser: true });
  if (kind === "account") {
    validateAccountParams(operation, input.params);
    if (operation === "account.transfer.create" && bindingContext === null) {
      throw fail("binding_context_required");
    }
  } else {
    validateQueryParams(operation, input.params);
    if (!PUBLIC_OPERATIONS.has(operation) && bindingContext === null) {
      throw fail("binding_context_required");
    }
  }
  return {
    kind,
    body: { storageVersion: 2, operation, params: structuredClone(input.params) },
    bindingContext
  };
}

function parseBusinessInput(input) {
  if (!isPlainObject(input)) throw fail("invalid_input_shape");
  const hasBinding = Object.hasOwn(input, "bindingContext");
  if (!hasBinding || input.bindingContext === undefined) throw fail("binding_context_required");
  const bindingContext = validateBindingContext(input.bindingContext, { allowNullUser: false });
  const body = structuredClone(input);
  delete body.bindingContext;
  let classified;
  try {
    classified = classifySubmission(body);
  } catch (error) {
    if (error?.status) {
      const wrapped = fail(error.status);
      wrapped.cause = error;
      throw wrapped;
    }
    throw error;
  }
  if (classified.kind !== "write") throw fail("unsupported_write_type");
  return { kind: "write", body: classified.envelope, bindingContext };
}

export function parseSubmission(input) {
  if (!isPlainObject(input)) throw fail("invalid_input_shape");
  const eventShape = Object.hasOwn(input, "schemaVersion") || Object.hasOwn(input, "namespace")
    || Object.hasOwn(input, "eventType") || Object.hasOwn(input, "requestId");
  const storageShape = Object.hasOwn(input, "storageVersion")
    || Object.hasOwn(input, "operation") || (Object.hasOwn(input, "bindingContext") && !eventShape);
  if (storageShape && eventShape) throw fail("invalid_input_shape");
  if (storageShape) return parseStorageInput(input);
  if (eventShape) return parseBusinessInput(input);
  throw fail("invalid_input_shape");
}

export function sameBinding(left, right) {
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  return left.installationId === right.installationId
    && left.bindingEpoch === right.bindingEpoch
    && left.bindingRevision === right.bindingRevision
    && left.userId === right.userId;
}

export function normalizeName(value) {
  if (typeof value !== "string") throw fail("invalid_display_name");
  let normalized;
  try { normalized = value.normalize("NFKC").trim(); } catch { throw fail("invalid_display_name"); }
  if (!normalized || CONTROL_CHARS.test(normalized)) throw fail("invalid_display_name");
  for (const character of normalized) {
    const code = character.codePointAt(0);
    if (code >= 0xd800 && code <= 0xdfff) throw fail("invalid_display_name");
  }
  const scalarLength = [...normalized].length;
  const byteLength = new TextEncoder().encode(normalized).byteLength;
  if (scalarLength < 1 || scalarLength > 80 || byteLength > 320) throw fail("invalid_display_name");
  return normalized;
}

export const ACCOUNT_OPERATIONS_LIST = Object.freeze([...ACCOUNT_OPERATIONS]);
export const QUERY_OPERATIONS_LIST = Object.freeze([...QUERY_OPERATIONS]);
