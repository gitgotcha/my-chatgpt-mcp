import Database from "better-sqlite3";
import type { ArtifactSubmission } from "@reliable-drive-sync/protocol/artifact";

export type StoredArtifact = Omit<ArtifactSubmission, "bytes">;
export type ArtifactOutboxRecord = { artifactKey: string; artifact: StoredArtifact; state: "pending" | "sending"; cloudJobId: string | null };

function stored(artifact: ArtifactSubmission): StoredArtifact {
  const { bytes: _bytes, ...value } = artifact;
  return value;
}

export class LocalArtifactOutbox {
  private readonly db: Database.Database;
  constructor(readonly filename: string, private readonly now = () => new Date().toISOString()) {
    this.db = new Database(filename);
    this.db.exec(`CREATE TABLE IF NOT EXISTS local_outbox_artifacts (
      artifact_key TEXT PRIMARY KEY, artifact_json TEXT NOT NULL, state TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0, cloud_job_id TEXT, last_error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    this.db.prepare("UPDATE local_outbox_artifacts SET state = 'pending', updated_at = ? WHERE state = 'sending'").run(this.now());
  }
  enqueue(artifact: ArtifactSubmission): void {
    const timestamp = this.now();
    this.db.prepare("INSERT INTO local_outbox_artifacts (artifact_key, artifact_json, state, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?) ON CONFLICT(artifact_key) DO NOTHING")
      .run(artifact.artifactKey, JSON.stringify(stored(artifact)), timestamp, timestamp);
  }
  listPendingRaw(): ArtifactOutboxRecord[] {
    return this.db.prepare("SELECT artifact_key, artifact_json, state, cloud_job_id FROM local_outbox_artifacts WHERE state = 'pending' ORDER BY created_at, artifact_key")
      .all().map((row) => { const value = row as { artifact_key: string; artifact_json: string; state: "pending" | "sending"; cloud_job_id: string | null }; return { artifactKey: value.artifact_key, artifact: JSON.parse(value.artifact_json) as StoredArtifact, state: value.state, cloudJobId: value.cloud_job_id }; });
  }
  hasArtifact(artifactKey: string): boolean { return this.db.prepare("SELECT 1 FROM local_outbox_artifacts WHERE artifact_key = ?").get(artifactKey) !== undefined; }
  markSending(artifactKey: string): void { this.db.prepare("UPDATE local_outbox_artifacts SET state = 'sending', attempt_count = attempt_count + 1, updated_at = ? WHERE artifact_key = ? AND state = 'pending'").run(this.now(), artifactKey); }
  markPending(artifactKey: string, errorCode: string): void { this.db.prepare("UPDATE local_outbox_artifacts SET state = 'pending', last_error_code = ?, updated_at = ? WHERE artifact_key = ?").run(errorCode, this.now(), artifactKey); }
  acknowledge(artifactKey: string, jobId: string): boolean { return this.db.prepare("DELETE FROM local_outbox_artifacts WHERE artifact_key = ? AND state = 'sending'").run(artifactKey).changes === 1; }
}
