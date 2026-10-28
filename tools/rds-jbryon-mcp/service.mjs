// RDS-JBryon local service: durable Outbox + dependency gating + status.
//
// A write is acknowledged to the model only after SQLite committed it. A send
// happens outside any SQLite transaction. The D1 receipt moves the request to
// cloud_acknowledged, but a dependency is satisfied only by an authoritative
// applied/applied_noop effect read back from the cloud.
import { classifyDependency } from "../../services/rds-jbryon/src/merge.js";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function createRdsService({ outbox, client, clock = () => new Date().toISOString() }) {
  if (!outbox || typeof outbox.enqueue !== "function") throw new Error("invalid_outbox");
  if (!client || typeof client.submit !== "function") throw new Error("invalid_client");

  async function effectsFor(request) {
    const effects = new Map();
    for (const dependency of request.dependsOn ?? []) {
      try {
        const status = await client.status(dependency);
        effects.set(dependency, {
          effect: status?.effect ?? status?.data?.effect ?? null,
          workspaceEpoch: status?.workspaceEpoch ?? status?.data?.workspaceEpoch,
          targetDeleted: status?.targetDeleted === true || status?.data?.targetDeleted === true
        });
      } catch (error) {
        if (error.code === "request_not_found") {
          effects.set(dependency, null);
        } else {
          throw error;
        }
      }
    }
    return effects;
  }

  // One sender per service instance: every flush shares this chain, so a burst
  // of submits can never open two network sends at once.
  let chain = Promise.resolve();
  function serialized(action) {
    const run = chain.then(action, action);
    chain = run.then(() => {}, () => {});
    return run;
  }

  async function submit(request) {
    // Freeze first: a local commit failure must never look like "saved".
    const stored = outbox.enqueue(request);
    if (stored.duplicate || stored.state === "cloud_acknowledged" || stored.state === "delivery_blocked") {
      return { requestId: stored.requestId, local: stored.state, duplicate: stored.duplicate === true };
    }
    await serialized(() => flushInner({ only: stored.requestId })).catch(() => {});
    const current = outbox.get(stored.requestId);
    return { requestId: stored.requestId, local: current?.state ?? stored.state };
  }

  async function flush(options = {}) {
    return serialized(() => flushInner(options));
  }

  async function flushInner({ only = null, limit = 20 } = {}) {
    const summary = { sent: 0, waiting: 0, failed: 0 };
    const claimed = only
      ? [outbox.claimOne?.(only) ?? outbox.get(only)].filter(Boolean)
      : outbox.claimDue({ limit });
    for (const row of claimed) {
      if (!row || (row.state !== "local_pending" && row.state !== "sending")) continue;
      try {
        const request = row.request;
        if (request.dependsOn?.length) {
          const effects = await effectsFor(request);
          const lookupEffect = (id) => effects.get(id) ?? null;
          const decision = classifyDependency({
            request,
            lookupEffect,
            lookupRequest: () => null,
            epoch: request.workspaceEpoch
          });
          if (!decision.ready) {
            outbox.waitForDependency(row.requestId, decision.code);
            summary.waiting += 1;
            continue;
          }
        }
        const receipt = await client.submit(request);
        outbox.acknowledge(receipt);
        summary.sent += 1;
      } catch (error) {
        outbox.fail(row.requestId, error.code ?? "delivery_failed");
        summary.failed += 1;
      }
    }
    return summary;
  }

  async function status(requestId) {
    const local = outbox.get(requestId);
    if (!local) return { requestId, display: "not_found", local: "not_found" };
    let effect = local.effect;
    let targetDeleted = false;
    let detail = null;
    if (local.state === "cloud_acknowledged") {
      try {
        const remote = await client.status(requestId);
        effect = remote?.effect ?? remote?.data?.effect ?? effect;
        targetDeleted = remote?.targetDeleted === true || remote?.data?.targetDeleted === true;
        detail = remote?.reason ?? remote?.data?.reason ?? null;
        if (effect) outbox.observeEffect(requestId, effect);
      } catch (error) {
        if (error.code !== "request_not_found") effect = effect ?? "unavailable";
      }
    }
    const display = displayFor(local.state, effect, targetDeleted);
    return { requestId, local: local.state, effect, display, detail, displayName: "RDS-JBryon" };
  }

  /** Re-check waiting requests; requeue the ones whose dependencies are applied. */
  async function releaseReady() {
    let released = 0;
    for (const row of outbox.list({ limit: 200 })) {
      if (row.state !== "waiting_dependency") continue;
      try {
        const effects = await effectsFor(row.request);
        const decision = classifyDependency({
          request: row.request,
          lookupEffect: (id) => effects.get(id) ?? null,
          lookupRequest: () => null,
          epoch: row.request.workspaceEpoch
        });
        if (decision.ready) {
          outbox.releaseWaiting(row.requestId);
          released += 1;
        }
      } catch {
        // A status read failure keeps the request waiting; it is not a fault of
        // the request itself.
      }
    }
    return { released };
  }

  /**
   * Automatic recovery: while running, periodically re-check waiting
   * dependencies and retry due requests. Without this a transient network
   * failure would only recover on the next manual submit.
   */
  function startAutoSend({ intervalMs = 30_000 } = {}) {
    const timer = setInterval(async () => {
      try {
        await releaseReady();
        await flush();
      } catch {
        // Recovery is best-effort; the durable rows stay for the next round.
      }
    }, Math.max(1_000, Number(intervalMs) || 30_000));
    if (typeof timer.unref === "function") timer.unref();
    return () => clearInterval(timer);
  }

  async function query(operation, params = {}) {
    if (!isObject(params)) throw new Error("invalid_query_params");
    return client.read(operation, params);
  }

  async function admin(operation, params = {}) {
    if (operation !== "task.retry") throw new Error("unsupported_admin_operation");
    if (!isObject(params) || typeof params.taskId !== "string") throw new Error("invalid_admin_params");
    if (typeof client.admin !== "function") throw new Error("admin_transport_unavailable");
    return client.admin(operation, params);
  }

  return { submit, flush, status, releaseReady, query, admin, startAutoSend, close: () => outbox.close?.() };
}

