// RDS V2 projection engine (Rev 6 plan T06 / addendum §7). One invocation
// applies the scope's minimal unprocessed event through a domain reducer and
// commits rows, head, frozen delta, archive task and task completion in one
// guarded batch. Out-of-order events, concurrent build activity and lost
// races are deferred — never applied out of turn, never counted as failures.
import { claimForProcessing, deferTask, getTask } from "../tasks/repository.js";
import { loadProjectionHead, ensureBuild, fetchEventBySeq } from "./builds.js";
import { commitProjection } from "./commit.js";

function stepResult(outcome, taskId, code) {
  return { outcome, taskId, code };
}

export async function projectOne({ io, taskId, owner, now, reducer, lease = null }) {
  const activeLease = lease ?? await claimForProcessing({ db: io.db, taskId, owner, now });
  if (!activeLease) return stepResult("noop", taskId, "not_claimable");
  const scope = activeLease.scope;

  const head = await loadProjectionHead(io.db, scope);
  if (head.building === 1) {
    // New events queue up while a rebuild is running; the activation switches
    // the generation and only then may ordinary commits resume.
    await deferTask({ db: io.db, lease: activeLease, now, availableAt: now });
    return stepResult("retry", taskId, "deferred_during_build");
  }

  const event = await fetchEventBySeq(io.db, scope, activeLease.eventSeq);
  if (!event) {
    await deferTask({ db: io.db, lease: activeLease, now, availableAt: now });
    return stepResult("retry", taskId, "event_not_found");
  }
  // Never apply an event while a smaller unprocessed one exists in scope.
  const gap = await io.db.prepare(
    `SELECT COUNT(*) AS n FROM rds2_events
     WHERE user_id = ? AND namespace = ? AND projection_name = ?
       AND event_seq > ? AND event_seq < ?`
  ).bind(scope.userId, scope.namespace, scope.projectionName, head.lastEventSeq, activeLease.eventSeq).first("n");
  if (Number(gap) > 0) {
    await deferTask({ db: io.db, lease: activeLease, now, availableAt: now });
    return stepResult("retry", taskId, "deferred_predecessor");
  }

  const plan = reducer.plan({ scope, event, head });
  if (plan.rebuild) {
    await ensureBuild({ db: io.db, scope, baseRevision: head.revision, now });
    await deferTask({ db: io.db, lease: activeLease, now, availableAt: now });
    return stepResult("retry", taskId, "rebuild_started");
  }

  try {
    await commitProjection({
      io, lease: activeLease, baseRevision: head.revision,
      activeGeneration: head.activeGeneration,
      changes: { rowChanges: plan.rowChanges, summary: plan.summary, eventSeq: activeLease.eventSeq },
      now
    });
    return stepResult("completed", taskId, null);
  } catch (error) {
    // A reducer that exceeds the bounded commit limits is a programming
    // error: it must never be truncated and never silently deferred.
    if (error?.code === "changes_too_large" || error?.code === "commit_batch_too_large") throw error;
    // Guard rejections (a racing commit won) and storage failures roll the
    // whole batch back; the task defers with a clean failure count.
    const deferred = await deferTask({ db: io.db, lease: activeLease, now, availableAt: now });
    if (!deferred.rowsWritten) {
      const task = await getTask(io.db, taskId);
      if (task?.state === "completed") return stepResult("completed", taskId, null);
    }
    return stepResult("retry", taskId, "deferred_commit_failed");
  }
}
