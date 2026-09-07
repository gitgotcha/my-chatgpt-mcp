// G2-F1: bounded reads of the staging generation.
//
// The build reducer must never carry the accumulated per-topic / per-problem
// state in its continuation — that dictionary grows with the whole history and
// wedges the scope on the 64 KiB continuation_json CHECK. The state already
// lives in the staging generation as keyed rows; the reducer only needs the
// keys this page touches, read back through bounded point lookups.
//
// The reducer DECLARES what it needs (pure, no IO). The ENGINE validates the
// plan, dedupes it, computes its total cost BEFORE issuing a single query, and
// enforces a hard cap. A reducer can therefore never burn the budget by
// calling a read interface repeatedly.
import { canAffordStage } from "../io/budget.js";

export const STAGING_READ_MAX_CALLS = 4;
export const STAGING_READ_CHUNK = 32;

const ALLOWED_ROW_KINDS = new Set(["topic", "problem"]);

function fail(code, detail) {
  const error = new Error(code);
  error.code = code;
  if (detail) error.detail = detail;
  return error;
}

/**
 * Normalize a declared read plan into ONE canonical read per rowKind with a
 * deduplicated key list, validating row kinds and keys along the way.
 * Both the pricing and the actual execution consume THIS result, so scattered
 * declarations of the same rowKind merge into a single deduplicated read and
 * can never pay or query the same keys twice.
 */
function normalizeReadPlan(plan) {
  const merged = new Map();
  for (const read of plan?.reads ?? []) {
    if (!ALLOWED_ROW_KINDS.has(read?.rowKind)) {
      throw fail("build_read_kind_rejected", String(read?.rowKind));
    }
    const keys = read.rowKeys ?? [];
    if (keys.some((key) => typeof key !== "string" || !key.length)) {
      throw fail("build_read_key_invalid");
    }
    if (!merged.has(read.rowKind)) merged.set(read.rowKind, new Set());
    for (const key of keys) merged.get(read.rowKind).add(key);
  }
  const reads = [];
  let cost = 0;
  for (const [rowKind, keys] of merged) {
    if (!keys.size) continue;
    cost += Math.ceil(keys.size / STAGING_READ_CHUNK);
    reads.push({ rowKind, keys: [...keys] });
  }
  return { reads, cost };
}

/**
 * Cost of a read plan in sub-requests, computed WITHOUT issuing any query.
 * Same-kind declarations merge first; otherwise each rowKind costs one query
 * per chunk of its deduplicated keys.
 */
export function planReadCost(plan) {
  return normalizeReadPlan(plan).cost;
}

/**
 * Execute a declared read plan against the staging generation.
 * Every query binds all four scope segments plus the generation, so another
 * user's row — or another generation's row — can never be read back.
 *
 * @returns {Promise<{topic: Map<string, object>, problem: Map<string, object>}>}
 */
export async function readStagedWithinBudget({
  io,
  scope,
  stagingGeneration,
  plan,
  maxCalls = STAGING_READ_MAX_CALLS
}) {
  const result = { topic: new Map(), problem: new Map() };

  // Validate, merge, dedupe and price the WHOLE plan BEFORE any query goes
  // out: discovering on the fourth call that a fifth is needed is not
  // acceptable, and two declarations of the same rowKind must never pay or
  // query twice. The queries below run against the SAME normalized result the
  // price was computed from.
  const { reads, cost } = normalizeReadPlan(plan);
  if (!reads.length) return result;
  if (cost > maxCalls) throw fail("build_read_limit_exceeded", { cost, maxCalls });
  if (!canAffordStage(io.budget, cost)) throw fail("budget_reserve_insufficient", { cost });

  for (const read of reads) {
    const keys = read.keys;
    const bucket = result[read.rowKind];
    for (let offset = 0; offset < keys.length; offset += STAGING_READ_CHUNK) {
      const chunk = keys.slice(offset, offset + STAGING_READ_CHUNK);
      const placeholders = chunk.map(() => "?").join(", ");
      const statement = io.db.prepare(
        `SELECT row_key, value_json FROM rds2_projection_rows
         WHERE user_id = ? AND namespace = ? AND projection_name = ?
           AND generation = ? AND row_kind = ? AND row_key IN (${placeholders})`
      ).bind(
        scope.userId, scope.namespace, scope.projectionName,
        stagingGeneration, read.rowKind, ...chunk
      );
      const page = await statement.all();
      for (const row of page.results ?? []) {
        bucket.set(row.row_key, JSON.parse(row.value_json));
      }
    }
  }
  return result;
}
