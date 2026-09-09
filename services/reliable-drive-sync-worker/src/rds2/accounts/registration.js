// T03: self-service account registration. This module knows only account
// metadata and idempotency proofs; it never emits a learning event.
import { canonicalJson } from "../../../../../shared/rds2-protocol.mjs";
import { normalizeName } from "../../../../../shared/device-binding-protocol.mjs";
import { hashText } from "../identity/hashing.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function ensureIo(io) {
  if (!io?.db) throw fail("missing_db_binding");
  return io.db;
}

function isUnique(error) {
  return /UNIQUE constraint failed|already exists|constraint failed/i.test(String(error?.message ?? ""));
}

function timestamp(value) {
  const result = value ?? new Date().toISOString();
  if (typeof result !== "string" || Number.isNaN(Date.parse(result))) throw fail("invalid_timestamp");
  return result;
}

function nextUserId(uuid) {
  const value = typeof uuid === "function" ? uuid() : uuid ?? crypto.randomUUID();
  if (typeof value !== "string" || !UUID.test(value)) throw fail("invalid_user_id");
  return value;
}

async function replayIfConsistent(db, intent, proofHash, inputHash, now) {
  if (!intent) return null;
  if (intent.proof_hash !== proofHash || intent.input_hash !== inputHash) {
    throw fail("registration_conflict");
  }
  const row = await db.prepare(
    `SELECT u.user_id, u.display_name, u.status, c.status AS credential_status
       FROM rds2_registration_intents i
       JOIN rds2_users u ON u.user_id = i.user_id
       JOIN rds2_credentials c ON c.user_id = i.user_id AND c.credential_hash = i.proof_hash
      WHERE i.request_id = ?`
  ).bind(intent.request_id).first();
  if (!row || row.credential_status !== "active") throw fail("credential_unavailable");
  return {
    storageVersion: 2,
    userId: row.user_id,
    displayName: row.display_name,
    status: row.status,
    created: false,
    replayed: true,
    at: now
  };
}

export async function registerAccount({ io, requestId, name, secret, now, uuid } = {}) {
  const db = ensureIo(io);
  if (typeof requestId !== "string" || !requestId.trim()) throw fail("invalid_request_id");
  if (typeof secret !== "string" || !secret) throw fail("invalid_registration_proof");
  const displayName = normalizeName(name);
  const at = timestamp(now);
  const proofHash = await hashText(secret);
  const inputHash = await hashText(canonicalJson({ displayName }));

  const existing = await db.prepare(
    "SELECT request_id, proof_hash, input_hash, user_id FROM rds2_registration_intents WHERE request_id = ?"
  ).bind(requestId).first();
  const replay = await replayIfConsistent(db, existing, proofHash, inputHash, at);
  if (replay) return replay;

  const userId = nextUserId(uuid);
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO rds2_users (user_id, name_key, display_name, status, created_at)
         VALUES (?, ?, ?, 'active', ?)`
      ).bind(userId, displayName, displayName, at),
      db.prepare(
        `INSERT INTO rds2_credentials (credential_hash, user_id, status, created_at)
         VALUES (?, ?, 'active', ?)`
      ).bind(proofHash, userId, at),
      db.prepare(
        `INSERT INTO rds2_registration_intents (request_id, proof_hash, input_hash, user_id, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(requestId, proofHash, inputHash, userId, at)
    ]);
    return { storageVersion: 2, userId, displayName, status: "active", created: true, replayed: false, at };
  } catch (error) {
    if (!isUnique(error)) throw error;
    // A concurrent winner may have committed the same intent. One bounded
    // authoritative recheck resolves it; no fallback by display name occurs.
    const winner = await db.prepare(
      "SELECT request_id, proof_hash, input_hash, user_id FROM rds2_registration_intents WHERE request_id = ?"
    ).bind(requestId).first();
    const recovered = await replayIfConsistent(db, winner, proofHash, inputHash, at);
    if (recovered) return recovered;
    throw fail("registration_conflict");
  }
}