export function displayFor(local, effect, targetDeleted) {
  if (local === "cancelled") return "cancelled";
  if (local === "delivery_blocked") return "delivery_blocked";
  if (local === "waiting_dependency") return "waiting_dependency";
  if (local !== "cloud_acknowledged") return local;
  if (targetDeleted) return "cancelled";
  if (effect === "applied" || effect === "applied_noop") return "projected";
  if (effect === "conflict") return "conflict";
  if (effect === "needs_attention") return "needs_attention";
  if (effect === "cancelled") return "cancelled";
  return "d1_committed";
}

/** The single `rds` tool: one entry point, operation-based dispatch. */
export function createToolHandler(service) {
  return async function handle(args) {
    if (!isObject(args)) return { ok: false, error: "invalid_arguments" };
    if (args.kind === "request") {
      if (!isObject(args.request)) return { ok: false, error: "invalid_request" };
      const result = await service.submit(args.request);
      return { ok: true, result };
    }
    if (args.kind === "query") {
      if (typeof args.operation !== "string") return { ok: false, error: "invalid_operation" };
      const result = await service.query(args.operation, args.params ?? {});
      return { ok: true, result };
    }
    if (args.kind === "admin") {
      if (typeof args.operation !== "string") return { ok: false, error: "invalid_admin_operation" };
      const result = await service.admin(args.operation, args.params ?? {});
      return { ok: true, result };
    }
    if (args.kind === "status") {
      if (typeof args.requestId !== "string") return { ok: false, error: "invalid_request_id" };
      return { ok: true, result: await service.status(args.requestId) };
    }
    return { ok: false, error: "unsupported_kind" };
  };
}
