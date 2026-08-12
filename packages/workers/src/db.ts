import type { SyncEvent } from "@reliable-drive-sync/protocol/event";

export type JobState = "dispatch_pending" | "broker_queued" | "syncing" | "completed" | "failed" | "dead_letter";

export type SyncJob = {
  jobId: string;
  eventKey: string;
  userId: string;
  state: JobState;
};

export type OpenNotice = {
  id: string;
  userId: string;
  category: string;
  message: string;
};

export interface JobRepository {
  createOrGet(event: SyncEvent): Promise<SyncJob>;
  listOpenNotices(userId: string): Promise<OpenNotice[]>;
}

type D1Statement = {
  bind(...values: unknown[]): D1Statement;
  run(): Promise<unknown>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
};

export interface D1Database {
  prepare(query: string): D1Statement;
}

type JobRow = { job_id: string; event_key: string; user_id: string; state: JobState };
type NoticeRow = { notice_id: string; user_id: string; category: string; message: string };

function mapJob(row: JobRow): SyncJob {
  return { jobId: row.job_id, eventKey: row.event_key, userId: row.user_id, state: row.state };
}

/** D1 implementation. The unique event_key constraint is the idempotency fence. */
export class D1JobRepository implements JobRepository {
  constructor(private readonly database: D1Database) {}

  async createOrGet(event: SyncEvent): Promise<SyncJob> {
    const existing = await this.findByEventKey(event.eventKey);
    if (existing) return existing;

    const now = new Date().toISOString();
    const candidateJobId = crypto.randomUUID();
    await this.database.prepare(`
      INSERT OR IGNORE INTO sync_jobs (
        job_id, event_key, event_id, user_id, event_type, source_skill, destination,
        created_at_source, payload_json, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'dispatch_pending', ?, ?)
    `).bind(
      candidateJobId, event.eventKey, event.eventId, event.userId, event.type,
      event.sourceSkill, event.destination, event.createdAt, JSON.stringify(event.payload), now, now
    ).run();

    const persisted = await this.findByEventKey(event.eventKey);
    if (!persisted) throw new Error("Sync job was not persisted");
    return persisted;
  }

  async listOpenNotices(userId: string): Promise<OpenNotice[]> {
    const statement = this.database.prepare(`
      SELECT notice_id, user_id, category, message
      FROM sync_failure_notices
      WHERE user_id = ? AND status = 'open'
      ORDER BY opened_at ASC
    `).bind(userId) as D1Statement & { all<T>(): Promise<{ results: T[] }> };
    const result = await statement.all<NoticeRow>();
    return result.results.map((row) => ({ id: row.notice_id, userId: row.user_id, category: row.category, message: row.message }));
  }

  private async findByEventKey(eventKey: string): Promise<SyncJob | null> {
    const row = await this.database.prepare(`
      SELECT job_id, event_key, user_id, state FROM sync_jobs WHERE event_key = ?
    `).bind(eventKey).first<JobRow>();
    return row ? mapJob(row) : null;
  }
}

/** Test-only in-memory adapter; production code uses D1JobRepository. */
export class InMemoryJobRepository implements JobRepository {
  private readonly jobs = new Map<string, SyncJob>();
  private readonly notices: OpenNotice[] = [];

  constructor(private readonly createJobId: () => string = () => crypto.randomUUID()) {}

  get jobCount(): number {
    return this.jobs.size;
  }

  async createOrGet(event: SyncEvent): Promise<SyncJob> {
    const existing = this.jobs.get(event.eventKey);
    if (existing) return existing;
    const job: SyncJob = { jobId: this.createJobId(), eventKey: event.eventKey, userId: event.userId, state: "dispatch_pending" };
    this.jobs.set(event.eventKey, job);
    return job;
  }

  async listOpenNotices(userId: string): Promise<OpenNotice[]> {
    return this.notices.filter((notice) => notice.userId === userId);
  }

  addOpenNotice(notice: OpenNotice): void {
    this.notices.push(notice);
  }
}
