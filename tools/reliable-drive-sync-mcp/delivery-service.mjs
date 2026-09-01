import { randomUUID } from "node:crypto";

const READ_ONLY_EVENTS = new Set([
  "interview.session.list",
  "interview.session.load"
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
  }
  return bound;
}

function verifiedIdentity(identity) {
  return { userId: identity.userId, username: identity.username, verified: true };
}

function permanentIdentityError(error) {
  return ["identity_mismatch", "identity_conflict", "user_conflict", "invalid_display_name", "invalid_user_id"]
    .includes(error instanceof Error ? error.message : String(error));
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
    timeoutMs = 2_000
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
        return this.pendingResult(input, identity);
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

  async resolveIdentity(username, preferredUserId) {
    const response = await this.fetchWithDeadline(`${workerOrigin(this.workerUrl)}/v1/identity?username=${encodeURIComponent(username)}`, {
      headers: { authorization: `Bearer ${this.token}` }
    });
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

  pendingResult(input, identity) {
    return {
      status: "queued_locally",
      accepted: false,
      deliveryState: "pending",
      eventKey: input.payload?.event?.eventKey ?? input.requestId,
      requestId: input.requestId,
      ...(identity ? { identity: verifiedIdentity(identity) } : {}),
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
