// T03: source-device pairing. Codes and device proofs are hashed before D1;
// plaintext values never appear in a return value or a persistence row.
import { hashText } from "../identity/hashing.js";

const SHA256 = /^[0-9a-f]{64}$/i;
const TEN_MINUTES = 10 * 60 * 1000;
const RECOVERY_WINDOW = 24 * 60 * 60 * 1000;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function dbOf(io) {
  if (!io?.db) throw fail("missing_db_binding");
  return io.db;
}

function at(value) {
  const result = value ?? new Date().toISOString();
  if (typeof result !== "string" || Number.isNaN(Date.parse(result))) throw fail("invalid_timestamp");
  return result;
}

function expires(base, duration) {
  return new Date(Date.parse(base) + duration).toISOString();
}

function proofInput(value, code) {
  if (typeof value !== "string" || !value) throw fail(code);
}

function isUnique(error) {
  return /UNIQUE constraint failed|constraint failed|already exists/i.test(String(error?.message ?? ""));
}

export async function createPairing({ io, principal, code, now } = {}) {
  const db = dbOf(io);
  proofInput(code, "invalid_pairing_code");
  if (!principal || typeof principal.userId !== "string" || !SHA256.test(principal.credentialHash ?? "")) {
    throw fail("source_not_authorized");
  }
  const createdAt = at(now);
  const expiresAt = expires(createdAt, TEN_MINUTES);
  const codeHash = await hashText(code);
  const source = await db.prepare(
    `SELECT u.user_id, u.status AS user_status, c.status AS credential_status
       FROM rds2_users u JOIN rds2_credentials c ON c.user_id = u.user_id
      WHERE u.user_id = ? AND c.credential_hash = ?`
  ).bind(principal.userId, principal.credentialHash).first();
  if (!source || source.user_status !== "active" || source.credential_status !== "active") {
    throw fail("source_not_authorized");
  }
  const existing = await db.prepare(
    "SELECT code_hash, user_id, source_credential_hash, expires_at FROM rds2_pairing_tickets WHERE code_hash = ?"
  ).bind(codeHash).first();
  if (existing) {
    if (Date.parse(existing.expires_at) <= Date.parse(createdAt)) throw fail("pairing_expired");
    if (existing.user_id !== principal.userId || existing.source_credential_hash !== principal.credentialHash) {
      throw fail("pairing_conflict");
    }
    return { storageVersion: 2, userId: principal.userId, expiresAt: existing.expires_at, created: false, replayed: true };
  }
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO rds2_pairing_tickets
          (code_hash, user_id, source_credential_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(codeHash, principal.userId, principal.credentialHash, createdAt, expiresAt)
    ]);
    return { storageVersion: 2, userId: principal.userId, expiresAt, created: true, replayed: false };
  } catch (error) {
    if (!isUnique(error)) throw error;
    const winner = await db.prepare(
      "SELECT code_hash, user_id, source_credential_hash, expires_at FROM rds2_pairing_tickets WHERE code_hash = ?"
    ).bind(codeHash).first();
    if (winner && winner.user_id === principal.userId && winner.source_credential_hash === principal.credentialHash
      && Date.parse(winner.expires_at) > Date.parse(createdAt)) {
      return { storageVersion: 2, userId: principal.userId, expiresAt: winner.expires_at, created: false, replayed: true };
    }
    throw fail("pairing_conflict");
  }
}

export async function redeemPairing({ io, requestId, code, secret, now } = {}) {
  const db = dbOf(io);
  if (typeof requestId !== "string" || !requestId.trim()) throw fail("invalid_request_id");
  proofInput(code, "invalid_pairing_code");
  proofInput(secret, "invalid_registration_proof");
  const createdAt = at(now);
  const codeHash = await hashText(code);
  const proofHash = await hashText(secret);

  const existing = await db.prepare(
    `SELECT request_id, code_hash, proof_hash, user_id, recover_until
       FROM rds2_pairing_redemptions WHERE request_id = ?`
  ).bind(requestId).first();
  if (existing) {
    if (existing.code_hash !== codeHash || existing.proof_hash !== proofHash) throw fail("pairing_conflict");
    if (Date.parse(existing.recover_until) < Date.parse(createdAt)) throw fail("redemption_expired");
    const user = await db.prepare("SELECT user_id, display_name, status FROM rds2_users WHERE user_id = ?")
      .bind(existing.user_id).first();
    if (!user) throw fail("pairing_conflict");
    return { storageVersion: 2, userId: user.user_id, displayName: user.display_name, status: user.status, created: false, replayed: true };
  }

  const ticket = await db.prepare(
    `SELECT t.code_hash, t.user_id, t.source_credential_hash, t.expires_at,
            t.consumed_by, u.display_name, u.status AS user_status,
            c.status AS credential_status
       FROM rds2_pairing_tickets t
       JOIN rds2_users u ON u.user_id = t.user_id
       JOIN rds2_credentials c ON c.credential_hash = t.source_credential_hash
      WHERE t.code_hash = ?`
  ).bind(codeHash).first();
  if (!ticket) throw fail("pairing_not_found");
  if (Date.parse(ticket.expires_at) <= Date.parse(createdAt)) throw fail("pairing_expired");
  if (ticket.consumed_by !== null) throw fail("pairing_used");
  if (ticket.user_status !== "active" || ticket.credential_status !== "active") throw fail("source_not_authorized");

  const recoverUntil = expires(createdAt, RECOVERY_WINDOW);
  try {
    await db.batch([
      db.prepare(
        `UPDATE rds2_pairing_tickets
            SET consumed_by = ?, consumed_at = ?
          WHERE code_hash = ? AND consumed_by IS NULL AND expires_at > ?`
      ).bind(requestId, createdAt, codeHash, createdAt),
      db.prepare(
        `INSERT INTO rds2_pairing_redemptions
          (request_id, code_hash, proof_hash, user_id, created_at, recover_until)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(requestId, codeHash, proofHash, ticket.user_id, createdAt, recoverUntil),
      db.prepare(
        `INSERT INTO rds2_credentials (credential_hash, user_id, status, created_at)
         VALUES (?, ?, 'active', ?)`
      ).bind(proofHash, ticket.user_id, createdAt)
    ]);
    return { storageVersion: 2, userId: ticket.user_id, displayName: ticket.display_name, status: "active", created: true, replayed: false };
  } catch (error) {
    if (!isUnique(error) && !/pairing_invalid/i.test(String(error?.message ?? ""))) throw error;
    const winner = await db.prepare(
      "SELECT request_id, code_hash, proof_hash, user_id, recover_until FROM rds2_pairing_redemptions WHERE request_id = ?"
    ).bind(requestId).first();
    if (winner && winner.code_hash === codeHash && winner.proof_hash === proofHash
      && Date.parse(winner.recover_until) >= Date.parse(createdAt)) {
      return { storageVersion: 2, userId: winner.user_id, displayName: ticket.display_name, status: "active", created: false, replayed: true };
    }
    if (ticket.consumed_by) throw fail("pairing_used");
    throw fail("pairing_conflict");
  }
}
