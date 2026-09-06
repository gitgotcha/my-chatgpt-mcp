-- RDS V2 storage, migration 0006 (storageVersion = 2).
-- Isolation: every table is prefixed rds2_; V1 tables, Outbox files and Drive
-- layouts are neither read nor modified here. Old data is never migrated or
-- deleted by this migration.
-- Scope is always expanded to (user_id, namespace, projection_name) columns;
-- string-concatenated scope keys are forbidden.
-- Timestamps are UTC ISO-8601 strings. JSON units are bounded in UTF-8 BYTES
-- (length of the cast blob, not the character count): envelopes and frozen
-- artifacts <= 256 KiB, row/summary/build/receipt units <= 64 KiB. Every JSON
-- column must also hold valid JSON.

CREATE TABLE rds2_users (
  user_id TEXT PRIMARY KEY,
  name_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL
);

CREATE TABLE rds2_credentials (
  credential_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES rds2_users (user_id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL
);
CREATE INDEX rds2_credentials_user_idx ON rds2_credentials (user_id, status);

CREATE TABLE rds2_requests (
  user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  envelope_hash TEXT NOT NULL,
  canonical_event_id TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB)) <= 65536),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, request_id)
);

CREATE TABLE rds2_events (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  projection_name TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  business_key TEXT,
  event_type TEXT NOT NULL,
  created_by_request TEXT NOT NULL,
  envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json) AND length(CAST(envelope_json AS BLOB)) <= 262144),
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, event_id),
  UNIQUE (user_id, namespace, event_key)
);
CREATE UNIQUE INDEX rds2_events_business_key_idx
  ON rds2_events (user_id, business_key) WHERE business_key IS NOT NULL;
CREATE INDEX rds2_events_scope_seq_idx
  ON rds2_events (user_id, namespace, projection_name, event_seq);

