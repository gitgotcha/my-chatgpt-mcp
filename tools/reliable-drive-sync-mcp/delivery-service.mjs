import { randomUUID } from "node:crypto";
import { validateGenericProfileDomain, validateGenericProfileEvent } from "../../services/reliable-drive-sync-worker/src/generic-profile-contract.js";

const READ_ONLY_EVENTS = new Set([
  "interview.session.list",
  "interview.session.load",
  "system.capabilities.read",
  "system.user.resolve",
  "profile.snapshot.read"
]);

// Generic profile evidence must never auto-register a stranger; resolve an
// existing identity before any durable enqueue and never fabricate a UUID.
const EXISTING_IDENTITY_WRITES = new Set(["profile.evidence.recorded"]);

const PERMANENT_ERRORS = new Set([
  "identity_mismatch",
  "identity_conflict",
  "user_conflict",
  "invalid_display_name",
  "invalid_user_id",
  "unsupported_capability",
  "invalid_domain",
  "invalid_profile_event",
  "identity_not_found"
]);

function isReadOnly(envelope) {
  return READ_ONLY_EVENTS.has(envelope.eventType)
    || (envelope.eventType === "system.legacy-migration-requested" && envelope.payload?.mode === "dry-run");
}

function workerOrigin(configuredUrl) {
  return new URL(configuredUrl).origin;
}

function usernameOf(envelope) {
  const value = envelope.identity?.username ?? envelope.payload?.username ?? envelope.payload?.displayName;
  if (typeof value !== "string" || !value.trim()) throw new Error("invalid_username");
  return value.normalize("NFKC").trim();
}

function bindIdentity(envelope, identity) {
  const bound = structuredClone(envelope);
  // `verified` is a local receipt field, not part of the schema 1.2 envelope
  // accepted by the Worker ingress.
  bound.identity = { userId: identity.userId, username: identity.username };
  bound.payload = { ...(bound.payload ?? {}), userId: identity.userId, username: identity.username };
  if (bound.payload.event && typeof bound.payload.event === "object") {
    bound.payload.event = { ...bound.payload.event, userId: identity.userId, username: identity.username };
    if (bound.eventType === "profile.evidence.recorded" && bound.payload.domain !== undefined) {
      bound.payload.event.domain = bound.payload.domain;
    }
  }
  return bound;
}

function verifiedIdentity(identity) {
  return { userId: identity.userId, username: identity.username, verified: true };
}

function permanentIdentityError(error) {
  return PERMANENT_ERRORS.has(error instanceof Error ? error.message : String(error));
}

function safeErrorCode(error, fallback = "delivery_failed") {
  const value = error instanceof Error ? error.message : String(error ?? "");
  return /^[a-z][a-z0-9_]{0,80}$/.test(value) ? value : fallback;
}

async function responseBody(response) {
  try { return await response.json(); }
  catch { return null; }
}

export class DeliveryService {
  constructor({
    outbox,
    workerUrl,
    token,
    fetchImpl = fetch,
    uuid = randomUUID,
    maxFlushEvents = 20,
    timeoutMs = 10_000
  }) {
    this.outbox = outbox;
    this.workerUrl = workerUrl;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.uuid = uuid;
    this.maxFlushEvents = maxFlushEvents;
    this.timeoutMs = timeoutMs;
  }

