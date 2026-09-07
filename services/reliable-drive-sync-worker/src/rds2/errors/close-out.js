// G2-F2: classify a storage error and close the task out by class.
//
// Before this layer, every non-contract exception was blanket-deferred with
// availableAt = now: no failure count, no backoff, no way to park — a real
// fault could retry forever at zero cost.
//
// Classification is done exactly once (storage-error.js) and the SPECIFIC
// marker is preserved; only the resulting class decides the close-out:
//
//   A budget exhaustion — a normal wait: deferred, never counted, never
//     parked. The ledger refused a consume, nothing else went wrong.
//   B lease/CAS conflict — re-check authoritative state; never claim success
//     without it, never count a real failure.
//   C transient storage fault — count, back off, park at the threshold.
//   D deterministic contract/size error — park with a stable reason; deferring
//     forever would hide it.
//   E close-out itself unavailable — report failure honestly with a STABLE
//     code, keep the recovery path (lease expiry + reclaim), never claim a
//     persisted backoff or count, never rethrow the raw error.
//
// G2-R1: the close-out used to let ITS OWN failures (verify/park/fail) throw
// the raw storage error straight through the service boundary while the task
// stayed in processing. Every persisted transition below is now guarded, and
// every SUCCESSFUL transition emits exactly one sanitized structured log line
// (closed-set fields only — no message, SQL, cause or user content).
import { failTask, parkNeedsAttention, deferTask } from "../tasks/repository.js";
import { classifyStorageError } from "./storage-error.js";

// Sub-requests each close-out needs: failTask reads then writes (2),
// parkNeedsAttention writes (1), a defer writes (1), an authoritative
// re-check reads twice (2).
export const CLOSE_OUT_COST = Object.freeze({ verify: 2, park: 1, fail: 2, defer: 1 });

function remainingBudget(io) {
  return typeof io?.budget?.remaining === "function" ? io.budget.remaining() : Number.POSITIVE_INFINITY;
}

// The sanitized structured log line. Fields are a closed set; values are
// closed-set tokens. Never the original message, SQL, cause or scope.
function logLine({ taskId, outcome, class: klass, code, at }) {
  return JSON.stringify({ event: "rds2_task_closeout", taskId, outcome, class: klass, code, at });
}

// Only called after a SUCCESSFUL persisted transition. An unconfigured sink
// (the default) simply skips logging; production entry points pass their
// structured logger.
function emitCloseOutLog(io, entry) {
  const sink = io?.log;
  if (typeof sink === "function") sink(logLine(entry));
}

// Stable class-E results. The recovery path stays open: the lease simply
// expires and reclaimStale hands the task back to the queue — no retry loop
// inside the close-out, no fabricated persisted state.
const E_RESULTS = Object.freeze({
  verify: "closeout_verify_unavailable",
  park: "closeout_park_unavailable",
  fail: "closeout_fail_unavailable",
  budget: "budget_exhausted_no_closeout"
});

function classEResult(taskId, code) {
  return { outcome: "failed", taskId, code, class: "E" };
}

/**
 * @param {object} options
 * @param {object} options.io            budgeted invocation io (optional io.log sink)
 * @param {object} options.lease         active lease (owner/epoch bound)
 * @param {string} options.now
 * @param {string} options.taskId
 * @param {unknown} options.error
 * @param {object} [options.context]     passed to the classifier
 * @param {Function} [options.verifyAuthoritative] async () => boolean
 * @param {string} [options.verifiedCode] code reported when the authoritative
 *        state proves the work actually landed.
 * @returns {Promise<{outcome: string, taskId: string, code: string, class: string}>}
 */
export async function closeOutFailure({
  io,
  lease,
  now,
  taskId,
  error,
  context = {},
  verifyAuthoritative = null,
  verifiedCode = "build_activated"
}) {
  const classified = classifyStorageError({ error, context });
  const remaining = remainingBudget(io);

  // A: the ledger refused a consume mid-stage. Not a failure: hand the task
  // back as a normal wait. Booking the defer itself needs one sub-request.
  if (classified.class === "A") {
    if (remaining < CLOSE_OUT_COST.defer) return classEResult(taskId, E_RESULTS.budget);
    let deferred;
    try {
      deferred = await deferTask({ db: io.db, lease, now, availableAt: now });
    } catch {
      return classEResult(taskId, E_RESULTS.budget);
    }
    if (!deferred.rowsWritten) return { outcome: "noop", taskId, code: "lease_lost", class: "B" };
    emitCloseOutLog(io, { taskId, outcome: "retry", class: "A", code: classified.code, at: now });
    return { outcome: "retry", taskId, code: classified.code, class: "A" };
  }

  if (classified.class === "B") {
    // A lost lease is not success and not a failure: only the authoritative
    // state may back a completed verdict. A re-check that ITSELF fails must
    // not leak the raw error — the honest answer is a stable class E.
    if (verifyAuthoritative && remaining >= CLOSE_OUT_COST.verify) {
      let converged = false;
      try {
        converged = await verifyAuthoritative();
      } catch {
        return classEResult(taskId, E_RESULTS.verify);
      }
      if (converged) {
        emitCloseOutLog(io, { taskId, outcome: "completed", class: "B", code: verifiedCode, at: now });
        return { outcome: "completed", taskId, code: verifiedCode, class: "B" };
      }
    }
    return { outcome: "noop", taskId, code: "lease_lost", class: "B" };
  }

  if (classified.class === "D") {
    if (remaining < CLOSE_OUT_COST.park) {
      return classEResult(taskId, E_RESULTS.budget);
    }
    let parked;
    try {
      parked = await parkNeedsAttention({ db: io.db, lease, now, code: classified.code });
    } catch {
      return classEResult(taskId, E_RESULTS.park);
    }
    // Zero rows means our lease was taken over — we wrote nothing, so we must
    // not claim to have parked anything.
    if (!parked.rowsWritten) return { outcome: "noop", taskId, code: "lease_lost", class: "B" };
    emitCloseOutLog(io, { taskId, outcome: "needs_attention", class: "D", code: classified.code, at: now });
    return { outcome: "needs_attention", taskId, code: classified.code, class: "D" };
  }

  // C: a transient storage fault. Bounded retry, never an infinite defer.
  if (remaining < CLOSE_OUT_COST.fail) {
    return classEResult(taskId, E_RESULTS.budget);
  }
  let failure;
  try {
    failure = await failTask({ db: io.db, lease, now, code: classified.code });
  } catch {
    return classEResult(taskId, E_RESULTS.fail);
  }
  if (!failure.rowsWritten) return { outcome: "noop", taskId, code: "lease_lost", class: "B" };
  const outcome = failure.state === "needs_attention" ? "needs_attention" : "retry";
  emitCloseOutLog(io, { taskId, outcome, class: "C", code: "deferred_commit_failed", at: now });
  return {
    outcome,
    taskId,
    code: "deferred_commit_failed",
    class: "C"
  };
}