CREATE TABLE rds2_tasks (
  task_id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('projection', 'projection_build', 'archive_event', 'archive_delta')),
  user_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  projection_name TEXT NOT NULL,
  event_seq INTEGER,
  artifact_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'dispatching', 'queued', 'processing', 'completed', 'needs_attention')),
  available_at TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_until TEXT,
  lease_epoch INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 65536),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (type <> 'projection' OR (event_seq IS NOT NULL AND artifact_id IS NULL)),
  CHECK (type IN ('projection', 'projection_build') OR artifact_id IS NOT NULL),
  CHECK ((lease_owner IS NULL AND lease_until IS NULL)
      OR (lease_owner IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX rds2_tasks_state_idx ON rds2_tasks (state, available_at, task_id);
CREATE INDEX rds2_tasks_scope_idx ON rds2_tasks (user_id, namespace, projection_name, type, event_seq);

CREATE TABLE rds2_projections (
  user_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  projection_name TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  last_event_seq INTEGER NOT NULL DEFAULT 0,
  active_generation INTEGER NOT NULL DEFAULT 0,
  building INTEGER NOT NULL DEFAULT 0 CHECK (building IN (0, 1)),
  summary_json TEXT CHECK (summary_json IS NULL OR (json_valid(summary_json) AND length(CAST(summary_json AS BLOB)) <= 65536)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, namespace, projection_name)
);

CREATE TABLE rds2_projection_rows (
  user_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  projection_name TEXT NOT NULL,
  generation INTEGER NOT NULL,
  row_kind TEXT NOT NULL,
  row_key TEXT NOT NULL,
  member_key TEXT,
  sort_key TEXT,
  value_json TEXT NOT NULL CHECK (json_valid(value_json) AND length(CAST(value_json AS BLOB)) <= 65536),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, namespace, projection_name, generation, row_kind, row_key)
);
CREATE INDEX rds2_projection_rows_scan_idx
  ON rds2_projection_rows (user_id, namespace, projection_name, generation, row_kind, sort_key, row_key);
CREATE INDEX rds2_projection_rows_member_idx
  ON rds2_projection_rows (user_id, namespace, projection_name, generation, row_kind, member_key);

CREATE TABLE rds2_projection_builds (
  build_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  projection_name TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  target_event_seq INTEGER NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('scanning', 'activating', 'completed', 'aborted')),
  staging_generation INTEGER NOT NULL,
  continuation_json TEXT CHECK (continuation_json IS NULL OR (json_valid(continuation_json) AND length(CAST(continuation_json AS BLOB)) <= 65536)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX rds2_projection_builds_running_idx
  ON rds2_projection_builds (user_id, namespace, projection_name)
  WHERE stage IN ('scanning', 'activating');
CREATE INDEX rds2_projection_builds_scope_idx
  ON rds2_projection_builds (user_id, namespace, projection_name, stage);

CREATE TABLE rds2_archive_deliveries (
  artifact_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  projection_name TEXT NOT NULL,
  object_type TEXT NOT NULL CHECK (object_type IN ('event', 'projection_delta', 'build_package')),
  object_name TEXT NOT NULL,
  frozen_json TEXT NOT NULL CHECK (json_valid(frozen_json) AND length(CAST(frozen_json AS BLOB)) <= 262144),
  -- Hash of the exact frozen_json UTF-8 bytes (artifact integrity). The
  -- business content hash (requestId excluded) lives on rds2_events.
  artifact_hash TEXT NOT NULL,
  drive_file_id TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX rds2_archive_deliveries_pending_idx
  ON rds2_archive_deliveries (user_id, delivered_at, artifact_id);

CREATE TABLE rds2_commit_guards (
  guard_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  expected_epoch INTEGER NOT NULL,
  now_utc TEXT NOT NULL,
  expected_revision INTEGER,
  created_at TEXT NOT NULL
);

-- The event cursor is monotonic: no commit may move last_event_seq backwards,
-- whatever the caller believes about the head (G2-R3).
CREATE TRIGGER rds2_cursor_monotonic
BEFORE UPDATE ON rds2_projections
WHEN NEW.last_event_seq < OLD.last_event_seq
BEGIN
  SELECT RAISE(ABORT, 'cursor_regression');
END;

-- Builds may only be created while the head is flagged as building; the flag
-- is set by a CAS update on the exact base revision inside the same batch, so
-- a build can never start on a stale base or without the flag (G2-R4).
CREATE TRIGGER rds2_build_requires_building
BEFORE INSERT ON rds2_projection_builds
WHEN NOT EXISTS (
  SELECT 1 FROM rds2_projections p
  WHERE p.user_id = NEW.user_id AND p.namespace = NEW.namespace
    AND p.projection_name = NEW.projection_name AND p.building = 1
)
BEGIN
  SELECT RAISE(ABORT, 'build_requires_building_flag');
END;

-- Transaction guards. A guard row may only be inserted while the referenced
-- task is processing under the claiming owner/epoch with an unexpired lease.
-- The whole batch aborts otherwise, so stale writes can never persist.
CREATE TRIGGER rds2_guard_task
BEFORE INSERT ON rds2_commit_guards
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM rds2_tasks t
    WHERE t.task_id = NEW.task_id
      AND t.state = 'processing'
      AND t.lease_owner = NEW.owner
      AND t.lease_epoch = NEW.expected_epoch
      AND t.lease_until > NEW.now_utc
  ) THEN RAISE(ABORT, 'stale_task_write') END;
END;

-- Projection guards must carry the base revision and it must still equal the
-- head revision. expected_revision IS NULL is only allowed for archive tasks.
CREATE TRIGGER rds2_guard_projection_requires_revision
BEFORE INSERT ON rds2_commit_guards
WHEN NEW.expected_revision IS NULL
  AND EXISTS (
    SELECT 1 FROM rds2_tasks t
    WHERE t.task_id = NEW.task_id AND t.type = 'projection'
  )
BEGIN
  SELECT RAISE(ABORT, 'guard_requires_expected_revision');
END;

CREATE TRIGGER rds2_guard_projection_revision
BEFORE INSERT ON rds2_commit_guards
WHEN NEW.expected_revision IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM rds2_tasks t
    JOIN rds2_projections p
      ON p.user_id = t.user_id
     AND p.namespace = t.namespace
     AND p.projection_name = t.projection_name
    WHERE t.task_id = NEW.task_id
      AND p.revision = NEW.expected_revision
  ) THEN RAISE(ABORT, 'stale_projection_revision') END;
END;