  async submit(input) {
    if (isReadOnly(input)) return this.query(input);
    if (EXISTING_IDENTITY_WRITES.has(input.eventType)) {
      return this.submitExistingIdentityWrite(input);
    }

    const username = usernameOf(input);
    let identity = this.outbox.findIdentity(username);
    // The hash always represents the caller's original envelope. Identity
    // binding may enrich the stored delivery copy without changing idempotency.
    this.outbox.enqueue(input);

    if (identity) {
      const bound = bindIdentity(input, identity);
      if (typeof this.outbox.bindEnvelope === "function") this.outbox.bindEnvelope(input.requestId, bound);
      else if (this.outbox.rows instanceof Map) this.outbox.rows.set(input.requestId, bound);
    } else {
      try {
        identity = await this.resolveIdentity(username, input.identity?.userId);
        const bound = bindIdentity(input, identity);
        if (typeof this.outbox.bindEnvelope === "function") this.outbox.bindEnvelope(input.requestId, bound);
        else if (this.outbox.rows instanceof Map) this.outbox.rows.set(input.requestId, bound);
      } catch (error) {
        if (permanentIdentityError(error)) {
          this.outbox.markBlocked?.(input.requestId, error.message);
          throw error;
        }
        const code = safeErrorCode(error, "identity_lookup_failed");
        this.outbox.markPending(input.requestId, code);
        return this.pendingResult(input, identity, code);
      }
    }

    const records = this.outbox.listPending().slice(0, this.maxFlushEvents);
    let accepted = false;
    for (const record of records) {
      const delivered = await this.deliver(record);
      if (record.requestId === input.requestId) accepted = delivered;
    }
    return accepted ? {
      status: "queued",
      accepted: true,
      deliveryState: "cloud_accepted",
      eventKey: input.payload?.event?.eventKey ?? input.requestId,
      requestId: input.requestId,
      identity: verifiedIdentity(identity),
      persistence: { localOutbox: "acknowledged", cloudOutbox: "accepted", drive: "pending" }
    } : this.pendingResult(input, identity);
  }

  async flushPending() {
    for (const record of this.outbox.listPending().slice(0, this.maxFlushEvents)) {
      try { await this.deliver(record); }
      catch (error) {
        if (!permanentIdentityError(error)) throw error;
      }
    }
  }

  async resolveExistingIdentity(username, preferredUserId) {
    let response;
    try {
      response = await this.fetchWithDeadline(`${workerOrigin(this.workerUrl)}/v1/identity?username=${encodeURIComponent(username)}`, {
        headers: { authorization: `Bearer ${this.token}` }
      });
    } catch (error) {
      // Generic profile writes never fabricate a UUID on a slow lookup.
      throw new Error(safeErrorCode(error, "identity_lookup_failed"));
    }
    if (response.status === 200) {
      const body = await responseBody(response);
      const identity = body?.identity;
      if (!identity?.userId || !identity?.username) throw new Error("invalid_identity_response");
      if (preferredUserId && preferredUserId !== identity.userId) throw new Error("identity_mismatch");
      return verifiedIdentity(this.outbox.rememberIdentity(identity.username, identity.userId));
    }
    if (response.status === 404) throw new Error("identity_not_found");
    const body = await responseBody(response);
    throw new Error(body?.error ?? `identity_${response.status}`);
  }

  async submitExistingIdentityWrite(input) {
    // Validate the caller shape and domain before any durable enqueue so a
    // malformed profile event never produces a retryable job.
    try {
      validateGenericProfileDomain(input.payload?.domain);
    } catch {
      throw new Error("invalid_domain");
    }
    try {
      validateGenericProfileEvent(input.payload?.event);
    } catch (cause) {
      throw new Error(cause instanceof Error && cause.message === "invalid_domain" ? "invalid_domain" : "invalid_profile_event");
    }
    const userId = input.identity?.userId;
    const rawUsername = input.identity?.username;
    if (typeof userId !== "string" || typeof rawUsername !== "string" || !rawUsername.trim()) {
      throw new Error("invalid_identity");
    }
    const username = rawUsername.normalize("NFKC").trim();
    const cached = this.outbox.findIdentity(username);
    if (cached && cached.userId !== userId) throw new Error("identity_mismatch");

    let identity;
    if (cached) {
      identity = cached;
    } else {
      identity = await this.resolveExistingIdentity(username, userId);
    }

    const bound = bindIdentity(input, identity);
    this.outbox.enqueue(input);
    if (typeof this.outbox.bindEnvelope === "function") this.outbox.bindEnvelope(input.requestId, bound);
    else if (this.outbox.rows instanceof Map) this.outbox.rows.set(input.requestId, bound);

    const records = this.outbox.listPending().slice(0, this.maxFlushEvents);
    let accepted = false;
    for (const record of records) {
      const delivered = await this.deliver(record);
      if (record.requestId === input.requestId) accepted = delivered;
    }
    return accepted ? {
      status: "queued",
      accepted: true,
      deliveryState: "cloud_accepted",
      eventKey: input.payload?.event?.eventKey ?? input.requestId,
      requestId: input.requestId,
      identity: verifiedIdentity(identity),
      persistence: { localOutbox: "acknowledged", cloudOutbox: "accepted", drive: "pending" }
    } : this.pendingResult(input, identity);
  }

