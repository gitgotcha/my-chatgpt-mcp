-- Existing deployments started before protocol versions were persisted.  The
-- default preserves their v1 event shape while allowing every new event to
-- record the exact version that was submitted.
ALTER TABLE sync_jobs ADD COLUMN schema_version TEXT NOT NULL DEFAULT '1';
