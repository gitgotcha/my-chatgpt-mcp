// Single per-invocation budget ledger (Rev 6 addendum §9). Every entry point
// creates exactly one budget; D1 executions, Queue sends and HTTP fetches are
// counted by the io wrappers in invocation-io.js, always before the outbound
// call is issued, so a rejected call causes zero side effects. Failed calls
// still count because the consume happened first.

export const BUDGET_CATEGORIES = new Set(["d1", "queue", "http"]);

// Business total per invocation. The product hard boundary is 50; the business
// cap is intentionally lower so failure bookkeeping stays inside 50 even when
// an entry spends its whole quota. Entry-specific quotas (write 20, query 12,
// projection 24, archive 16, recovery 32, dlq 8) are passed as `limit` by the
// entry points and must never exceed this value.
export const BUSINESS_SUBREQUEST_CAP = 40;
export const PRODUCT_HARD_CAP = 50;

// Sub-requests a failure close-out may still need (failTask reads then writes,
// an authoritative re-check reads twice). A stage is only entered when its own
// worst case PLUS this reserve still fits — checking the balance once at the
// entry does not reserve anything, because later stages would spend it.
export const CLOSE_OUT_RESERVE = 4;

/**
 * Can this stage start and still leave room to book a failure?
 * Always evaluated against the SAME per-invocation budget; budgets are never
 * reset to work around a gate.
 */
export function canAffordStage(budget, stageCost, reserve = CLOSE_OUT_RESERVE) {
  if (!budget || typeof budget.remaining !== "function") return true;
  return budget.remaining() >= stageCost + reserve;
}

export function createBudget(limit) {
  // The business cap of 40 is a fixed design boundary of this version: no
  // entry point may configure a budget beyond it, whatever the platform
  // allows. The product hard boundary of 50 stays as the absolute ceiling
  // that entry quotas (all <= 40) and traces are additionally checked against.
  if (!Number.isInteger(limit) || limit < 1 || limit > BUSINESS_SUBREQUEST_CAP) {
    throw new Error("invalid_budget_limit");
  }
  let used = 0;
  const entries = [];
  return {
    consume(category, count = 1) {
      if (!BUDGET_CATEGORIES.has(category)) throw new Error("unknown_budget_category");
      if (!Number.isInteger(count) || count < 1) throw new Error("invalid_budget_count");
      if (used + count > limit) {
        const error = new Error("budget_exhausted");
        error.code = "budget_exhausted";
        error.budget = { limit, used, requested: count, category };
        throw error;
      }
      used += count;
      entries.push({ category, index: used - count + 1, count });
    },
    remaining: () => limit - used,
    snapshot: () => ({
      limit,
      used,
      remaining: limit - used,
      entries: entries.map((entry) => ({ ...entry }))
    })
  };
}