  async resolveIdentity(username, preferredUserId) {
    let response;
    try {
      response = await this.fetchWithDeadline(`${workerOrigin(this.workerUrl)}/v1/identity?username=${encodeURIComponent(username)}`, {
        headers: { authorization: `Bearer ${this.token}` }
      });
    } catch (error) {
      // For a new user without an explicit id, the Worker is authoritative and
      // will resolve/create the identity when it dispatches the accepted job.
      // Do not make a slow identity lookup prevent durable cloud acceptance.
      if (preferredUserId === undefined && safeErrorCode(error) === "ingress_timeout") {
        return verifiedIdentity(this.outbox.rememberIdentity(username, this.uuid()));
      }
      throw error;
    }
    if (response.status === 200) {
      const body = await responseBody(response);
      const identity = body?.identity;
      if (!identity?.userId || !identity?.username) throw new Error("invalid_identity_response");
      if (preferredUserId && preferredUserId !== identity.userId) throw new Error("identity_mismatch");
      return verifiedIdentity(this.outbox.rememberIdentity(identity.username, identity.userId));
    }
    if (response.status !== 404) {
      const body = await responseBody(response);
      throw new Error(body?.error ?? `identity_${response.status}`);
    }
    return verifiedIdentity(this.outbox.rememberIdentity(username, preferredUserId || this.uuid()));
  }

  async deliver(record) {
    let envelope = record.envelope;
    try {
      if (!envelope.identity?.userId) {
        const identity = this.outbox.findIdentity(usernameOf(envelope))
          ?? await this.resolveIdentity(usernameOf(envelope), envelope.identity?.userId);
        envelope = bindIdentity(envelope, identity);
        if (typeof this.outbox.bindEnvelope === "function") this.outbox.bindEnvelope(record.requestId, envelope);
      }
      this.outbox.markSending(record.requestId);
      const response = await this.fetchWithDeadline(`${workerOrigin(this.workerUrl)}/v1/jobs`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify(envelope)
      });
      const body = await responseBody(response);
      const jobId = response.status === 202 ? body?.jobId : null;
      if (jobId && this.outbox.acknowledge(record.requestId, jobId)) return true;
      if ([400, 409].includes(response.status) && permanentIdentityError(body?.error)) {
        this.outbox.markBlocked?.(record.requestId, body.error);
        throw new Error(body.error);
      }
      this.outbox.markPending(record.requestId, `ingress_${response.status}`);
    } catch (error) {
      if (permanentIdentityError(error)) throw error;
      this.outbox.markPending(record.requestId, "ingress_transport_error");
    }
    return false;
  }

  async query(envelope) {
    const response = await this.fetchWithDeadline(`${workerOrigin(this.workerUrl)}/v1/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(envelope)
    });
    const body = await responseBody(response);
    if (!response.ok) throw new Error(body?.error ?? `query_${response.status}`);
    return body;
  }

  pendingResult(input, identity, lastErrorCode) {
    return {
      status: "queued_locally",
      accepted: false,
      deliveryState: "pending",
      eventKey: input.payload?.event?.eventKey ?? input.requestId,
      requestId: input.requestId,
      ...(identity ? { identity: verifiedIdentity(identity) } : {}),
      ...(lastErrorCode ? { lastErrorCode } : {}),
      persistence: { localOutbox: "durable", cloudOutbox: "pending", drive: "pending" }
    };
  }

  async fetchWithDeadline(url, init = {}) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        this.fetchImpl(url, { ...init, signal: controller.signal }),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("ingress_timeout"));
          }, this.timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
