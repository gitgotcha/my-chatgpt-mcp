// RDS V2 recovery (Rev 6 plan T05 / addendum §8). The recovery pass is the
// ONLY dispatcher in this version: accept writes tasks without sending Queue
// messages, so every due pending task AND every expired lease is picked up
// here. It never touches active leases, never revives needs_attention tasks,
// and reserves each task's worst-case budget BEFORE starting it — without
// headroom it stops instead of overrunning the invocation quota.
import { reclaimStale, findDueTasks } from "./repository.js";
import { dispatchOne } from "./dispatcher.js";

export const RECOVERY_TASK_LIMIT = 4;

// Worst case per task: reclaim (1, stale leases only) + dispatch claim (1) +
// budgeted queue send attempt (1, counted even when it fails) + failure close
// read+write (2).
export const RECOVERY_WORST_CASE_PER_TASK = 5;

export async function recoverOnce({ io, now, limit = RECOVERY_TASK_LIMIT }) {
  // The four-task pass is a fixed design boundary; a caller may shrink it
  // (budget headroom) but never amplify it.
  const effectiveLimit = Math.max(1, Math.min(Number(limit) || RECOVERY_TASK_LIMIT, RECOVERY_TASK_LIMIT));
  const stats = {
    considered: 0,
    reclaimed: 0,
    dispatched: 0,
    needsAttention: 0,
    stoppedForBudget: false
  };
  const due = await findDueTasks({ db: io.db, now, limit: effectiveLimit });
  for (const task of due) {
    // Reserve the task's worst-case completion/failure close before starting;
    // without the headroom the pass ends here.
    if (io.budget.remaining() < RECOVERY_WORST_CASE_PER_TASK) {
      stats.stoppedForBudget = true;
      break;
    }
    stats.considered += 1;
    if (task.state !== "pending") {
      const reclaimed = await reclaimStale({ db: io.db, taskId: task.taskId, now });
      if (!reclaimed.rowsWritten) continue;
      stats.reclaimed += 1;
    }
    const result = await dispatchOne({ io, taskId: task.taskId, owner: `recovery-${now}`, now });
    if (result.outcome === "continued") stats.dispatched += 1;
    else if (result.outcome === "needs_attention") stats.needsAttention += 1;
  }
  return stats;
}
