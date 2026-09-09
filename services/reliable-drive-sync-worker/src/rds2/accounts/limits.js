// T04: fixed-window account-operation rate limiting. The counter and the
// decision are one D1 batch; the caller's invocation budget therefore sees
// exactly one outbound operation and cannot race a read-then-write counter.
import { hashText } from "../identity/hashing.js";

const WINDOWS = new Set([60 * 60 * 1000, 10 * 60 * 1000]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export async function consumeLimit({ io, bucket, window, max, now } = {}) {
  if (!io?.db || typeof bucket !== "string" || !bucket
    || !WINDOWS.has(window) || !Number.isSafeInteger(max) || max < 1) {
    throw fail("invalid_rate_limit");
  }
  const instant = now ?? Date.now();
  const epoch = typeof instant === "number" ? instant : Date.parse(instant);
  if (!Number.isFinite(epoch)) throw fail("invalid_timestamp");
  const windowStart = Math.floor(epoch / window) * window;
  const bucketKey = await hashText(`${bucket}:${windowStart}`);
  const expiresAt = windowStart + window;
  const result = await io.db.batch([
    io.db.prepare(
      `INSERT INTO rds2_account_limits(bucket_key, attempts, expires_at)
       VALUES (?, 1, ?)
       ON CONFLICT(bucket_key) DO UPDATE SET attempts = rds2_account_limits.attempts + 1
       RETURNING attempts, expires_at`
    ).bind(bucketKey, expiresAt)
  ]);
  const row = result?.[0]?.results?.[0] ?? result?.[0]?.result?.[0] ?? null;
  const attempts = Number(row?.attempts ?? 0);
  return {
    allowed: attempts <= max,
    attempts,
    max,
    bucketKey,
    expiresAt
  };
}

export async function cleanupAccountRecords({ io, now, limit = 20 } = {}) {
  if (!io?.db || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    throw fail("invalid_cleanup_limit");
  }
  const instant = now ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(instant))) throw fail("invalid_timestamp");
  const result = await io.db.batch([
    io.db.prepare(
      `DELETE FROM rds2_pairing_redemptions
        WHERE recover_until <= ? LIMIT ?`
    ).bind(instant, limit),
    io.db.prepare(
      `DELETE FROM rds2_pairing_tickets
        WHERE expires_at <= ? LIMIT ?`
    ).bind(instant, limit)
  ]);
  return {
    redemptionsDeleted: Number(result?.[0]?.meta?.changes ?? 0),
    ticketsDeleted: Number(result?.[1]?.meta?.changes ?? 0)
  };
}

