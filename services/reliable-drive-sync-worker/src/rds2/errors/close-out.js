// G2-F2: classify a storage error and close the task out by class.
//
// Before this layer, every non-contract exception was blanket-deferred with
// availableAt = now: no failure count, no backoff, no way to park — a real
// fault could retry forever at zero cost.
//
// Classification is done exactly once (storage-error.js) and the SPECIFIC
// marker is preserved; only the resulting class decides the close-out:
//
//   B lease/CAS conflict — re-check authoritative state; never claim success
//     without it, never count a real failure.
//   C transient storage fault — count, back off, park at the threshold.
//   D deterministic contract/size error — park with a stable reason; deferring
//     forever would hide it.
//   E close-out itself unavailable — report failure honestly, keep the
//     recovery path, never claim a persisted backoff or count.
import { failTask, parkNeedsAttention } from "../tasks/repository.js";
import { classifyStorageError } from "./storage-error.js";

// Sub-requests each close-out needs: failTask reads then writes (2),
// parkNeedsAttention writes (1), an authoritative re-check reads twice (2).
export const CLOSE_OUT_COST = Object.freeze({ verify: 2, park: 1, fail: 2 });

function remainingBudget(io) {
  return typeof io?.budget?.remaining === "function" ? io.budget.remaining() : Number.POSITIVE_INFINITY;
}

/**
 * @param {object} options
 * @param {object} options.io            budgeted invocation io
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

  if (classified.class === "B") {
    // A lost lease is not success and not a failure: only the authoritative
    // state may back a completed verdict.
    if (verifyAuthoritative && remaining >= CLOSE_OUT_COST.verify) {
      const converged = await verifyAuthoritative();
      if (converged) return { outcome: "completed", taskId, code: verifiedCode, class: "B" };
    }
    return { outcome: "noop", taskId, code: "lease_lost", class: "B" };
  }

  if (classified.class === "D") {
    if (remaining < CLOSE_OUT_COST.park) {
      return { outcome: "failed", taskId, code: "budget_exhausted_no_closeout", class: "E" };
    }
    const parked = await parkNeedsAttention({ db: io.db, lease, now, code: classified.code });
    // Zero rows means our lease was taken over — we wrote nothing, so we must
    // not claim to have parked anything.
    if (!parked.rowsWritten) return { outcome: "noop", taskId, code: "lease_lost", class: "B" };
    return { outcome: "needs_attention", taskId, code: classified.code, class: "D" };
  }

  // C: a transient storage fault. Bounded retry, never an infinite defer.
  if (remaining < CLOSE_OUT_COST.fail) {
    return { outcome: "failed", taskId, code: "budget_exhausted_no_closeout", class: "E" };
  }
  const failure = await failTask({ db: io.db, lease, now, code: classified.code });
  if (!failure.rowsWritten) return { outcome: "noop", taskId, code: "lease_lost", class: "B" };
  return {
    outcome: failure.state === "needs_attention" ? "needs_attention" : "retry",
    taskId,
    code: "deferred_commit_failed",
    class: "C"
  };
}
