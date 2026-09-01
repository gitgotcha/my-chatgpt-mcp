export class JobRepositoryError extends Error {
  constructor(code) {
    super(code);
    this.name = "JobRepositoryError";
    this.code = code;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalEnvelopeJson(envelope) {
  return JSON.stringify(canonicalize(envelope));
}

async function sha256Hex(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function clone(value) {
  return structuredClone(value);
}

function identityUserId(envelope) {
  const userId = envelope?.identity?.userId ?? envelope?.payload?.userId ?? envelope?.payload?.event?.userId;
  return typeof userId === "string" ? userId : "";
}

function mapRow(row, isNew = false) {
  return {
    jobId: row.job_id,
    requestId: row.request_id,
    userId: row.user_id,
    state: row.state,
    dispatchAttempts: Number(row.dispatch_attempts ?? 0),
    syncAttempts: Number(row.sync_attempts ?? 0),
    lastErrorCode: row.last_error_code ?? null,
    brokerMessageId: row.broker_message_id ?? null,
    leaseOwner: row.lease_owner ?? null,
    leaseUntil: row.lease_until ?? null,
    isNew
  };
}

function acceptedJob(job, isNew) {
  return {
    jobId: job.jobId,
    requestId: job.requestId,
    userId: job.userId,
    state: job.state,
    isNew
  };
}

export class D1JobRepository {
  constructor(database, newJobId = () => crypto.randomUUID(), now = () => new Date()) {
    this.database = database;
    this.newJobId = newJobId;
    this.now = now;
  }

  async createOrGet(envelope) {
    const envelopeJson = canonicalEnvelopeJson(envelope);
    const envelopeHash = await sha256Hex(envelopeJson);
    const existing = await this.findByRequestId(envelope.requestId);
    if (existing) {
      if (existing.envelope_hash !== envelopeHash) throw new JobRepositoryError("request_id_conflict");
      return acceptedJob(mapRow(existing), false);
    }

    const jobId = this.newJobId();
    const timestamp = this.now().toISOString();
    const inserted = await this.database.prepare(`
      INSERT OR IGNORE INTO schema12_jobs (
        job_id, request_id, user_id, envelope_json, envelope_hash,
        state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'dispatch_pending', ?, ?)
    `).bind(
      jobId,
      envelope.requestId,
      identityUserId(envelope),
      envelopeJson,
      envelopeHash,
      timestamp,
      timestamp
    ).run();

    const persisted = await this.findByRequestId(envelope.requestId);
    if (!persisted) throw new JobRepositoryError("job_persistence_failed");
    if (persisted.envelope_hash !== envelopeHash) throw new JobRepositoryError("request_id_conflict");
    return acceptedJob(mapRow(persisted), inserted.meta?.changes === 1);
  }

  async loadEnvelope(jobId) {
    const row = await this.database.prepare(`
      SELECT envelope_json FROM schema12_jobs WHERE job_id = ?
    `).bind(jobId).first();
    if (!row) return null;
    try {
      return JSON.parse(row.envelope_json);
    } catch {
      return null;
    }
  }

  async getJob(jobId) {
    const row = await this.database.prepare(`
      SELECT job_id, request_id, user_id, envelope_json, envelope_hash, state,
             dispatch_attempts, sync_attempts, last_error_code,
             broker_message_id, lease_owner, lease_until
      FROM schema12_jobs WHERE job_id = ?
    `).bind(jobId).first();
    return row ? mapRow(row, false) : null;
  }

  async claimForDispatch(jobId, leaseOwner, now, leaseUntil) {
    await this.database.prepare(`
      UPDATE schema12_jobs
      SET state = 'dispatching', lease_owner = ?, lease_until = ?, updated_at = ?
      WHERE job_id = ? AND state = 'dispatch_pending'
    `).bind(leaseOwner, leaseUntil.toISOString(), now.toISOString(), jobId).run();
    const job = await this.getJob(jobId);
    return job?.state === "dispatching" && job.leaseOwner === leaseOwner ? job : null;
  }

  async markBrokerQueued(jobId, leaseOwner, messageId, now) {
    const result = await this.database.prepare(`
      UPDATE schema12_jobs
      SET state = 'broker_queued', broker_message_id = ?, lease_owner = NULL,
          lease_until = NULL, last_error_code = NULL, dispatched_at = ?, updated_at = ?
      WHERE job_id = ? AND state = 'dispatching' AND lease_owner = ?
    `).bind(messageId, now.toISOString(), now.toISOString(), jobId, leaseOwner).run();
    return result.meta?.changes === 1;
  }

  async recordDispatchFailure(jobId, leaseOwner, errorCode, now) {
    await this.database.prepare(`
      UPDATE schema12_jobs
      SET state = 'dispatch_pending', dispatch_attempts = dispatch_attempts + 1,
          last_error_code = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?
      WHERE job_id = ? AND state = 'dispatching' AND lease_owner = ?
    `).bind(errorCode, now.toISOString(), jobId, leaseOwner).run();
  }

  async listDispatchPending(limit) {
    const statement = this.database.prepare(`
      SELECT job_id, request_id, user_id, envelope_json, envelope_hash, state,
             dispatch_attempts, sync_attempts, last_error_code,
             broker_message_id, lease_owner, lease_until
      FROM schema12_jobs WHERE state = 'dispatch_pending'
      ORDER BY created_at ASC LIMIT ?
    `).bind(limit);
    const rows = await statement.all();
    return rows.results.map((row) => mapRow(row, false));
  }

  async requeueExpiredLeases(now) {
    const timestamp = now.toISOString();
    const result = await this.database.prepare(`
      UPDATE schema12_jobs
      SET state = CASE WHEN state = 'dispatching' THEN 'dispatch_pending' ELSE 'broker_queued' END,
          lease_owner = NULL, lease_until = NULL, updated_at = ?
      WHERE state IN ('dispatching', 'syncing')
        AND lease_until IS NOT NULL AND lease_until <= ?
    `).bind(timestamp, timestamp).run();
    return Number(result.meta?.changes ?? 0);
  }

  async claimForSync(jobId, leaseOwner, now, leaseUntil) {
    await this.database.prepare(`
      UPDATE schema12_jobs
      SET state = 'syncing', sync_attempts = sync_attempts + 1,
          lease_owner = ?, lease_until = ?, updated_at = ?
      WHERE job_id = ? AND state = 'broker_queued'
    `).bind(leaseOwner, leaseUntil.toISOString(), now.toISOString(), jobId).run();
    const job = await this.getJob(jobId);
    return job?.state === "syncing" && job.leaseOwner === leaseOwner ? job : null;
  }

  async markSynced(jobId, leaseOwner, now) {
    const result = await this.database.prepare(`
      UPDATE schema12_jobs
      SET state = 'synced', lease_owner = NULL, lease_until = NULL,
          last_error_code = NULL, completed_at = ?, updated_at = ?
      WHERE job_id = ? AND state = 'syncing' AND lease_owner = ?
    `).bind(now.toISOString(), now.toISOString(), jobId, leaseOwner).run();
    return result.meta?.changes === 1;
  }

  async releaseSync(jobId, leaseOwner, errorCode, now) {
    const result = await this.database.prepare(`
      UPDATE schema12_jobs
      SET state = 'broker_queued', lease_owner = NULL, lease_until = NULL,
          last_error_code = ?, updated_at = ?
      WHERE job_id = ? AND state = 'syncing' AND lease_owner = ?
    `).bind(errorCode, now.toISOString(), jobId, leaseOwner).run();
    return result.meta?.changes === 1;
  }

  async markNeedsAttention(jobId, leaseOwner, errorCode, now) {
    const result = await this.database.prepare(`
      UPDATE schema12_jobs
      SET state = 'needs_attention', lease_owner = NULL, lease_until = NULL,
          last_error_code = ?, updated_at = ?
      WHERE job_id = ? AND state = 'syncing' AND lease_owner = ?
    `).bind(errorCode, now.toISOString(), jobId, leaseOwner).run();
    return result.meta?.changes === 1;
  }

  async markFailureNeedsAttention(jobId, errorCode, now) {
    await this.database.prepare(`
      UPDATE schema12_jobs
      SET state = 'needs_attention', lease_owner = NULL, lease_until = NULL,
          last_error_code = ?, updated_at = ?
      WHERE job_id = ? AND state <> 'synced'
    `).bind(errorCode, now.toISOString(), jobId).run();
    const job = await this.getJob(jobId);
    return job?.state === "needs_attention" ? job : null;
  }

  async openFailureNotice(userId, category, message, now) {
    const timestamp = now.toISOString();
    await this.database.prepare(`
      INSERT OR IGNORE INTO schema12_failure_notices (
        notice_id, user_id, category, message, status, opened_at, updated_at
      ) VALUES (?, ?, ?, ?, 'open', ?, ?)
    `).bind(crypto.randomUUID(), userId, category, message, timestamp, timestamp).run();
  }

  async findByRequestId(requestId) {
    return this.database.prepare(`
      SELECT job_id, request_id, user_id, envelope_json, envelope_hash, state,
             dispatch_attempts, sync_attempts, last_error_code,
             broker_message_id, lease_owner, lease_until
      FROM schema12_jobs WHERE request_id = ?
    `).bind(requestId).first();
  }
}

export class InMemoryJobRepository {
  constructor(newJobId = () => crypto.randomUUID()) {
    this.newJobId = newJobId;
    this.jobsByRequestId = new Map();
    this.envelopesByJobId = new Map();
    this.notices = [];
  }

  get jobCount() {
    return this.jobsByRequestId.size;
  }

  async createOrGet(envelope) {
    const envelopeJson = canonicalEnvelopeJson(envelope);
    const envelopeHash = await sha256Hex(envelopeJson);
    const existing = this.jobsByRequestId.get(envelope.requestId);
    if (existing) {
      if (existing.envelopeHash !== envelopeHash) throw new JobRepositoryError("request_id_conflict");
      return acceptedJob(existing.job, false);
    }
    const job = {
      jobId: this.newJobId(),
      requestId: envelope.requestId,
      userId: identityUserId(envelope),
      state: "dispatch_pending",
      dispatchAttempts: 0,
      syncAttempts: 0,
      lastErrorCode: null,
      brokerMessageId: null,
      leaseOwner: null,
      leaseUntil: null
    };
    this.jobsByRequestId.set(envelope.requestId, { job, envelopeHash });
    this.envelopesByJobId.set(job.jobId, clone(envelope));
    return acceptedJob(job, true);
  }

  async loadEnvelope(jobId) {
    const envelope = this.envelopesByJobId.get(jobId);
    return envelope ? clone(envelope) : null;
  }

  async getJob(jobId) {
    const entry = [...this.jobsByRequestId.values()].find(({ job }) => job.jobId === jobId);
    return entry ? clone(entry.job) : null;
  }

  async claimForDispatch(jobId, leaseOwner, _now, leaseUntil) {
    const job = this.findMutableJob(jobId);
    if (!job || job.state !== "dispatch_pending") return null;
    job.state = "dispatching";
    job.leaseOwner = leaseOwner;
    job.leaseUntil = leaseUntil.toISOString();
    return clone(job);
  }

  async markBrokerQueued(jobId, leaseOwner, messageId) {
    const job = this.findMutableJob(jobId);
    if (!job || job.state !== "dispatching" || job.leaseOwner !== leaseOwner) return false;
    job.state = "broker_queued";
    job.brokerMessageId = messageId;
    job.lastErrorCode = null;
    job.leaseOwner = null;
    job.leaseUntil = null;
    return true;
  }

  async recordDispatchFailure(jobId, leaseOwner, errorCode) {
    const job = this.findMutableJob(jobId);
    if (!job || job.state !== "dispatching" || job.leaseOwner !== leaseOwner) return;
    job.state = "dispatch_pending";
    job.dispatchAttempts += 1;
    job.lastErrorCode = errorCode;
    job.leaseOwner = null;
    job.leaseUntil = null;
  }

  async listDispatchPending(limit) {
    return [...this.jobsByRequestId.values()]
      .map(({ job }) => job)
      .filter((job) => job.state === "dispatch_pending")
      .slice(0, limit)
      .map(clone);
  }

  async requeueExpiredLeases(now) {
    const timestamp = now instanceof Date ? now.getTime() : Date.parse(now);
    let count = 0;
    for (const { job } of this.jobsByRequestId.values()) {
      if (!job.leaseUntil || Date.parse(job.leaseUntil) > timestamp) continue;
      if (job.state === "dispatching") job.state = "dispatch_pending";
      else if (job.state === "syncing") job.state = "broker_queued";
      else continue;
      job.leaseOwner = null;
      job.leaseUntil = null;
      count += 1;
    }
    return count;
  }

  async claimForSync(jobId, leaseOwner, _now, leaseUntil) {
    const job = this.findMutableJob(jobId);
    if (!job || job.state !== "broker_queued") return null;
    job.state = "syncing";
    job.syncAttempts += 1;
    job.leaseOwner = leaseOwner;
    job.leaseUntil = leaseUntil.toISOString();
    return clone(job);
  }

  async markSynced(jobId, leaseOwner) {
    const job = this.findMutableJob(jobId);
    if (!job || job.state !== "syncing" || job.leaseOwner !== leaseOwner) return false;
    job.state = "synced";
    job.lastErrorCode = null;
    job.leaseOwner = null;
    job.leaseUntil = null;
    return true;
  }

  async releaseSync(jobId, leaseOwner, errorCode) {
    const job = this.findMutableJob(jobId);
    if (!job || job.state !== "syncing" || job.leaseOwner !== leaseOwner) return false;
    job.state = "broker_queued";
    job.lastErrorCode = errorCode;
    job.leaseOwner = null;
    job.leaseUntil = null;
    return true;
  }

  async markNeedsAttention(jobId, leaseOwner, errorCode) {
    const job = this.findMutableJob(jobId);
    if (!job || job.state !== "syncing" || job.leaseOwner !== leaseOwner) return false;
    job.state = "needs_attention";
    job.lastErrorCode = errorCode;
    job.leaseOwner = null;
    job.leaseUntil = null;
    return true;
  }

  async markFailureNeedsAttention(jobId, errorCode) {
    const job = this.findMutableJob(jobId);
    if (!job || job.state === "synced") return null;
    job.state = "needs_attention";
    job.lastErrorCode = errorCode;
    job.leaseOwner = null;
    job.leaseUntil = null;
    return clone(job);
  }

  async openFailureNotice(userId, category, message) {
    if (!this.notices.some((notice) => notice.userId === userId && notice.category === category)) {
      this.notices.push({ userId, category, message });
    }
  }

  findMutableJob(jobId) {
    return [...this.jobsByRequestId.values()].find(({ job }) => job.jobId === jobId)?.job ?? null;
  }
}
