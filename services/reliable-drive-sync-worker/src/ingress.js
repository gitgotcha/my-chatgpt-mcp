import { inspectEnvelope, ProtocolError } from "./protocol.js";
import { genericProfileEnabled } from "./capabilities.js";
import { validateGenericProfileDomain, validateGenericProfileEvent } from "./generic-profile-contract.js";
import { JobRepositoryError } from "./job-repository.js";

const encoder = new TextEncoder();

const GENERIC_READ_EVENTS = new Set([
  "system.capabilities.read",
  "system.user.resolve",
  "profile.snapshot.read"
]);

export function secureEquals(left, right) {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < Math.max(leftBytes.length, rightBytes.length); index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function json(value, status) {
  return Response.json(value, { status });
}

function authorize(request, env) {
  const expected = env?.MCP_BEARER_TOKEN;
  if (typeof expected !== "string" || !expected) return json({ error: "service_unavailable" }, 503);
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);
  if (!secureEquals(header.slice("Bearer ".length), expected)) return json({ error: "forbidden" }, 403);
  return null;
}

function readOnlyQuery(envelope) {
  if (GENERIC_READ_EVENTS.has(envelope.eventType)) return true;
  if (["interview.session.list", "interview.session.load"].includes(envelope.eventType)) return true;
  return envelope.eventType === "system.legacy-migration-requested"
    && envelope.payload?.mode === "dry-run";
}

function identityError(cause) {
  const code = cause instanceof Error ? cause.message : "identity_lookup_failed";
  if (code === "invalid_display_name") return json({ error: code }, 400);
  if (code === "identity_not_found") return json({ error: code }, 404);
  if (code === "user_conflict" || code === "identity_mismatch") return json({ error: code }, 409);
  return json({ error: "identity_lookup_failed" }, 500);
}

export function createIngressHandler(env, repository, dispatcher, services = {}) {
  return async (request, context) => {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/v1/identity") {
      const denied = authorize(request, env);
      if (denied) return denied;
      if (typeof services.identityLookup !== "function") return json({ error: "service_unavailable" }, 503);
      try {
        const identity = await services.identityLookup(url.searchParams.get("username") ?? "");
        if (!identity) return json({ error: "identity_not_found" }, 404);
        return json({
          identity: {
            userId: identity.userId,
            username: identity.displayName,
            verified: true
          }
        }, 200);
      } catch (cause) {
        return identityError(cause);
      }
    }

    if (request.method === "POST" && url.pathname === "/v1/query") {
      const denied = authorize(request, env);
      if (denied) return denied;
      if (typeof services.query !== "function") return json({ error: "service_unavailable" }, 503);
      let body;
      try {
        body = inspectEnvelope(await request.json());
      } catch (cause) {
        return cause instanceof ProtocolError
          ? json({ error: cause.message }, 400)
          : json({ error: "invalid_json" }, 400);
      }
      if (!readOnlyQuery(body)) return json({ error: "write_requires_outbox" }, 405);
      try {
        return json(await services.query(body), 200);
      } catch (cause) {
        if (cause instanceof ProtocolError) return json({ error: cause.message }, 400);
        return json({ error: cause instanceof Error ? cause.message : "query_failed" }, 500);
      }
    }

    if (request.method !== "POST" || url.pathname !== "/v1/jobs") return json({ error: "not_found" }, 404);

    const denied = authorize(request, env);
    if (denied) return denied;

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    try {
      const envelope = inspectEnvelope(body);
      if (readOnlyQuery(envelope)) return json({ error: "read_requires_query" }, 405);
      if (envelope.eventType === "profile.evidence.recorded") {
        if (!genericProfileEnabled(env)) return json({ error: "unsupported_capability" }, 400);
        try {
          validateGenericProfileDomain(envelope.payload?.domain);
        } catch {
          return json({ error: "invalid_domain" }, 400);
        }
        if (!envelope.identity?.userId || !envelope.identity?.username) {
          return json({ error: "invalid_identity" }, 400);
        }
        try {
          validateGenericProfileEvent(envelope.payload.event, {
            boundIdentity: envelope.identity,
            domain: envelope.payload.domain
          });
        } catch (cause) {
          return json({ error: cause instanceof Error && cause.message === "invalid_domain" ? "invalid_domain" : "invalid_profile_event" }, 400);
        }
      }
      const job = await repository.createOrGet(envelope);
      if (job.isNew && dispatcher && context?.waitUntil) {
        context.waitUntil(dispatcher.dispatch(job.jobId));
      }
      return json({ jobId: job.jobId, state: job.state }, 202);
    } catch (cause) {
      if (cause instanceof ProtocolError) return json({ error: cause.message }, 400);
      if (cause instanceof JobRepositoryError && cause.code === "request_id_conflict") {
        return json({ error: cause.code }, 409);
      }
      return json({ error: "job_acceptance_failed" }, 500);
    }
  };
}
