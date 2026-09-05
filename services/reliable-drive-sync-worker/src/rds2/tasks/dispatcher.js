// RDS V2 dispatcher (Rev 6 plan T05). dispatchOne claims a pending task,
// sends exactly {taskId, type} to the task-type's queue, and writes the
// queued state back conditionally. Task content is loaded by the consumer
// from D1 — queue messages never carry user or event payloads.
import { claimForDispatch, markQueued, failTask } from "./repository.js";

export const QUEUE_BY_TASK_TYPE = Object.freeze({
  projection: "RDS2_PROJECTION_QUEUE",
  archive_event: "RDS2_ARCHIVE_QUEUE",
  archive_delta: "RDS2_ARCHIVE_QUEUE"
});

function stepResult(outcome, taskId, code) {
  return { outcome, taskId, code };
}

export async function dispatchOne({ io, taskId, owner, now }) {
  const lease = await claimForDispatch({ db: io.db, taskId, owner, now });
  if (!lease) return stepResult("noop", taskId, "not_claimable");
  const queueName = QUEUE_BY_TASK_TYPE[lease.type];
  const queue = queueName ? io.queues?.[queueName] : null;
  if (!queue) {
    // Nothing may silently swallow a task whose queue binding is missing:
    // record a real failure so backoff/needs_attention machinery applies.
    const failure = await failTask({ db: io.db, lease, now, code: "queue_binding_missing" });
    return stepResult(failure.state === "needs_attention" ? "needs_attention" : "retry",
      taskId, "queue_binding_missing");
  }
  try {
    await queue.send({ taskId, type: lease.type });
  } catch {
    // The budgeted send already counted the failed attempt. Release the
    // lease through the owner-scoped failure close.
    const failure = await failTask({ db: io.db, lease, now, code: "queue_send_failed" });
    return stepResult(failure.state === "needs_attention" ? "needs_attention" : "retry",
      taskId, "queue_send_failed");
  }
  // The late writeback races with the consumer by design: zero rows simply
  // means the consumer claimed (or finished) first — never roll that back.
  await markQueued({ db: io.db, taskId, owner, epoch: lease.epoch, now });
  return stepResult("continued", taskId, "queued");
}

// A consumer that receives several messages in one batch processes only the
// first and asks for the rest to be retried; no unbounded in-invocation loop.
export function splitQueueBatch(messages) {
  if (!Array.isArray(messages)) return { first: null, rest: [] };
  const first = messages[0];
  if (first && typeof first.taskId === "string" && typeof first.type === "string"
    && QUEUE_BY_TASK_TYPE[first.type] !== undefined) {
    return { first, rest: messages.slice(1) };
  }
  return { first: null, rest: [...messages] };
}
