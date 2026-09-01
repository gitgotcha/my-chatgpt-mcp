import { ProtocolError } from "./protocol.js";

const encoder = new TextEncoder();

function base64UrlBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function bodyHash(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function safeEqual(left, right) {
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return mismatch === 0;
}

export async function verifyQStashSignature(signature, rawBody, url, keys) {
  if (!signature || !url || keys.filter(Boolean).length === 0) return false;
  const parts = signature.split(".");
  if (parts.length !== 3) return false;
  try {
    const header = JSON.parse(new TextDecoder().decode(base64UrlBytes(parts[0])));
    const claims = JSON.parse(new TextDecoder().decode(base64UrlBytes(parts[1])));
    if (header.alg !== "HS256" || claims.iss !== "Upstash" || claims.sub !== url) return false;
    if (typeof claims.exp !== "number" || claims.exp <= Date.now() / 1000) return false;
    if (typeof claims.nbf === "number" && claims.nbf > Date.now() / 1000) return false;
    if (typeof claims.body !== "string" || claims.body.replace(/=+$/, "") !== await bodyHash(rawBody)) return false;
    const signed = encoder.encode(`${parts[0]}.${parts[1]}`);
    const expected = base64UrlBytes(parts[2]);
    for (const key of keys.filter(Boolean)) {
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        encoder.encode(key),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );
      const actual = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, signed));
      if (safeEqual(actual, expected)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function response(status, headers) {
  return new Response(null, { status, headers });
}

function validMessage(value) {
  return value && typeof value === "object"
    && typeof value.jobId === "string"
    && typeof value.requestId === "string"
    && typeof value.userId === "string";
}

function nonRetryable() {
  return response(489, { "Upstash-NonRetryable-Error": "true" });
}

function terminalStatus(status) {
  return status === "ok" || status === "already_scored_today";
}

export function createSyncHandler(
  env,
  repository,
  dispatch,
  clock = () => new Date(),
  newLeaseOwner = () => crypto.randomUUID()
) {
  return async (request) => {
    const raw = await request.text();
    const valid = await verifyQStashSignature(
      request.headers.get("Upstash-Signature"),
      raw,
      env.SYNC_WORKER_URL,
      [env.QSTASH_CURRENT_SIGNING_KEY ?? "", env.QSTASH_NEXT_SIGNING_KEY ?? ""]
    );
    if (!valid) return nonRetryable();

    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return nonRetryable();
    }
    if (!validMessage(message)) return nonRetryable();
    const envelope = await repository.loadEnvelope(message.jobId);
    if (!envelope || envelope.requestId !== message.requestId
      || envelope.identity?.userId !== message.userId) return nonRetryable();

    const owner = newLeaseOwner();
    const now = clock();
    const claimed = await repository.claimForSync(
      message.jobId,
      owner,
      now,
      new Date(now.getTime() + 5 * 60_000)
    );
    if (!claimed) {
      const job = await repository.getJob(message.jobId);
      if (job?.state === "synced") return response(204);
      if (job?.state === "needs_attention") return nonRetryable();
      return response(503);
    }

    try {
      const result = await dispatch(envelope);
      if (terminalStatus(result?.status)) {
        return await repository.markSynced(message.jobId, owner, clock()) ? response(204) : response(503);
      }
      const code = typeof result?.status === "string" ? result.status : "unknown_delivery_status";
      await repository.releaseSync(message.jobId, owner, code, clock());
      return response(503);
    } catch (cause) {
      if (cause instanceof ProtocolError) {
        await repository.markNeedsAttention(message.jobId, owner, cause.message, clock());
        await repository.openFailureNotice(message.userId, `protocol:${cause.message}`, "Google Drive synchronization needs attention.", clock());
        return nonRetryable();
      }
      await repository.releaseSync(message.jobId, owner, "delivery_failed", clock());
      return response(503);
    }
  };
}

export function createFailureCallbackHandler(env, repository, clock = () => new Date()) {
  return async (request) => {
    const raw = await request.text();
    const valid = await verifyQStashSignature(
      request.headers.get("Upstash-Signature"),
      raw,
      env.QSTASH_FAILURE_CALLBACK_URL,
      [env.QSTASH_CURRENT_SIGNING_KEY ?? "", env.QSTASH_NEXT_SIGNING_KEY ?? ""]
    );
    if (!valid) return nonRetryable();
    let callback;
    let message;
    try {
      callback = JSON.parse(raw);
      message = JSON.parse(callback.body);
    } catch {
      return nonRetryable();
    }
    if (!validMessage(message)) return nonRetryable();
    const envelope = await repository.loadEnvelope(message.jobId);
    if (!envelope || envelope.requestId !== message.requestId
      || envelope.identity?.userId !== message.userId) return nonRetryable();
    const failed = await repository.markFailureNeedsAttention(
      message.jobId,
      "qstash_delivery_exhausted",
      clock()
    );
    if (!failed) return nonRetryable();
    await repository.openFailureNotice(
      message.userId,
      "qstash:delivery_exhausted",
      "Google Drive synchronization needs attention.",
      clock()
    );
    return nonRetryable();
  };
}
