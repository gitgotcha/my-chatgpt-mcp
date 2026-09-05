// RDS V2 recovery (Rev 6 plan T05 / addendum §8). An independent pass that
// reclaims tasks whose lease expired and re-dispatches them. It never touches
// active leases, never revives needs_attention tasks, and reserves each
// task's worst-case budget BEFORE starting it — without headroom it stops
// instead of overrunning the invocation quota.
import { reclaimStale, findStaleTaskIds } from "./repository.js";
import { dispatchOne } from "./dispatcher.js";

export const RECOVERY_TASK_LIMIT = 4;

// Worst case per task: reclaim (1) + dispatch claim (1) + budgeted queue send
// attempt (1, counted even when it fails) + failure close read+write (2).
export const RECOVERY_WORST_CASE_PER_TASK = 5;

export async function recoverOnce({ io, now, limit = RECOVERY_TASK_LIMIT }) {
  const stats = {
    considered: 0,
    reclaimed: 0,
    dispatched: 0,
    needsAttention: 0,
    stoppedForBudget: false
  };
  const taskIds = await findStaleTaskIds({ db: io.db, now, limit });
  for (const taskId of taskIds) {
    // Reserve the task's worst-case completion/failure close before starting;
    // without the headroom the pass ends here.
    if (io.budget.remaining() < RECOVERY_WORST_CASE_PER_TASK) {
      stats.stoppedForBudget = true;
      break;
    }
    stats.considered += 1;
    const reclaimed = await reclaimStale({ db: io.db, taskId, now });
    if (!reclaimed.rowsWritten) continue;
    stats.reclaimed += 1;
    const result = await dispatchOne({ io, taskId, owner: `recovery-${now}`, now });
    if (result.outcome === "continued") stats.dispatched += 1;
    else if (result.outcome === "needs_attention") stats.needsAttention += 1;
  }
  return stats;
}
