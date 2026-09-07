// Budgeted IO wrappers (Rev 6 plan T02). Everything an invocation can emit —
// D1 statements/batches, Queue sends, HTTP fetches (including OAuth token
// calls) — goes through these wrappers so the single budget sees every
// outbound call before it happens. Business modules must never touch env.DB
// or global fetch directly.
import { createBudget } from "./budget.js";

export const MAX_D1_STATEMENTS_PER_BATCH = 32;

export function wrapD1(nativeDb, budget) {
  // The statement registry must be per-db-instance: statements prepared on one
  // wrapped database must never be accepted by another one's batch.
  const nativeOf = new WeakMap();
  function wrap(native) {
    const statement = {
      bind: (...values) => wrap(native.bind(...values)),
      first: async (...args) => {
        budget.consume("d1");
        return native.first(...args);
      },
      all: async (...args) => {
        budget.consume("d1");
        return native.all(...args);
      },
      run: async () => {
        budget.consume("d1");
        return native.run();
      }
    };
    nativeOf.set(statement, native);
    return Object.freeze(statement);
  }
  return Object.freeze({
    prepare: (sql) => wrap(nativeDb.prepare(sql)),
    batch: async (statements) => {
      if (!Array.isArray(statements) || !statements.length || statements.length > MAX_D1_STATEMENTS_PER_BATCH) {
        throw new Error("invalid_batch_size");
      }
      const raw = statements.map((statement) => {
        if (!nativeOf.has(statement)) throw new Error("foreign_statement");
        return nativeOf.get(statement);
      });
      // A D1 batch is conservatively accounted as one I/O round trip, while
      // MAX_D1_STATEMENTS_PER_BATCH bounds the SQL work inside it.
      budget.consume("d1");
      return nativeDb.batch(raw);
    }
  });
}

export function wrapQueue(nativeQueue, budget) {
  return Object.freeze({
    send: async (message) => {
      budget.consume("queue");
      return nativeQueue.send(message);
    },
    sendBatch: async (messages) => {
      budget.consume("queue", messages.length);
      return nativeQueue.sendBatch(messages);
    }
  });
}

export function wrapFetch(fetchImpl, budget) {
  return async (input, init = {}) => {
    budget.consume("http");
    // Redirects are never followed automatically: a redirect would be an
    // unbudgeted extra request and could carry credentials across origins.
    const response = await fetchImpl(input, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const error = new Error("http_redirect_rejected");
      error.code = "http_redirect_rejected";
      error.status = response.status;
      throw error;
    }
    return response;
  };
}

// `log` is the optional structured-logger sink (a (line: string) => void).
// Close-outs emit exactly one sanitized line per SUCCESSFUL persisted
// transition; the sink stays out of the budget (logging is not an outbound
// sub-request). Production entry points pass their real logger; tests pass a
// collector. Unset means logging is skipped, never thrown.
export function createInvocationIo({ db, queues = {}, fetchImpl, limit, log = null }) {
  if (!db) throw new Error("missing_db_binding");
  const budget = createBudget(limit);
  return Object.freeze({
    budget,
    log,
    db: wrapD1(db, budget),
    queues: Object.freeze(Object.fromEntries(
      Object.entries(queues).map(([name, queue]) => [name, wrapQueue(queue, budget)])
    )),
    fetch: wrapFetch(fetchImpl ?? ((...args) => globalThis.fetch(...args)), budget)
  });
}
