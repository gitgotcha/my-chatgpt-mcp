CREATE TABLE IF NOT EXISTS artifact_contents (
  artifact_key TEXT PRIMARY KEY REFERENCES artifact_jobs(artifact_key),
  content BLOB NOT NULL,
  byte_length INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
ALTER TABLE artifact_jobs ADD COLUMN drive_file_id TEXT;
