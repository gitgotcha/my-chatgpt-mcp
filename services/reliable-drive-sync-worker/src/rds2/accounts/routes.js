// T04: the Worker-side account HTTP gateway. MCP still exposes one tool; this
// private HTTP surface is only the server implementation used by that tool.
import { authenticate } from "../identity/auth.js";
import { createInvocationIo } from "../io/invocation-io.js";
import { createPairing, redeemPairing } from "./pairing.js";
import { registerAccount } from "./registration.js";
import { consumeLimit } from "./limits.js";

const MAX_BODY_BYTES = 4 * 1024;
const RATE_LIMIT_WINDOWS = Object.freeze({ register: 60 * 60 * 1000, redeem: 10 * 60 * 1000, create: 60 * 60 * 1000 });
const RATE_LIMIT_MAX = Object.freeze({ register: 5, redeem: 10, create: 5 });

function error(code, status = 500) {
  const response = new Response(JSON.stringify({ error: { code } }), { status, headers: { "content-type": "application/json" } });
  return response;
}

const statusFor = Object.freeze({
  invalid_params: 400,
  invalid_request_id: 400,
  invalid_display_name: 400,
  invalid_registration_proof: 400,
  invalid_pairing_code: 400,
  account_self_register_disabled: 503,
  account_operations_disabled: 503,
  insecure_transport: 400,
  request_too_large: 413,
  invalid_json: 400,
  invalid_operation: 400,
  missing_rate_limit_context: 503,
  rate_limited: 429,
  invalid_credential: 401,
  unknown_credential: 401,
  credential_revoked: 401,
  user_disabled: 401,
  source_not_authorized: 403,
  pairing_not_found: 404,
  pairing_expired: 410,
  pairing_used: 409,
  pairing_conflict: 409,
  registration_conflict: 409,
  credential_unavailable: 409,
  invalid_rate_limit: 500
});

function responseFor(code, status) {
  return error(code, status ?? statusFor[code] ?? 500);
}

async function readLimited(request, limit) {
  if (!request.body) return "";
  const reader = request.body.getReader?.();
  if (!reader) {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > limit) throw Object.assign(new Error("request_too_large"), { code: "request_too_large" });
    return new TextDecoder().decode(bytes);
  }
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel("request_too_large");
        throw Object.assign(new Error("request_too_large"), { code: "request_too_large" });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function credentialFrom(request) {
  const value = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim() || null;
}

function trustedIp(request) {
  const value = request.headers.get("CF-Connecting-IP")?.trim();
  return value || null;
}

function featureEnabled(env, key) {
  return env?.[key] === "true";
}

function shapeOf(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)
    || body.storageVersion !== 2 || typeof body.operation !== "string"
    || !body.params || typeof body.params !== "object" || Array.isArray(body.params)
    || Object.keys(body).some((key) => !["storageVersion", "operation", "params"].includes(key))) {
    throw Object.assign(new Error("invalid_params"), { code: "invalid_params" });
  }
  return body;
}

async function rate(io, request, operation, env, now, principal = null) {
  const ip = trustedIp(request);
  const salt = typeof env?.ACCOUNT_RATE_LIMIT_SALT === "string" ? env.ACCOUNT_RATE_LIMIT_SALT.trim() : "";
  if (!ip || !salt) throw Object.assign(new Error("missing_rate_limit_context"), { code: "missing_rate_limit_context" });
  const kind = operation === "account.register" ? "register" : operation === "account.transfer.redeem" ? "redeem" : "create";
  const identity = principal?.userId ?? "anonymous";
  const result = await consumeLimit({
    io,
    bucket: `${salt}:${kind}:${ip}:${identity}`,
    window: RATE_LIMIT_WINDOWS[kind],
    max: RATE_LIMIT_MAX[kind],
    now
  });
  if (!result.allowed) throw Object.assign(new Error("rate_limited"), { code: "rate_limited" });
  return result;
}

export async function handleAccountRequest(request, env = {}, deps = {}) {
  try {
    if (!featureEnabled(env, "ACCOUNT_OPERATIONS_ENABLED")) return responseFor("account_operations_disabled");
    if (request.method !== "POST") return responseFor("invalid_params", 405);
    if (new URL(request.url).protocol !== "https:") return responseFor("insecure_transport");
    const raw = await readLimited(request, MAX_BODY_BYTES);
    let body;
    try { body = shapeOf(JSON.parse(raw)); } catch (cause) {
      const code = cause?.code === "request_too_large" ? cause.code : "invalid_json";
      return responseFor(code);
    }
    const operation = body.operation;
    if (!["account.current", "account.register", "account.transfer.create", "account.transfer.redeem"].includes(operation)) {
      return responseFor("invalid_operation");
    }
    if ((operation === "account.register" || operation === "account.transfer.redeem")
      && !featureEnabled(env, "ACCOUNT_SELF_REGISTER_ENABLED")) return responseFor("account_self_register_disabled");

    const db = deps.db ?? env.DB;
    const now = deps.now ? deps.now() : new Date().toISOString();
    const io = createInvocationIo({ db, limit: 20, fetchImpl: deps.fetchImpl });
    const token = credentialFrom(request);
    let principal = null;
    if (operation !== "account.register" && operation !== "account.transfer.redeem") {
      principal = await authenticate({ db: io.db, credential: token });
    }
    await rate(io, request, operation, env, now, principal);

    if (operation === "account.current") {
      return Response.json({ storageVersion: 2, state: "authenticated", userId: principal.userId, displayName: principal.username }, { status: 200 });
    }
    if (operation === "account.register") {
      if (!Object.hasOwn(body.params, "displayName") || !Object.hasOwn(body.params, "requestId")) return responseFor("invalid_params");
      const secret = token;
      const result = await registerAccount({ io, requestId: body.params.requestId, name: body.params.displayName, secret, now });
      return Response.json(result, { status: result.created ? 201 : 200 });
    }
    if (operation === "account.transfer.create") {
      if (!Object.hasOwn(body.params, "code")) return responseFor("invalid_params");
      const result = await createPairing({ io, principal, code: body.params.code, now });
      return Response.json(result, { status: result.created ? 201 : 200 });
    }
    if (!Object.hasOwn(body.params, "requestId") || !Object.hasOwn(body.params, "code")) return responseFor("invalid_params");
    const result = await redeemPairing({ io, requestId: body.params.requestId, code: body.params.code, secret: token, now });
    return Response.json(result, { status: result.created ? 201 : 200 });
  } catch (cause) {
    const code = cause?.code ?? "internal_error";
    return responseFor(code, cause?.status);
  }
}

