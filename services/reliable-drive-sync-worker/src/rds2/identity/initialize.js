// Admin-only user initialization (Rev 6 addendum §2/§3): identity is bound to
// credentials by the server; a normalized display name is a consistency key,
// never an authorization. Both directions (id -> name and name -> id) are
// checked BEFORE any write, and no ON CONFLICT DO NOTHING path may continue
// into credential issuance after a conflict.
import { hashText } from "./hashing.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

function initError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isUniqueViolation(error) {
  return /UNIQUE constraint failed/i.test(String(error?.message ?? ""));
}

export function normalizeNameKey(displayName) {
  return String(displayName ?? "").normalize("NFKC").trim();
}

async function userById(db, userId) {
  return db.prepare(
    "SELECT user_id, name_key, display_name, status FROM rds2_users WHERE user_id = ?"
  ).bind(userId).first();
}

async function userByNameKey(db, nameKey) {
  return db.prepare(
    "SELECT user_id, name_key, display_name, status FROM rds2_users WHERE name_key = ?"
  ).bind(nameKey).first();
}

async function credentialById(db, credentialHash) {
  return db.prepare(
    "SELECT credential_hash, user_id, status FROM rds2_credentials WHERE credential_hash = ?"
  ).bind(credentialHash).first();
}

export async function initializeUser({
  db,
  adminCredential,
  expectedAdminHash,
  displayName,
  userIdOverride,
  credentialHash,
  now
}) {
  if (!expectedAdminHash) throw initError("admin_not_configured");
  const adminHash = await hashText(String(adminCredential ?? ""));
  if (adminHash !== expectedAdminHash) throw initError("admin_credential_rejected");

  const nameKey = normalizeNameKey(displayName);
  if (!nameKey) throw initError("invalid_display_name");
  if (typeof credentialHash !== "string" || !SHA256.test(credentialHash)) {
    throw initError("invalid_credential_hash");
  }
  if (userIdOverride !== undefined && !UUID.test(String(userIdOverride))) {
    throw initError("invalid_user_id");
  }
  const timestamp = now ?? new Date().toISOString();

  // Bidirectional consistency check before any write: the explicit id must
  // not collide with another user's name and vice versa.
  const byId = userIdOverride !== undefined ? await userById(db, userIdOverride) : null;
  const byName = await userByNameKey(db, nameKey);
  if (byId && byName && byId.user_id !== byName.user_id) throw initError("identity_conflict");
  if (byId && byId.name_key !== nameKey) throw initError("identity_conflict");

  const userId = byId?.user_id ?? byName?.user_id ?? userIdOverride ?? crypto.randomUUID();
  const displayNameStored = byId?.display_name ?? byName?.display_name ?? String(displayName).trim();

  if (!byId && !byName) {
    try {
      await db.batch([
        db.prepare(
          `INSERT INTO rds2_users (user_id, name_key, display_name, status, created_at)
           VALUES (?, ?, ?, 'active', ?)`
        ).bind(userId, nameKey, displayNameStored, timestamp),
        db.prepare(
          `INSERT INTO rds2_credentials (credential_hash, user_id, status, created_at)
           VALUES (?, ?, 'active', ?)`
        ).bind(credentialHash, userId, timestamp)
      ]);
      return { userId, username: displayNameStored, status: "active", created: true, credentialBound: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A concurrent initialization of the same name won the race: the batch
      // rolled back, so re-resolve and continue on the existing identity.
      const winner = await userByNameKey(db, nameKey);
      if (!winner) throw initError("identity_conflict");
      return bindCredential(db, winner, credentialHash, timestamp);
    }
  }
  return bindCredential(db, { user_id: userId, display_name: displayNameStored }, credentialHash, timestamp);
}

async function bindCredential(db, user, credentialHash, timestamp) {
  const existing = await credentialById(db, credentialHash);
  if (existing) {
    if (existing.user_id !== user.user_id) throw initError("credential_conflict");
    return {
      userId: user.user_id,
      username: user.display_name,
      status: user.status ?? "active",
      created: false,
      credentialBound: false
    };
  }
  await db.batch([
    db.prepare(
      `INSERT INTO rds2_credentials (credential_hash, user_id, status, created_at)
       VALUES (?, ?, 'active', ?)`
    ).bind(credentialHash, user.user_id, timestamp)
  ]);
  return {
    userId: user.user_id,
    username: user.display_name,
    status: user.status ?? "active",
    created: false,
    credentialBound: true
  };
}
