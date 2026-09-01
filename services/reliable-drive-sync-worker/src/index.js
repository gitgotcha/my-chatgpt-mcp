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
    async fetch(request, _runtimeEnv, context) {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/v1/sync") return sync(request);
      if (request.method === "POST" && path === "/v1/qstash/failure") return failure(request);
      return ingress(request, context);
    },
    scheduled(controller, _runtimeEnv, context) {
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
  scheduled(controller, env, context) {
    return createWorker(env).scheduled(controller, env, context);
  }
};
