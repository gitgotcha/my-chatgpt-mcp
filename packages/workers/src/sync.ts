import type { SyncRepository } from "./db.js";
import type { DestinationAdapter, SyncOutcome } from "./drive-adapter.js";

export type SyncEnvironment = { QSTASH_CURRENT_SIGNING_KEY?: string; QSTASH_NEXT_SIGNING_KEY?: string; SYNC_WORKER_URL?: string };
type Envelope = { jobId: string; eventKey: string; userId: string };
const encoder = new TextEncoder();

function b64url(value: string): Uint8Array { const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4); return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)); }
function safeEqual(left: Uint8Array, right: Uint8Array): boolean { let mismatch = left.length ^ right.length; for (let i = 0; i < Math.max(left.length, right.length); i += 1) mismatch |= (left[i] ?? 0) ^ (right[i] ?? 0); return mismatch === 0; }
function plain(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function envelope(value: unknown): value is Envelope { return plain(value) && typeof value.jobId === "string" && typeof value.eventKey === "string" && typeof value.userId === "string"; }

/** Verifies the QStash JWT over its exact raw body before parsing the delivered job. */
export async function verifyQStashSignature(signature: string | null, rawBody: string, url: string | undefined, keys: string[]): Promise<boolean> {
  if (!signature || !url || keys.filter(Boolean).length === 0) return false;
  const parts = signature.split("."); if (parts.length !== 3) return false;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64url(parts[0]))) as Record<string, unknown>;
    const claims = JSON.parse(new TextDecoder().decode(b64url(parts[1]))) as Record<string, unknown>;
    if (header.alg !== "HS256" || typeof claims.exp !== "number" || (typeof claims.nbf === "number" && claims.nbf > Date.now() / 1000) || claims.exp <= Date.now() / 1000 || claims.aud !== url || claims.body !== rawBody) return false;
    const signed = encoder.encode(`${parts[0]}.${parts[1]}`); const expected = b64url(parts[2]);
    for (const key of keys.filter(Boolean)) { const cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); const actual = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, signed)); if (safeEqual(actual, expected)) return true; }
  } catch { return false; }
  return false;
}

function response(status: number, headers?: HeadersInit): Response { return new Response(null, { status, headers }); }

export function createSyncHandler(env: SyncEnvironment, repository: SyncRepository, adapter: DestinationAdapter, clock: () => Date = () => new Date(), leaseId: () => string = () => crypto.randomUUID()) {
  return async (request: Request): Promise<Response> => {
    const raw = await request.text();
    const valid = await verifyQStashSignature(request.headers.get("Upstash-Signature"), raw, env.SYNC_WORKER_URL, [env.QSTASH_CURRENT_SIGNING_KEY ?? "", env.QSTASH_NEXT_SIGNING_KEY ?? ""]);
    if (!valid) return response(489, { "Upstash-NonRetryable-Error": "true" });
    let message: unknown; try { message = JSON.parse(raw); } catch { return response(489, { "Upstash-NonRetryable-Error": "true" }); }
    if (!envelope(message)) return response(489, { "Upstash-NonRetryable-Error": "true" });
    const event = await repository.loadEvent(message.jobId);
    if (!event || event.eventKey !== message.eventKey || event.userId !== message.userId) return response(489, { "Upstash-NonRetryable-Error": "true" });
    const owner = leaseId(); const now = clock();
    const claimed = await repository.claimForSync(message.jobId, owner, now, new Date(now.getTime() + 5 * 60_000));
    if (!claimed) return response(204); // duplicate/previously completed delivery
    const outcome: SyncOutcome = await adapter.sync(event);
    if (outcome.kind === "success") { await repository.markSynced(message.jobId, owner, clock()); return response(204); }
    if (outcome.kind === "retryable") { await repository.releaseSync(message.jobId, owner, outcome.code, clock()); const headers = outcome.retryAfterMs ? { "Retry-After": String(Math.ceil(outcome.retryAfterMs / 1000)) } : undefined; return response(503, headers); }
    await repository.markNeedsAttention(message.jobId, owner, outcome.code, clock());
    return response(489, { "Upstash-NonRetryable-Error": "true" });
  };
}
