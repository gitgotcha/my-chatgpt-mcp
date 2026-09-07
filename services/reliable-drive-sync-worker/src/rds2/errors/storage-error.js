// RDS V2 storage error translation layer (G2-F2).
//
// Neither binding exposes the guard name as `error.code`:
//
//   SQLite simulator : error.code === "ERR_SQLITE_ERROR",
//                      error.message IS the guard text, errcode 1811 (trigger)
//                      or 275 (CHECK).
//   Miniflare/workerd: error.code === null,
//                      the guard text sits in error.message AND
//                      error.cause.message, wrapped as
//                      "D1_ERROR: <text>: SQLITE_CONSTRAINT (extended: …)".
//
// So markers must be recovered from the text. Measured 1:1 mapping (plan
// §3.1.2) — with ONE violated condition per case, every case yields exactly
// one marker, identically on both bindings. Nothing here depends on trigger
// execution order.
//
// The layer keeps the SPECIFIC marker (markers are never merged into one
// class) and combines it with operation context to pick a class. It is the
// only place allowed to look at raw driver text: results carry closed-set
// tokens only, never the original message, SQL or bound parameters.

const TRIGGER_MARKERS = Object.freeze([
  "stale_task_write",
  "stale_projection_revision",
  "guard_requires_expected_revision",
  "cursor_regression",
  "build_requires_building_flag"
]);

// G2-R1: codes thrown by our OWN modules are closed-set and deterministic,
// contract or size errors. They must be class D (park with a stable reason),
// never the blind bounded retry: parking is what stops a doomed task from
// being re-claimed forever. The review reproduced all three named codes
// falling through to C/storage_error.
const INTERNAL_DETERMINISTIC_CODES = Object.freeze([
  "build_state_too_large",
  "build_read_limit_exceeded",
  "build_read_kind_rejected",
  "build_read_key_invalid",
  "build_continuation_invalid",
  "invalid_page_size",
  "changes_too_large",
  "commit_batch_too_large",
  // A reducer refusing an event type it cannot interpret is deterministic:
  // retrying only burns the backoff schedule before parking anyway.
  "unsupported_algorithm_event"
]);

function textOf(error) {
  if (!error || typeof error !== "object") return "";
  const parts = [error.message, error.errstr];
  if (error.cause && typeof error.cause === "object") parts.push(error.cause.message);
  return parts.filter((part) => typeof part === "string").join(" ");
}

// Markers are matched on word boundaries so a column or table name that merely
// contains a marker word (rds2_cursor_regression_audit) can never be mistaken
// for the guard itself.
function findMarker(text) {
  for (const marker of TRIGGER_MARKERS) {
    const pattern = new RegExp(`(?:^|[^A-Za-z0-9_])${marker}(?![A-Za-z0-9_])`);
    if (pattern.test(text)) return marker;
  }
  return null;
}

const CHECK_PATTERN = /CHECK constraint failed:\s*([A-Za-z_][A-Za-z0-9_]*)/;

/**
 * Recover the controlled marker from a raw storage error.
 * @returns {{kind: "trigger"|"check"|"none", marker: string|null, column: string|null}}
 */
export function extractStorageMarker(error) {
  const text = textOf(error);
  const check = CHECK_PATTERN.exec(text);
  if (check) return { kind: "check", marker: null, column: check[1] };
  const marker = findMarker(text);
  if (marker) return { kind: "trigger", marker, column: null };
  return { kind: "none", marker: null, column: null };
}

/**
 * Classify a storage error into one of the plan's classes.
 *
 *   A - budget exhaustion: a normal wait, never counted, never parked.
 *       (Stage entry is gated by the budget reserve; this class only fires
 *       when the ledger itself refused a consume mid-stage.)
 *   B - lease/CAS conflict: no real failure counted, but the caller must NOT
 *       report success without re-checking authoritative state.
 *   C - transient storage fault: bounded retry (count, backoff, park at 5).
 *   D - deterministic contract/size error: park with a stable reason, never
 *       deferred forever.
 *
 * @param {object}  options
 * @param {unknown} options.error
 * @param {object} [options.context]
 * @param {boolean} [options.context.buildStartCasFailed] whether the CAS that
 *        sets building=1 lost the race. Only then is
 *        `build_requires_building_flag` a race rather than a broken invariant.
 * @returns {{class: "A"|"B"|"C"|"D", code: string, marker: string|null, column: string|null}}
 */
export function classifyStorageError({ error, context = {} } = {}) {
  // Internal codes are the trusted signal and are checked FIRST: they are our
  // own closed-set vocabulary, while the surrounding message text may
  // legitimately quote guard names, table names or driver prefixes.
  const internalCode = error && typeof error === "object" && typeof error.code === "string"
    ? error.code
    : null;
  if (internalCode && INTERNAL_DETERMINISTIC_CODES.includes(internalCode)) {
    return { class: "D", code: internalCode, marker: null, column: null };
  }
  if (internalCode === "budget_exhausted") {
    return { class: "A", code: "budget_exhausted", marker: null, column: null };
  }

  const found = extractStorageMarker(error);

  if (found.kind === "trigger") {
    switch (found.marker) {
      case "stale_task_write":
      case "stale_projection_revision":
        return { class: "B", code: "lease_conflict", marker: found.marker, column: null };
      case "guard_requires_expected_revision":
        return { class: "D", code: "missing_expected_revision", marker: found.marker, column: null };
      case "cursor_regression":
        // A monotonicity invariant broke. Retrying cannot fix it.
        return { class: "D", code: "cursor_regression", marker: found.marker, column: null };
      case "build_requires_building_flag":
        // Conditional: a lost build-start CAS is a race; otherwise the flag was
        // never set and something is genuinely wrong.
        return context.buildStartCasFailed
          ? { class: "B", code: "build_start_race", marker: found.marker, column: null }
          : { class: "D", code: "build_requires_building_flag", marker: found.marker, column: null };
      default:
        return { class: "C", code: "storage_error", marker: found.marker, column: null };
    }
  }

  if (found.kind === "check") {
    // A size/shape CHECK is deterministic: deferring forever would hide it.
    return { class: "D", code: "storage_check_violation", marker: null, column: found.column };
  }

  // Default fallback: an unrecognised storage fault, retried a bounded number
  // of times. Never parked on the first occurrence, never deferred forever.
  return { class: "C", code: "storage_error", marker: null, column: null };
}
