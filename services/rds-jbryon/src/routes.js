// RDS-JBryon HTTP surface (design §7).
//
// One endpoint, no accounts: the service credential authenticates the single
// owner. Reads never enter the Outbox; a write returns a D1 receipt whose effect
// is still pending. Every error is a stable code the client can explain.
import { API_VERSION, PROTOCOL, RdsError } from "./contracts.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" }
});

function bearer(request) {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

const READ_DISPATCH = {
  "capabilities": (store) => store.capabilities(),
  "directory.list": (store, params) => store.listDirectory(params),
  "directory.resolve": (store, params) => store.resolvePath(params.path ?? []),
  "snapshot.read": (store, params) => store.readSnapshot(params),
  "snapshot.query": (store, params) => store.querySnapshots(params),
  "snapshot.history": (store, params) => store.snapshotHistory(params),
  "request.status": (store, params) => store.requestStatus(params.requestId),
  "conflict.list": (store, params) => store.listConflicts(params),
  "task.status": (store, params) => store.taskStatus(params.taskId),
  "deletion.manifest": (store, params) => store.deletionManifest(params)
};

/**
 * `store` is the object returned by createRdsStore (or a test double with the
 * same methods). `token` is required: without a valid credential nothing is
 * read or written, which is the "connection failure has no write" boundary.
 */
export function createRdsHandler({ store, token }) {
  if (!store || typeof store.accept !== "function") throw new RdsError("invalid_store");
  if (typeof token !== "string" || !token.trim()) throw new RdsError("invalid_token");

  async function handle(request) {
    if (request.method !== "POST") return json({ error: { code: "method_not_allowed" } }, 405);
    if (bearer(request) !== token) return json({ error: { code: "unauthorized" } }, 401);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: { code: "invalid_json" } }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: { code: "invalid_body" } }, 400);
    }
    if (body.protocol !== PROTOCOL || body.apiVersion !== API_VERSION) {
      return json({ error: { code: "unsupported_protocol" } }, 409);
    }

    try {
      if (body.kind === "request") {
        const receipt = await store.accept(body.request);
        return json(receipt, 202);
      }
      if (body.kind === "query") {
        const dispatch = READ_DISPATCH[body.operation];
        if (!dispatch) return json({ error: { code: "unsupported_operation" } }, 400);
        const params = body.params ?? {};
        if (!params || typeof params !== "object" || Array.isArray(params)) {
          return json({ error: { code: "invalid_query_params" } }, 400);
        }
        const result = await dispatch(store, params);
        return json(result);
      }
      if (body.kind === "admin") {
        if (body.operation !== "task.retry" || typeof store.retryTask !== "function") {
          return json({ error: { code: "unsupported_admin_operation" } }, 400);
        }
        const params = body.params ?? {};
        if (!params || typeof params !== "object" || Array.isArray(params)) {
          return json({ error: { code: "invalid_admin_params" } }, 400);
        }
        return json(await store.retryTask(params));
      }
      return json({ error: { code: "unsupported_kind" } }, 400);
    } catch (error) {
      const code = error?.code ?? "internal_error";
      const status = error?.status ?? (code === "unauthorized" ? 401 : code.endsWith("_not_found") ? 404 : 409);
      if (!(error instanceof RdsError) && code === "internal_error") {
        return json({ error: { code } }, 500);
      }
      return json({ error: { code } }, status);
    }
  }

  return { handle };
}

/** Worker entry: binds D1 + the single service token from the environment. */
export function createRdsWorker({ createStore }) {
  return {
    async fetch(request, env) {
      if (typeof env?.RDS_TOKEN !== "string" || !env.RDS_TOKEN.trim()) {
        return json({ error: { code: "service_not_configured" } }, 503);
      }
      const store = createStore({ db: env.DB, epoch: env.RDS_WORKSPACE_EPOCH });
      return createRdsHandler({ store, token: env.RDS_TOKEN }).handle(request);
    }
  };
}
