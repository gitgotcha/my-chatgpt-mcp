CREATE TABLE IF NOT EXISTS schema12_jobs (
  job_id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  envelope_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'dispatch_pending',
  dispatch_attempts INTEGER NOT NULL DEFAULT 0,
  sync_attempts INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  last_error_message TEXT,
  lease_owner TEXT,
  lease_until TEXT,
  broker_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  dispatched_at TEXT,
  completed_at TEXT,
  CHECK (state IN (
    'dispatch_pending', 'dispatching', 'broker_queued',
    'syncing', 'synced', 'needs_attention'
  ))
);

CREATE INDEX IF NOT EXISTS idx_schema12_jobs_state_created_at
  ON schema12_jobs(state, created_at);

CREATE INDEX IF NOT EXISTS idx_schema12_jobs_user_created_at
  ON schema12_jobs(user_id, created_at);

CREATE TABLE IF NOT EXISTS schema12_failure_notices (
  notice_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  opened_at TEXT NOT NULL,
  acknowledged_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (status IN ('open', 'acknowledged'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_schema12_notices_one_open
  ON schema12_failure_notices(user_id, category)
  WHERE status = 'open';
