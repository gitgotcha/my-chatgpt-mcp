// RDS V2 projection engine (Rev 6 plan T06 / addendum §7). One invocation
// applies the scope's minimal unprocessed event through a domain reducer and
// commits rows, head, frozen delta, archive task and task completion in one
// guarded batch. Out-of-order events, concurrent build activity and lost
// races are deferred — never applied out of turn, never counted as failures.
import { claimForProcessing, deferTask, completeTask, getTask } from "../tasks/repository.js";
import { closeOutFailure } from "../errors/close-out.js";
import { loadProjectionHead, ensureBuild, fetchEventBySeq } from "./builds.js";
import { commitProjection } from "./commit.js";

// "Is there an unprocessed predecessor for this event?" — a yes/no question,
// so the answer is a bounded existence probe (LIMIT 1) that walks the
// covering (user_id, namespace, projection_name, event_seq) index. A COUNT
// over the whole range would make the cost grow with the backlog. Exported so
// the contract test plans exactly the statement the engine runs.
export const PREDECESSOR_PROBE_SQL = `SELECT 1 AS found FROM rds2_events
     WHERE user_id = ? AND namespace = ? AND projection_name = ?
       AND event_seq > ? AND event_seq < ? LIMIT 1`;

function stepResult(outcome, taskId, code) {
  return { outcome, taskId, code };
}

export async function projectOne({ io, taskId, owner, now, reducer, lease = null }) {
  const activeLease = lease ?? await claimForProcessing({ db: io.db, taskId, owner, now });
  if (!activeLease) return stepResult("noop", taskId, "not_claimable");
  const scope = activeLease.scope;
  // G2-R1 (2026-09-07 implementation review): EVERYTHING after the lease
  // lives inside ONE error boundary — the head load, the convergence probe,
  // the event fetch, the predecessor probe, the reducer reads and plan, and
  // ensureBuild used to run OUTSIDE the commit try, so a fault there escaped
  // projectOne and left the task in processing, uncounted, until the lease
  // expired. Without a lease (the claim itself fails) there is nothing to
  // close out and no state may be fabricated, so that part stays outside.
  const runLeased = async () => {
  const head = await loadProjectionHead(io.db, scope);
  // Already-applied event: converge the stale task without touching the
  // reducer, the revision or the archive — exactly-once business effect with
  // at-least-once task messages.
  if (activeLease.eventSeq <= head.lastEventSeq) {
    const done = await completeTask({ db: io.db, lease: activeLease, now });
    return done.rowsWritten
      ? stepResult("completed", taskId, "already_applied")
      : stepResult("noop", taskId, "lease_lost");
  }
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
  // The answer is yes/no, so this is a bounded existence probe — LIMIT 1 over
  // the covering (user, namespace, projection, event_seq) index — never a
  // COUNT over the whole backlog range.
  const predecessor = await io.db.prepare(PREDECESSOR_PROBE_SQL).bind(scope.userId, scope.namespace, scope.projectionName, head.lastEventSeq, activeLease.eventSeq)
    .first("found");
  if (predecessor !== null) {
    await deferTask({ db: io.db, lease: activeLease, now, availableAt: now });
    return stepResult("retry", taskId, "deferred_predecessor");
  }

  // Execute the reducer's declared read plan: bounded point lookups on the
  // active generation, one batch, however long the history is.
  const readPlan = reducer.reads ? reducer.reads({ scope, event }) : [];
  let rows = {};
  if (readPlan.length) {
    const readResults = await io.db.batch(readPlan.map((read) => io.db.prepare(
      `SELECT row_key, member_key, sort_key, value_json FROM rds2_projection_rows
       WHERE user_id = ? AND namespace = ? AND projection_name = ?
         AND generation = ? AND row_kind = ? AND row_key = ?`
    ).bind(scope.userId, scope.namespace, scope.projectionName, head.activeGeneration,
      read.rowKind, read.rowKey)));
    rows = Object.fromEntries(readPlan.map((read, index) => {
      const row = readResults[index]?.results?.[0];
      return [read.as, row ? {
        rowKey: row.row_key,
        memberKey: row.member_key,
        sortKey: row.sort_key,
        value: JSON.parse(row.value_json)
      } : null];
    }));
  }

  const plan = reducer.plan({ scope, event, head, rows });
  if (plan.rebuild) {
    await ensureBuild({ db: io.db, scope, baseRevision: head.revision, now });
    await deferTask({ db: io.db, lease: activeLease, now, availableAt: now });
    return stepResult("retry", taskId, "rebuild_started");
  }

  await commitProjection({
    io, lease: activeLease, baseRevision: head.revision,
    activeGeneration: head.activeGeneration,
    changes: { rowChanges: plan.rowChanges, summary: plan.summary, eventSeq: activeLease.eventSeq },
    now
  });
  return stepResult("completed", taskId, null);
  };
  try {
    return await runLeased();
  } catch (error) {
    // G2-F2/R1: classified exactly like the build path — including the
    // deterministic size/contract codes (changes_too_large,
    // commit_batch_too_large, ...), which now PARK instead of escaping past
    // the boundary for the recovery pass to re-claim forever. A racing
    // commit is not a real failure (and must not be reported as success
    // without checking the authoritative state); a transient fault counts
    // and backs off; a deterministic contract error parks instead of
    // deferring forever.
    return closeOutFailure({
      io,
      lease: activeLease,
      now,
      taskId,
      error,
      verifiedCode: null,
      verifyAuthoritative: async () => {
        const task = await getTask(io.db, taskId);
        return task?.state === "completed";
      }
    });
  }
}
