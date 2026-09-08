import { dispatchSubmitEvent } from "./submit-event.js";
import { D1JobRepository } from "./job-repository.js";
import { createIngressHandler } from "./ingress.js";
import { createQStashPublisher } from "./qstash.js";
import { Dispatcher } from "./dispatcher.js";
import { createFailureCallbackHandler, createSyncHandler } from "./sync.js";
import { Reconciler } from "./reconciler.js";
import { createDriveRepository } from "./google-drive.js";
import { createStorageLayout } from "./storage-layout.js";
import { createUserStore } from "./user-store.js";
import { handleV2Request, handleV2Write, handleV2Init, handleV2Queue, handleV2Scheduled } from "./rds2/routes.js";

export const V2_RECOVERY_CRON = "2-57/5 * * * *";

function featureEnabled(runtimeEnv, name) {
  // Configuration is deliberately string based: missing values and every
  // spelling other than the literal "true" are disabled.
  return runtimeEnv?.[name] === "true";
}

// V1 remains enabled by default for backwards compatibility. The release
// switch is intentionally opt-out: only the exact literal "false" closes the
// two legacy write entry points, while reads and callback/recovery surfaces
// remain available to drain already-accepted work.
function v1WriteEnabled(runtimeEnv) {
  return runtimeEnv?.V1_WRITE_ENABLED !== "false";
}

function v1WriteDisabledResponse() {
  return Response.json({ error: "v1_write_disabled" }, { status: 410 });
}

export function createWorker(env, deps = {}) {
  const repository = deps.repository ?? new D1JobRepository(env.DB);
  const publisher = deps.publisher ?? createQStashPublisher(
    env.QSTASH_TOKEN ?? "",
    fetch,
    env.QSTASH_URL
  );
  const dispatcher = new Dispatcher(repository, publisher, env);
  let readServices;
  const services = () => {
    if (!readServices) {
      const drive = deps.drive ?? createDriveRepository(env, deps.submitEventDeps ?? {});
      const layout = deps.layout ?? createStorageLayout({ drive });
      const userStore = deps.userStore ?? createUserStore({ layout, drive });
      readServices = { drive, layout, userStore };
    }
    return readServices;
  };
  const identityLookup = deps.identityLookup
    ?? ((username) => services().userStore.findByDisplayName(username));
  const query = deps.query ?? ((envelope) => {
    if (envelope.eventType === "system.capabilities.read") {
      return dispatchSubmitEvent(env, envelope, deps.submitEventDeps ?? {});
    }
    const runtime = services();
    return dispatchSubmitEvent(env, envelope, {
      ...(deps.submitEventDeps ?? {}),
      drive: runtime.drive,
      layout: runtime.layout,
      userStore: runtime.userStore
    });
  });
  const ingress = createIngressHandler(env, repository, dispatcher, { identityLookup, query });
  const deliver = deps.dispatchSubmitEvent
    ?? ((envelope) => dispatchSubmitEvent(env, envelope, deps.submitEventDeps ?? {}));
  const sync = createSyncHandler(env, repository, deliver);
  const failure = createFailureCallbackHandler(env, repository);
  const reconciler = new Reconciler(repository, dispatcher);

  return {
    async fetch(request, runtimeEnv, context) {
      const path = new URL(request.url).pathname;
      const activeEnv = runtimeEnv ?? env;
      if (request.method === "POST" && path === "/v1/sync") {
        if (!v1WriteEnabled(activeEnv)) return v1WriteDisabledResponse();
        return sync(request);
      }
      if (request.method === "POST" && path === "/v1/qstash/failure") return failure(request);
      // V2 read surface: a separate DTO and route, the V1 routes above stay
      // exactly as they are.
      if (request.method === "POST" && path === "/v2/query") {
        return handleV2Request(request, runtimeEnv ?? env, context);
      }
      // V2 write surface: the durable receipt endpoint the local outbox
      // delivers to.
      if (request.method === "POST" && path === "/v2/events") {
        return handleV2Write(request, runtimeEnv ?? env, context);
      }
      if (request.method === "POST" && path === "/v2/users/init") {
        return handleV2Init(request, runtimeEnv ?? env, context);
      }
      if (request.method === "POST" && path === "/v1/jobs"
        && !v1WriteEnabled(activeEnv)) {
        return v1WriteDisabledResponse();
      }
      return ingress(request, context);
    },
    async queue(batch, runtimeEnv, context) {
      return handleV2Queue(batch, runtimeEnv ?? env, context);
    },
    scheduled(controller, _runtimeEnv, context) {
      const runtimeEnv = _runtimeEnv ?? env;
      // The V2 recovery wake on its own reserved cron expression.
      if (controller?.cron === V2_RECOVERY_CRON) {
        const work = featureEnabled(runtimeEnv, "RDS2_RECOVERY_ENABLED")
          ? handleV2Scheduled(controller, runtimeEnv, context)
          : Promise.resolve({ outcome: "disabled", code: "recovery_disabled" });
        context.waitUntil(work);
        return;
      }
      const work = controller?.cron === "0 * * * *"
        ? reconciler.runHourly()
        : controller?.cron === "0 */6 * * *"
          ? reconciler.runSixHourly()
          : reconciler.runFiveMinute();
      context.waitUntil(work);
    }
  };
}

export default {
  fetch(request, env, context) {
    return createWorker(env).fetch(request, env, context);
  },
  // The production runtime reads THIS export for queue consumption — without
  // it no queue message would ever reach the consumers.
  queue(batch, env, context) {
    return createWorker(env).queue(batch, env, context);
  },
  scheduled(controller, env, context) {
    return createWorker(env).scheduled(controller, env, context);
  }
};
