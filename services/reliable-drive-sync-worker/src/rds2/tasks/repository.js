// RDS V2 task repository (Rev 6 plan T05 / addendum §8). One authoritative
// lease per task, carried by rds2_tasks only. Every transition is a
// conditional UPDATE whose RETURNING/changes row count decides success —
// never a boolean returned without checking how many rows were written.
// attempt counts real dispatch claims (diagnostics only); failure_count
// counts consecutive real external failures and never grows through deferral,
// waiting for predecessor events or budget-hold backs.

export const TASK_LEASE_SECONDS = 300;
export const FAILURE_BACKOFF_SECONDS = [30, 60, 120, 240, 480];
export const FAILURE_COUNT_THRESHOLD = 5;

export const TASK_STATES = Object.freeze([
  "pending", "dispatching", "queued", "processing", "completed", "needs_attention"
]);

function leaseUntil(now, leaseSeconds) {
  return new Date(Date.parse(now) + leaseSeconds * 1000).toISOString();
}

function backoffFor(failureCount) {
  return FAILURE_BACKOFF_SECONDS[Math.min(failureCount, FAILURE_BACKOFF_SECONDS.length - 1)];
}

export async function getTask(db, taskId) {
  return db.prepare(
    `SELECT task_id, type, user_id, namespace, projection_name, event_seq, artifact_id,
            state, available_at, attempt, failure_count, lease_owner, lease_until,
            lease_epoch, payload_json
     FROM rds2_tasks WHERE task_id = ?`
  ).bind(taskId).first();
}

// pending -> dispatching. RETURNING with zero rows means the claim failed
// (not pending yet, or available_at in the future).
export async function claimForDispatch({ db, taskId, owner, now, leaseSeconds = TASK_LEASE_SECONDS }) {
  const result = await db.prepare(
    `UPDATE rds2_tasks
     SET state = 'dispatching', lease_owner = ?, lease_until = ?,
         lease_epoch = lease_epoch + 1, attempt = attempt + 1, updated_at = ?
     WHERE task_id = ? AND state = 'pending' AND available_at <= ?
     RETURNING task_id, type, attempt, lease_owner, lease_until, lease_epoch`
  ).bind(owner, leaseUntil(now, leaseSeconds), now, taskId, now).all();
  const row = result.results[0];
  if (!row) return null;
  return {
    taskId: row.task_id,
    type: row.type,
    owner: row.lease_owner,
    leaseUntil: row.lease_until,
    epoch: Number(row.lease_epoch),
    attempt: Number(row.attempt)
  };
}

// dispatching/queued -> processing. The consumer accepts tasks whose Queue
// send succeeded but whose state writeback raced, and increments the epoch
// WITHOUT adding an attempt.
export async function claimForProcessing({ db, taskId, owner, now, leaseSeconds = TASK_LEASE_SECONDS }) {
  const result = await db.prepare(
    `UPDATE rds2_tasks
     SET state = 'processing', lease_owner = ?, lease_until = ?,
         lease_epoch = lease_epoch + 1, updated_at = ?
     WHERE task_id = ? AND state IN ('dispatching', 'queued') AND available_at <= ?
     RETURNING task_id, type, user_id, namespace, projection_name, event_seq, artifact_id,
               lease_owner, lease_until, lease_epoch`
  ).bind(owner, leaseUntil(now, leaseSeconds), now, taskId, now).all();
  const row = result.results[0];
  if (!row) return null;
  return {
    taskId: row.task_id,
    type: row.type,
    scope: {
      userId: row.user_id,
      namespace: row.namespace,
      projectionName: row.projection_name
    },
    eventSeq: row.event_seq === null ? null : Number(row.event_seq),
    artifactId: row.artifact_id,
    owner: row.lease_owner,
    leaseUntil: row.lease_until,
    epoch: Number(row.lease_epoch)
  };
}

// Late dispatcher writeback. Only a task still dispatching under the SAME
// owner/epoch moves to queued; a consumer that claimed first is never
// reverted. rowsWritten === 0 means someone moved on — not an error.
export async function markQueued({ db, taskId, owner, epoch, now }) {
  const result = await db.prepare(
    `UPDATE rds2_tasks SET state = 'queued', updated_at = ?
     WHERE task_id = ? AND state = 'dispatching' AND lease_owner = ? AND lease_epoch = ?`
  ).bind(now, taskId, owner, epoch).run();
  return { rowsWritten: Number(result.meta?.changes ?? 0) };
}

// processing -> completed. The full lease predicate binds owner, epoch and
// expiry, so an owner whose lease expired or was taken over writes zero rows.
export async function completeTask({ db, lease, now }) {
  const result = await db.prepare(
    // Success clears the consecutive-failure counter here too: this is the
    // authoritative completion path, and an admin replay is not a substitute.
    `UPDATE rds2_tasks SET state = 'completed', lease_owner = NULL, lease_until = NULL,
       failure_count = 0, updated_at = ?
     WHERE task_id = ? AND state = 'processing'
       AND lease_owner = ? AND lease_epoch = ? AND lease_until > ?`
  ).bind(now, lease.taskId, lease.owner, lease.epoch, now).run();
  return { rowsWritten: Number(result.meta?.changes ?? 0) };
}

