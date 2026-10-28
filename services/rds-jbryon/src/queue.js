// Queue consumer and Cron recovery for RDS-JBryon (design §10).
//
// The Queue message carries identity only (taskId/type/attempt); the consumer
// takes a fresh processing lease from D1 and the commit guard is the authority
// for owner/epoch/expiry. Cron only dispatches tasks; it never performs their
// projection. It also re-dispatches overdue queue handoffs and expired leases.
export function createProjectionQueue({ store, owner = "rds-jbryon-queue" }) {
  if (!store || typeof store.claimTask !== "function" || typeof store.claimTaskById !== "function") {
    throw new Error("invalid_store");
  }

  /** Claim due tasks, release them as `queued`, and produce Queue messages. */
  async function dispatchDue({ limit = 20 } = {}) {
    const messages = [];
    for (let index = 0; index < Math.max(1, Math.min(Number(limit) || 20, 50)); index += 1) {
      const task = await store.claimTask({ owner, includeQueued: true });
      if (!task) break;
      // Hand the task to the queue as a one-time transition; after this the
      // dispatcher holds no lease. A duplicate delivery cannot steal a live
      // consumer lease because the task is back to `queued`, not processing.
      const handoff = typeof store.queueTask === "function"
        ? await store.queueTask({ taskId: task.taskId, owner: task.owner, epoch: task.epoch })
        : { queued: true };
      if (handoff.queued === false) continue;
      messages.push({
        taskId: task.taskId,
        taskType: "projection",
        attempt: task.epoch
      });
    }
    return messages;
  }

  /** Consume one message. Duplicate delivery is harmless: the lease decides. */
  async function consume(message) {
    if (!message || typeof message.taskId !== "string") return { ok: false, code: "invalid_message" };
    const claimed = await store.claimTaskById({ taskId: message.taskId, owner });
    if (!claimed) return { ok: false, code: "lease_not_held", stale: true };
    if (claimed.blocked) return { ok: false, code: claimed.code, waiting: true };
    return store.applyOne({
      taskId: claimed.taskId,
      owner: claimed.owner,
      epoch: claimed.epoch
    });
  }

  return { dispatchDue, consume };
}

/** Manual fallback helper; the production Cron path must dispatch to Queue. */
export function createScheduledRecovery({ store, owner = "rds-jbryon-cron", maxTasks = 100 }) {
  if (!store || typeof store.projectAll !== "function") throw new Error("invalid_store");
  return async function scheduled() {
    const result = await store.projectAll({ owner, maxTasks });
    return {
      processed: result?.processed ?? 0,
      results: result?.results ?? [],
      ranAt: new Date().toISOString()
    };
  };
}
