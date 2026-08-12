import type { SyncEvent } from "@reliable-drive-sync/protocol/event";

export type JobState = "dispatch_pending" | "dispatching" | "broker_queued" | "syncing" | "synced" | "needs_attention";

export type SyncJob = {
  jobId: string;
  eventKey: string;
  userId: string;
  state: JobState;
  isNew?: boolean;
};

export type DispatchJob = SyncJob & {
  dispatchAttempts: number;
  lastErrorCode: string | null;
  brokerMessageId: string | null;
  leaseOwner: string | null;
  leaseUntil: string | null;
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

export interface DispatchRepository {
  claimForDispatch(jobId: string, leaseOwner: string, now: Date, leaseUntil: Date): Promise<DispatchJob | null>;
  markBrokerQueued(jobId: string, leaseOwner: string, messageId: string, now: Date): Promise<boolean>;
  markAcknowledgedUncertain(jobId: string, leaseOwner: string, messageId: string, now: Date): Promise<boolean>;
  recordDispatchFailure(jobId: string, leaseOwner: string, errorCode: string, now: Date): Promise<void>;
  listDispatchPending(limit: number): Promise<DispatchJob[]>;
}

/** The sync worker owns a short lease; every transition is guarded by job id and lease. */
export interface SyncRepository {
  getSyncState(jobId: string): Promise<JobState | null>;
  claimForSync(jobId: string, leaseOwner: string, now: Date, leaseUntil: Date): Promise<SyncJob | null>;
  loadEvent(jobId: string): Promise<SyncEvent | null>;
  markSynced(jobId: string, leaseOwner: string, now: Date): Promise<boolean>;
  releaseSync(jobId: string, leaseOwner: string, errorCode: string, now: Date): Promise<boolean>;
  markNeedsAttention(jobId: string, leaseOwner: string, errorCode: string, now: Date): Promise<boolean>;
  openSyncFailureNotice(userId: string, category: string, message: string, now: Date): Promise<boolean>;
}

type D1Statement = {
  bind(...values: unknown[]): D1Statement;
  run(): Promise<{ meta?: { changes?: number } }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
};

export interface D1Database {
  prepare(query: string): D1Statement;
}

type JobRow = { job_id: string; event_key: string; user_id: string; state: JobState };
type DispatchJobRow = JobRow & {
  dispatch_attempts: number;
  last_error_code: string | null;
  broker_message_id: string | null;
  lease_owner: string | null;
  lease_until: string | null;
};
type NoticeRow = { notice_id: string; user_id: string; category: string; message: string };

function mapJob(row: JobRow): SyncJob {
  return { jobId: row.job_id, eventKey: row.event_key, userId: row.user_id, state: row.state };
}

function mapDispatchJob(row: DispatchJobRow): DispatchJob {
  return {
    ...mapJob(row), dispatchAttempts: row.dispatch_attempts, lastErrorCode: row.last_error_code,
    brokerMessageId: row.broker_message_id, leaseOwner: row.lease_owner, leaseUntil: row.lease_until
  };
}

/** D1 implementation. The unique event_key constraint is the idempotency fence. */
export class D1JobRepository implements JobRepository, DispatchRepository, SyncRepository {
  constructor(private readonly database: D1Database) {}

  async createOrGet(event: SyncEvent): Promise<SyncJob> {
    const existing = await this.findByEventKey(event.eventKey);
    if (existing) return { ...existing, isNew: false };

    const now = new Date().toISOString();
    const candidateJobId = crypto.randomUUID();
    const inserted = await this.database.prepare(`
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
    return { ...persisted, isNew: inserted.meta?.changes === 1 };
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

  async claimForDispatch(jobId: string, leaseOwner: string, now: Date, leaseUntil: Date): Promise<DispatchJob | null> {
    await this.database.prepare(`
      UPDATE sync_jobs
      SET state = 'dispatching', lease_owner = ?, lease_until = ?, updated_at = ?
      WHERE job_id = ? AND state = 'dispatch_pending'
    `).bind(leaseOwner, leaseUntil.toISOString(), now.toISOString(), jobId).run();
    const row = await this.database.prepare(`
      SELECT job_id, event_key, user_id, state, dispatch_attempts, last_error_code,
             broker_message_id, lease_owner, lease_until
      FROM sync_jobs WHERE job_id = ? AND lease_owner = ? AND state = 'dispatching'
    `).bind(jobId, leaseOwner).first<DispatchJobRow>();
    return row ? mapDispatchJob(row) : null;
  }

  async markBrokerQueued(jobId: string, leaseOwner: string, messageId: string, now: Date): Promise<boolean> {
    const result = await this.database.prepare(`
      UPDATE sync_jobs
      SET state = 'broker_queued', broker_message_id = ?, lease_owner = NULL,
          lease_until = NULL, last_error_code = NULL, dispatched_at = ?, updated_at = ?
      WHERE job_id = ? AND state = 'dispatching' AND lease_owner = ?
    `).bind(messageId, now.toISOString(), now.toISOString(), jobId, leaseOwner).run();
    return result.meta?.changes === 1;
  }

  async markAcknowledgedUncertain(jobId: string, leaseOwner: string, messageId: string, now: Date): Promise<boolean> {
    const result = await this.database.prepare(`
      UPDATE sync_jobs
      SET broker_message_id = ?, last_error_code = 'qstash_ack_persist_failed', updated_at = ?
      WHERE job_id = ? AND state = 'dispatching' AND lease_owner = ?
    `).bind(messageId, now.toISOString(), jobId, leaseOwner).run();
    return result.meta?.changes === 1;
  }

  async recordDispatchFailure(jobId: string, leaseOwner: string, errorCode: string, now: Date): Promise<void> {
    await this.database.prepare(`
      UPDATE sync_jobs
      SET dispatch_attempts = dispatch_attempts + 1, last_error_code = ?,
          lease_owner = NULL, lease_until = NULL, updated_at = ?
      WHERE job_id = ? AND state = 'dispatching' AND lease_owner = ?
    `).bind(errorCode, now.toISOString(), jobId, leaseOwner).run();
  }

  async listDispatchPending(limit: number): Promise<DispatchJob[]> {
    const statement = this.database.prepare(`
      SELECT job_id, event_key, user_id, state, dispatch_attempts, last_error_code,
             broker_message_id, lease_owner, lease_until
      FROM sync_jobs WHERE state = 'dispatch_pending' ORDER BY created_at ASC LIMIT ?
    `).bind(limit) as D1Statement & { all<T>(): Promise<{ results: T[] }> };
    const result = await statement.all<DispatchJobRow>();
    return result.results.map(mapDispatchJob);
  }

  async claimForSync(jobId: string, leaseOwner: string, now: Date, leaseUntil: Date): Promise<SyncJob | null> {
    await this.database.prepare(`UPDATE sync_jobs SET state = 'syncing', lease_owner = ?, lease_until = ?, updated_at = ? WHERE job_id = ? AND state = 'broker_queued'`)
      .bind(leaseOwner, leaseUntil.toISOString(), now.toISOString(), jobId).run();
    const row = await this.database.prepare(`SELECT job_id, event_key, user_id, state FROM sync_jobs WHERE job_id = ? AND state = 'syncing' AND lease_owner = ?`)
      .bind(jobId, leaseOwner).first<JobRow>();
    return row ? mapJob(row) : null;
  }
  async getSyncState(jobId: string): Promise<JobState | null> { const row = await this.database.prepare(`SELECT state FROM sync_jobs WHERE job_id = ?`).bind(jobId).first<{ state: JobState }>(); return row?.state ?? null; }

  async loadEvent(jobId: string): Promise<SyncEvent | null> {
    const row = await this.database.prepare(`SELECT schema_version, event_id, event_key, event_type, user_id, source_skill, destination, created_at_source, payload_json FROM sync_jobs WHERE job_id = ?`)
      .bind(jobId).first<Record<string, unknown>>();
    if (!row) return null;
    try { return { schemaVersion: String(row.schema_version ?? "1"), eventId: String(row.event_id), eventKey: String(row.event_key), type: String(row.event_type), userId: String(row.user_id), sourceSkill: String(row.source_skill), destination: "drive", createdAt: String(row.created_at_source), payload: JSON.parse(String(row.payload_json)) as Record<string, unknown> }; }
    catch { return null; }
  }

  async markSynced(jobId: string, leaseOwner: string, now: Date): Promise<boolean> {
    const result = await this.database.prepare(`UPDATE sync_jobs SET state = 'synced', lease_owner = NULL, lease_until = NULL, completed_at = ?, updated_at = ?, last_error_code = NULL WHERE job_id = ? AND state = 'syncing' AND lease_owner = ?`)
      .bind(now.toISOString(), now.toISOString(), jobId, leaseOwner).run();
    return result.meta?.changes === 1;
  }
  async releaseSync(jobId: string, leaseOwner: string, errorCode: string, now: Date): Promise<boolean> {
    const result = await this.database.prepare(`UPDATE sync_jobs SET state = 'broker_queued', lease_owner = NULL, lease_until = NULL, last_error_code = ?, updated_at = ? WHERE job_id = ? AND state = 'syncing' AND lease_owner = ?`)
      .bind(errorCode, now.toISOString(), jobId, leaseOwner).run();
    return result.meta?.changes === 1;
  }
  async markNeedsAttention(jobId: string, leaseOwner: string, errorCode: string, now: Date): Promise<boolean> {
    const result = await this.database.prepare(`UPDATE sync_jobs SET state = 'needs_attention', lease_owner = NULL, lease_until = NULL, last_error_code = ?, updated_at = ? WHERE job_id = ? AND state = 'syncing' AND lease_owner = ?`)
      .bind(errorCode, now.toISOString(), jobId, leaseOwner).run();
    return result.meta?.changes === 1;
  }
  async openSyncFailureNotice(userId: string, category: string, message: string, now: Date): Promise<boolean> {
    const stamp = now.toISOString();
    const result = await this.database.prepare(`INSERT OR IGNORE INTO sync_failure_notices (notice_id, user_id, category, message, status, opened_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?)`)
      .bind(crypto.randomUUID(), userId, category, message, stamp, stamp).run();
    return result.meta?.changes === 1 || (await this.database.prepare(`SELECT notice_id FROM sync_failure_notices WHERE user_id = ? AND category = ? AND status = 'open'`).bind(userId, category).first()) !== null;
  }

  private async findByEventKey(eventKey: string): Promise<SyncJob | null> {
    const row = await this.database.prepare(`
      SELECT job_id, event_key, user_id, state FROM sync_jobs WHERE event_key = ?
    `).bind(eventKey).first<JobRow>();
    return row ? mapJob(row) : null;
  }
}

/** Test-only in-memory adapter; production code uses D1JobRepository. */
export class InMemoryJobRepository implements JobRepository, DispatchRepository, SyncRepository {
  private readonly jobs = new Map<string, SyncJob>();
  private readonly notices: OpenNotice[] = [];
  private readonly dispatchJobs = new Map<string, DispatchJob>();
  private readonly events = new Map<string, SyncEvent>();

  constructor(private readonly createJobId: () => string = () => crypto.randomUUID()) {}

  get jobCount(): number {
    return this.jobs.size;
  }

  async createOrGet(event: SyncEvent): Promise<SyncJob> {
    const existing = this.jobs.get(event.eventKey);
    if (existing) return { ...existing, isNew: false };
    const job: SyncJob = { jobId: this.createJobId(), eventKey: event.eventKey, userId: event.userId, state: "dispatch_pending", isNew: true };
    this.jobs.set(event.eventKey, job);
    this.events.set(job.jobId, event);
    this.dispatchJobs.set(job.jobId, { ...job, dispatchAttempts: 0, lastErrorCode: null, brokerMessageId: null, leaseOwner: null, leaseUntil: null });
    return job;
  }

  async listOpenNotices(userId: string): Promise<OpenNotice[]> {
    return this.notices.filter((notice) => notice.userId === userId);
  }

  addOpenNotice(notice: OpenNotice): void {
    this.notices.push(notice);
  }

  addDispatchJob(job: DispatchJob): void {
    this.dispatchJobs.set(job.jobId, { ...job });
  }

  getDispatchJob(jobId: string): DispatchJob | undefined {
    const job = this.dispatchJobs.get(jobId);
    return job ? { ...job } : undefined;
  }

  async claimForDispatch(jobId: string, leaseOwner: string, now: Date, leaseUntil: Date): Promise<DispatchJob | null> {
    const job = this.dispatchJobs.get(jobId);
    if (!job || job.state !== "dispatch_pending") return null;
    job.state = "dispatching";
    job.leaseOwner = leaseOwner;
    job.leaseUntil = leaseUntil.toISOString();
    return { ...job };
  }

  async markBrokerQueued(jobId: string, leaseOwner: string, messageId: string): Promise<boolean> {
    const job = this.dispatchJobs.get(jobId);
    if (!job || job.state !== "dispatching" || job.leaseOwner !== leaseOwner) return false;
    job.state = "broker_queued";
    job.brokerMessageId = messageId;
    job.leaseOwner = null;
    job.leaseUntil = null;
    job.lastErrorCode = null;
    return true;
  }

  async markAcknowledgedUncertain(jobId: string, leaseOwner: string, messageId: string): Promise<boolean> {
    const job = this.dispatchJobs.get(jobId);
    if (!job || job.state !== "dispatching" || job.leaseOwner !== leaseOwner) return false;
    job.brokerMessageId = messageId;
    job.lastErrorCode = "qstash_ack_persist_failed";
    return true;
  }

  async recordDispatchFailure(jobId: string, leaseOwner: string, errorCode: string): Promise<void> {
    const job = this.dispatchJobs.get(jobId);
    if (!job || job.state !== "dispatching" || job.leaseOwner !== leaseOwner) return;
    job.dispatchAttempts += 1;
    job.lastErrorCode = errorCode;
    job.state = "dispatch_pending";
    job.leaseOwner = null;
    job.leaseUntil = null;
  }

  async listDispatchPending(limit: number): Promise<DispatchJob[]> {
    return [...this.dispatchJobs.values()].filter((job) => job.state === "dispatch_pending").slice(0, limit).map((job) => ({ ...job }));
  }

  async claimForSync(jobId: string, leaseOwner: string, _now: Date, leaseUntil: Date): Promise<SyncJob | null> {
    const job = this.dispatchJobs.get(jobId);
    if (!job || job.state !== "broker_queued") return null;
    job.state = "syncing"; job.leaseOwner = leaseOwner; job.leaseUntil = leaseUntil.toISOString();
    return { jobId: job.jobId, eventKey: job.eventKey, userId: job.userId, state: job.state };
  }
  async getSyncState(jobId: string): Promise<JobState | null> { return this.dispatchJobs.get(jobId)?.state ?? null; }
  async loadEvent(jobId: string): Promise<SyncEvent | null> { return this.events.get(jobId) ?? null; }
  async markSynced(jobId: string, leaseOwner: string): Promise<boolean> { const job = this.dispatchJobs.get(jobId); if (!job || job.state !== "syncing" || job.leaseOwner !== leaseOwner) return false; job.state = "synced"; job.leaseOwner = null; job.leaseUntil = null; return true; }
  async releaseSync(jobId: string, leaseOwner: string, errorCode: string): Promise<boolean> { const job = this.dispatchJobs.get(jobId); if (!job || job.state !== "syncing" || job.leaseOwner !== leaseOwner) return false; job.state = "broker_queued"; job.leaseOwner = null; job.leaseUntil = null; job.lastErrorCode = errorCode; return true; }
  async markNeedsAttention(jobId: string, leaseOwner: string, errorCode: string): Promise<boolean> { const job = this.dispatchJobs.get(jobId); if (!job || job.state !== "syncing" || job.leaseOwner !== leaseOwner) return false; job.state = "needs_attention"; job.leaseOwner = null; job.leaseUntil = null; job.lastErrorCode = errorCode; return true; }
  async openSyncFailureNotice(userId: string, category: string, message: string): Promise<boolean> { if (!this.notices.some((notice) => notice.userId === userId && notice.category === category)) this.notices.push({ id: crypto.randomUUID(), userId, category, message }); return true; }
}