// processing|dispatching -> pending|needs_attention on a real external
// failure. The dispatcher's send-failure close runs from 'dispatching', the
// consumer's from 'processing'. The backoff schedule applies to the retry
// availability; the fifth consecutive failure parks the task for a human.
// The new state is derived from the failure arithmetic so callers need no
// extra read.
export async function failTask({ db, lease, now, code }) {
  const current = await getTask(db, lease.taskId);
  const oldFailures = Number(current?.failure_count ?? 0);
  const backoff = backoffFor(oldFailures);
  const availableAt = new Date(Date.parse(now) + backoff * 1000).toISOString();
  const result = await db.prepare(
    `UPDATE rds2_tasks
     SET state = CASE WHEN failure_count + 1 >= ${FAILURE_COUNT_THRESHOLD}
                      THEN 'needs_attention' ELSE 'pending' END,
         failure_count = failure_count + 1,
         lease_owner = NULL, lease_until = NULL,
         available_at = ?, updated_at = ?,
         payload_json = json_set(payload_json, '$.lastFailure', json(?))
     WHERE task_id = ? AND state IN ('dispatching', 'processing')
       AND lease_owner = ? AND lease_epoch = ? AND lease_until > ?`
  ).bind(availableAt, now, JSON.stringify({ code, at: now }), lease.taskId, lease.owner, lease.epoch, now).run();
  const rowsWritten = Number(result.meta?.changes ?? 0);
  return {
    rowsWritten,
    availableAt,
    backoffSeconds: backoff,
    state: rowsWritten && oldFailures + 1 >= FAILURE_COUNT_THRESHOLD ? "needs_attention" : "pending"
  };
}

// Budget-hold, waiting for a predecessor event, or a normal continuation page:
// back to pending with a new availability WITHOUT touching failure_count.
export async function deferTask({ db, lease, now, availableAt }) {
  const result = await db.prepare(
    `UPDATE rds2_tasks SET state = 'pending', lease_owner = NULL, lease_until = NULL,
         available_at = ?, updated_at = ?
     WHERE task_id = ? AND state = 'processing'
       AND lease_owner = ? AND lease_epoch = ? AND lease_until > ?`
  ).bind(availableAt, now, lease.taskId, lease.owner, lease.epoch, now).run();
  return { rowsWritten: Number(result.meta?.changes ?? 0) };
}

// Recovery reclaim: an expired dispatching/queued/processing lease goes back
// to pending with a bumped epoch so the stale owner can never write again.
export async function reclaimStale({ db, taskId, now }) {
  const result = await db.prepare(
    `UPDATE rds2_tasks
     SET state = 'pending', lease_owner = NULL, lease_until = NULL,
         lease_epoch = lease_epoch + 1, updated_at = ?
     WHERE task_id = ? AND state IN ('dispatching', 'queued', 'processing')
       AND (lease_until IS NULL OR lease_until <= ?)`
  ).bind(now, taskId, now).run();
  return { rowsWritten: Number(result.meta?.changes ?? 0) };
}

// Due work for the recovery pass: pending tasks whose availability has come
// (fresh events, new delta tasks, build pages, backoff-expired retries) plus
// tasks whose lease expired. Only the latter need reclaiming.
export async function findDueTasks({ db, now, limit }) {
  const result = await db.prepare(
    `SELECT task_id, type, state FROM rds2_tasks
     WHERE (state = 'pending' AND available_at <= ?)
        OR (state IN ('dispatching', 'queued', 'processing')
            AND (lease_until IS NULL OR lease_until <= ?))
     ORDER BY available_at, task_id
     LIMIT ?`
  ).bind(now, now, limit).all();
  return result.results.map((row) => ({ taskId: row.task_id, type: row.type, state: row.state }));
}

// An integrity failure (hash mismatch, ambiguous object) parks the task for
// a human immediately instead of burning through the backoff schedule.
export async function parkNeedsAttention({ db, lease, now, code }) {
  const result = await db.prepare(
    `UPDATE rds2_tasks
     SET state = 'needs_attention', lease_owner = NULL, lease_until = NULL,
         payload_json = json_set(payload_json, '$.lastParkReason', json(?)),
         updated_at = ?
     WHERE task_id = ? AND state = 'processing'
       AND lease_owner = ? AND lease_epoch = ? AND lease_until > ?`
  ).bind(JSON.stringify({ code, at: now }), now, lease.taskId, lease.owner, lease.epoch, now).run();
  return { rowsWritten: Number(result.meta?.changes ?? 0) };
}

// Admin replay of a needs_attention task: same task id, audited reason,
// bumped epoch, back to pending. Never called automatically.
export async function requeueNeedsAttention({ db, taskId, reason, now }) {
  const result = await db.prepare(
    `UPDATE rds2_tasks
     SET state = 'pending', lease_owner = NULL, lease_until = NULL,
         lease_epoch = lease_epoch + 1, failure_count = 0,
         payload_json = json_set(payload_json, '$.lastReplayReason', json(?)),
         updated_at = ?
     WHERE task_id = ? AND state = 'needs_attention'`
  ).bind(JSON.stringify({ reason, at: now }), now, taskId).run();
  return { rowsWritten: Number(result.meta?.changes ?? 0) };
}
