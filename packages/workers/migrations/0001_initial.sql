CREATE TABLE IF NOT EXISTS sync_jobs (
  job_id TEXT PRIMARY KEY NOT NULL,
  event_key TEXT NOT NULL UNIQUE,
  event_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  source_skill TEXT NOT NULL,
  destination TEXT NOT NULL,
  created_at_source TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'dispatch_pending',
  dispatch_attempts INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  last_error_message TEXT,
  lease_owner TEXT,
  lease_until TEXT,
  broker_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  dispatched_at TEXT,
  completed_at TEXT,
  CHECK (state IN ('dispatch_pending', 'dispatching', 'broker_queued', 'syncing', 'synced', 'needs_attention'))
);

CREATE INDEX IF NOT EXISTS idx_sync_jobs_state_created_at
  ON sync_jobs(state, created_at);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_user_created_at
  ON sync_jobs(user_id, created_at);

CREATE TABLE IF NOT EXISTS sync_failure_notices (
  notice_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  opened_at TEXT NOT NULL,
  acknowledged_at TEXT,
  reopened_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (status IN ('open', 'acknowledged'))
);

-- Acknowledged notices remain as history. Reopening creates a fresh open notice;
-- this partial index ensures only one open notice per user/category exists at once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_failure_notices_one_open_per_category
  ON sync_failure_notices(user_id, category)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_failure_notices_open_by_user
  ON sync_failure_notices(user_id, opened_at)
  WHERE status = 'open';
