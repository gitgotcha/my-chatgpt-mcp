// Credential-bound authentication (Rev 6 addendum §3): identity comes from the
// server-verified credential -> userId mapping. Payload userId/username can
// only be cross-checked, never authorize. Plaintext credentials are never
// stored; only their SHA-256 hashes live in rds2_credentials.
import { hashText } from "./hashing.js";

function authError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export async function authenticate({ db, credential }) {
  if (typeof credential !== "string" || credential.trim().length === 0) {
    throw authError("invalid_credential");
  }
  const hash = await hashText(credential);
  const row = await db.prepare(
    `SELECT c.user_id, c.status AS credential_status,
            u.display_name, u.status AS user_status
     FROM rds2_credentials c
     JOIN rds2_users u ON u.user_id = c.user_id
     WHERE c.credential_hash = ?`
  ).bind(hash).first();
  if (!row) throw authError("unknown_credential");
  if (row.credential_status !== "active") throw authError("credential_revoked");
  if (row.user_status !== "active") throw authError("user_disabled");
  return {
    userId: row.user_id,
    username: row.display_name,
    status: row.user_status,
    // The hash is an internal association key for pairing. The plaintext
    // bearer token is never returned or persisted by this function.
    credentialHash: hash
  };
}
