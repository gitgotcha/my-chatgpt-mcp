-- RDS V2 migration 0008: device-account management records.
--
-- The original 0006 users table made name_key globally unique, which prevents
-- legitimate same-name accounts. Rebuild only the two tables whose contract
-- changes, copy every existing value verbatim, then restore the child foreign
-- key and index. No 0006/0007 file is edited and all other RDS2 tables remain
-- untouched.

ALTER TABLE rds2_users RENAME TO rds2_users_legacy;

CREATE TABLE rds2_users_next (
  user_id TEXT PRIMARY KEY,
  name_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL
);

INSERT INTO rds2_users_next (user_id, name_key, display_name, status, created_at)
SELECT user_id, name_key, display_name, status, created_at
  FROM rds2_users_legacy;

ALTER TABLE rds2_credentials RENAME TO rds2_credentials_legacy;

CREATE TABLE rds2_credentials_next (
  credential_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES rds2_users_next (user_id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL
);

INSERT INTO rds2_credentials_next (credential_hash, user_id, status, created_at)
SELECT credential_hash, user_id, status, created_at
  FROM rds2_credentials_legacy;

DROP TABLE rds2_credentials_legacy;
DROP TABLE rds2_users_legacy;

ALTER TABLE rds2_users_next RENAME TO rds2_users;
ALTER TABLE rds2_credentials_next RENAME TO rds2_credentials;

CREATE INDEX rds2_credentials_user_idx ON rds2_credentials (user_id, status);

CREATE TABLE rds2_registration_intents (
  request_id TEXT PRIMARY KEY,
  proof_hash TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES rds2_users (user_id),
  created_at TEXT NOT NULL
);

CREATE TABLE rds2_pairing_tickets (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES rds2_users (user_id),
  source_credential_hash TEXT NOT NULL REFERENCES rds2_credentials (credential_hash),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_by TEXT UNIQUE,
  consumed_at TEXT,
  CHECK ((consumed_by IS NULL) = (consumed_at IS NULL))
);
CREATE INDEX rds2_ticket_expiry ON rds2_pairing_tickets (expires_at);

CREATE TABLE rds2_pairing_redemptions (
  request_id TEXT PRIMARY KEY,
  code_hash TEXT UNIQUE NOT NULL,
  proof_hash TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES rds2_users (user_id),
  created_at TEXT NOT NULL,
  recover_until TEXT NOT NULL
);
CREATE INDEX rds2_redemption_expiry ON rds2_pairing_redemptions (recover_until);

CREATE TABLE rds2_account_limits (
  bucket_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL CHECK (attempts >= 1),
  expires_at INTEGER NOT NULL
);
CREATE INDEX rds2_limits_expiry ON rds2_account_limits (expires_at);

-- A redemption can only be inserted after the source ticket has been
-- atomically claimed for this request and remains valid. The source account
-- and credential must still be active; otherwise the whole batch aborts.
CREATE TRIGGER rds2_pairing_redemption_guard
BEFORE INSERT ON rds2_pairing_redemptions
WHEN NOT EXISTS (
  SELECT 1
    FROM rds2_pairing_tickets t
    JOIN rds2_users u ON u.user_id = t.user_id
    JOIN rds2_credentials c ON c.credential_hash = t.source_credential_hash
   WHERE t.code_hash = NEW.code_hash
     AND t.user_id = NEW.user_id
     AND t.consumed_by = NEW.request_id
     AND t.consumed_at = NEW.created_at
     AND t.expires_at > NEW.created_at
     AND u.status = 'active'
     AND c.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'pairing_invalid');
END;

