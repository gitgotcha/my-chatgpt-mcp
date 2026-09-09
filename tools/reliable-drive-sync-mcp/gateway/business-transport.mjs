// T06: business transport and the local linearization point.
// Authorization/network verification happens before the short control-store
// transaction. The transaction only rechecks the four binding fields and
// freezes one envelope into the per-user V2 outbox; no HTTP call can occur
// while that lock is held.
import { parseSubmission, sameBinding } from "../../../shared/device-binding-protocol.mjs";
import { randomUUID } from "node:crypto";

function fail(code, detail) {
  const error = new Error(code);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

function origin(url) {
  try { return new URL(url).origin; } catch { throw fail("invalid_worker_url"); }
}

function responsePayload(response) {
  return response.json().catch(() => null);
}

function freezeForPrincipal(body, principal) {
  const envelope = structuredClone(body);
  envelope.identity = { ...(envelope.identity ?? {}), userId: principal.userId, username: principal.username };
  envelope.payload = { ...(envelope.payload ?? {}), userId: principal.userId, username: principal.username };
  if (envelope.payload.event && typeof envelope.payload.event === "object") {
    envelope.payload.event = { ...envelope.payload.event, userId: principal.userId, username: principal.username };
  }
  return envelope;
}

export function createBusinessTransport({ deviceStore, accounts, outboxFactory, workerUrl, token, fetchImpl = fetch } = {}) {
  if (!deviceStore || typeof deviceStore.exclusive !== "function" || typeof deviceStore.current !== "function") throw fail("invalid_device_store");
  if (!accounts || typeof accounts.authorizeCurrent !== "function") throw fail("invalid_accounts");
  if (typeof outboxFactory !== "function") throw fail("invalid_outbox_factory");
  const http = fetchImpl;
  const resources = new Map();

  function resourceFor(principal) {
    const key = principal.userId;
    let resource = resources.get(key);
    if (!resource) {
      resource = outboxFactory({ userId: key, credentialRef: principal.credentialRef, context: principal.context });
      if (!resource?.outbox || typeof resource.outbox.enqueue !== "function") throw fail("invalid_outbox_factory");
      resources.set(key, resource);
    }
    return resource;
  }

  async function query(input) {
    const parsed = parseSubmission(input);
    if (parsed.kind !== "query") throw fail("unsupported_query_type");
    let credential = null;
    let principal = null;
    if (parsed.body.operation !== "capabilities") {
      principal = await accounts.authorizeCurrent(parsed.bindingContext);
      credential = principal.credential;
    }
    if (typeof http !== "function" || typeof workerUrl !== "string" || typeof token !== "string") throw fail("verification_unavailable");
    const response = await http(`${origin(workerUrl)}/v2/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential ?? token}`, "content-type": "application/json" },
      body: JSON.stringify(parsed.body)
    });
    const body = await responsePayload(response);
    if (!response.ok) throw fail(body?.error?.code ?? `query_${response.status}`);
    return body;
  }

  async function submit(input) {
    const parsed = parseSubmission(input);
    if (parsed.kind !== "write") throw fail("unsupported_write_type");
    const principal = await accounts.authorizeCurrent(parsed.bindingContext);
    const frozen = freezeForPrincipal(parsed.body, principal);
    let resource;
    let stored;
    // This callback is synchronous by contract. Any accidental network call
    // or Promise here is rejected by DeviceStore before a partial commit can
    // escape.
    deviceStore.exclusive(() => {
      const current = deviceStore.current();
      if (!sameBinding(current && {
        installationId: String(current.installationId),
        bindingEpoch: String(current.bindingEpoch),
        bindingRevision: Number(current.bindingRevision),
        userId: current.userId
      }, principal.context)) throw fail("binding_changed");
      resource = resourceFor(principal);
      stored = resource.outbox.enqueue(frozen);
    });
    // Wake/flush only after the control transaction has committed. The
    // delivery service itself owns the HTTP call and keeps the row durable if
    // the response is lost.
    resource.delivery?.wake?.();
    return {
      status: stored?.state === "blocked" ? "blocked" : "queued_locally",
      requestId: frozen.requestId,
      eventOwnerUserId: principal.userId,
      bindingChanged: false,
      persistence: { localOutbox: stored?.state === "blocked" ? "blocked" : "pending", cloudOutbox: "pending", drive: "pending" },
      duplicate: Boolean(stored?.duplicate),
      conflict: Boolean(stored?.conflict)
    };
  }

  function close() {
    for (const resource of resources.values()) {
      try { resource.delivery?.close?.(); } catch { /* best effort */ }
      try { resource.outbox?.close?.(); } catch { /* best effort */ }
    }
    resources.clear();
  }

  return { query, submit, close, resources, requestId: () => randomUUID() };
}
