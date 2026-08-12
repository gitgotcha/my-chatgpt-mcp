import Database from "better-sqlite3";
import { parseSyncEvent, type SyncEvent } from "@reliable-drive-sync/protocol/event";

export type OutboxState = "pending" | "sending";

export type OutboxRecord = {
  eventKey: string;
  event: SyncEvent;
  state: OutboxState;
  attemptCount: number;
  lastAttemptAt: string | null;
  lastErrorCode: string | null;
  cloudJobId: string | null;
  createdAt: string;
  updatedAt: string;
};

type OutboxRow = {
  event_key: string;
  event_json: string;
  state: OutboxState;
  attempt_count: number;
  last_attempt_at: string | null;
  last_error_code: string | null;
  cloud_job_id: string | null;
  created_at: string;
  updated_at: string;
};

export class LocalOutbox {
  private readonly db: Database.Database;

  constructor(filename: string, private readonly now = () => new Date().toISOString()) {
    this.db = new Database(filename);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_outbox_events (
        event_key TEXT PRIMARY KEY,
        event_json TEXT NOT NULL,
        state TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        last_error_code TEXT,
        cloud_job_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.recoverSending();
  }

  enqueue(input: unknown): void {
    const event = parseSyncEvent(input);
    const timestamp = this.now();
    this.db.prepare(`
      INSERT INTO local_outbox_events (
        event_key, event_json, state, attempt_count, created_at, updated_at
      ) VALUES (?, ?, 'pending', 0, ?, ?)
      ON CONFLICT(event_key) DO NOTHING
    `).run(event.eventKey, JSON.stringify(event), timestamp, timestamp);
  }

  recoverSending(): void {
    this.db.prepare(`
      UPDATE local_outbox_events
      SET state = 'pending', updated_at = ?
      WHERE state = 'sending'
    `).run(this.now());
  }

  listPending(): OutboxRecord[] {
    return this.db.prepare(`
      SELECT * FROM local_outbox_events
      WHERE state = 'pending'
      ORDER BY created_at ASC, event_key ASC
    `).all().map((row) => this.toRecord(row as OutboxRow));
  }

  markSending(eventKey: string): void {
    this.db.prepare(`
      UPDATE local_outbox_events
      SET state = 'sending', attempt_count = attempt_count + 1, last_attempt_at = ?, updated_at = ?
      WHERE event_key = ? AND state = 'pending'
    `).run(this.now(), this.now(), eventKey);
  }

  markPending(eventKey: string, errorCode: string): void {
    this.db.prepare(`
      UPDATE local_outbox_events
      SET state = 'pending', last_error_code = ?, updated_at = ?
      WHERE event_key = ?
    `).run(errorCode, this.now(), eventKey);
  }

  acknowledge(eventKey: string, jobId: string): boolean {
    if (typeof jobId !== "string" || jobId.trim() === "") return false;
    const result = this.db.prepare(`
      DELETE FROM local_outbox_events
      WHERE event_key = ? AND state = 'sending'
    `).run(eventKey);
    return result.changes === 1;
  }

  close(): void {
    this.db.close();
  }

  private toRecord(row: OutboxRow): OutboxRecord {
    return {
      eventKey: row.event_key,
      event: parseSyncEvent(JSON.parse(row.event_json)),
      state: row.state,
      attemptCount: row.attempt_count,
      lastAttemptAt: row.last_attempt_at,
      lastErrorCode: row.last_error_code,
      cloudJobId: row.cloud_job_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}
