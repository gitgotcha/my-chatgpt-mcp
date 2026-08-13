CREATE TABLE IF NOT EXISTS artifact_jobs (
  job_id TEXT PRIMARY KEY,
  artifact_key TEXT NOT NULL UNIQUE,
  candidate_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('dispatch_pending','dispatching','broker_queued','syncing','synced','needs_attention')),
  dispatch_attempts INTEGER NOT NULL DEFAULT 0,
  broker_message_id TEXT,
  lease_owner TEXT,
  lease_until TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS artifact_jobs_dispatch_pending_idx ON artifact_jobs(state, created_at);
CREATE INDEX IF NOT EXISTS artifact_jobs_candidate_idx ON artifact_jobs(candidate_id, state, created_at);

CREATE TABLE IF NOT EXISTS interview_candidates (
  candidate_id TEXT PRIMARY KEY,
  display_name TEXT,
  active_resume_artifact_key TEXT,
  profile_json TEXT,
  updated_at TEXT NOT NULL
);
