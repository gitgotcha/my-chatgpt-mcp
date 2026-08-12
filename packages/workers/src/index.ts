import { D1JobRepository, type D1Database, type DispatchRepository, type FailureRepository, type JobRepository, type SyncRepository } from "./db.js";
import { cachedProductionDriveAdapter, type DestinationAdapter } from "./drive-adapter.js";
import { createFailureCallbackHandler, createSyncHandler, type SyncEnvironment } from "./sync.js";
import { Dispatcher, type DispatcherEnvironment } from "./dispatcher.js";
import { createIngressHandler, type WaitUntilContext, type WorkerEnvironment } from "./ingress.js";
import { createQStashPublisher, type QStashPublisher } from "./qstash.js";
import { Reconciler } from "./reconciler.js";

export type WorkerConfig = WorkerEnvironment & DispatcherEnvironment & SyncEnvironment & { QSTASH_FAILURE_CALLBACK_URL?: string; GOOGLE_DRIVE_ACCESS_TOKEN?: string; GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string; GOOGLE_REFRESH_TOKEN?: string; DRIVE_EVENTS_PARENT_ID?: string; DRIVE_SNAPSHOTS_PARENT_ID?: string };

export interface Environment extends WorkerConfig {
  DB: D1Database;
}

type ScheduledContext = WaitUntilContext;
type WorkerShape = {
  fetch(request: Request, env: Environment, context: WaitUntilContext): Promise<Response>;
  scheduled(controller: unknown, env: Environment, context: ScheduledContext): void;
};

/** Injectable factory keeps the runtime binding thin and makes Cron behavior deterministic in tests. */
export function createWorker(
  env: WorkerConfig,
  repository?: JobRepository & DispatchRepository & SyncRepository & FailureRepository,
  publisher: QStashPublisher = createQStashPublisher(env.QSTASH_TOKEN ?? ""),
  cronBatchSize = 100,
  adapter?: DestinationAdapter
): WorkerShape {
  const jobRepository = repository ?? new D1JobRepository((env as Environment).DB);
  const dispatcher = new Dispatcher(jobRepository, publisher, env);
  const ingress = createIngressHandler(env, jobRepository, dispatcher);
  const sync = createSyncHandler(env, jobRepository, adapter ?? cachedProductionDriveAdapter(env));
  const failure = createFailureCallbackHandler(env, jobRepository, () => new Date());
  const reconciler = new Reconciler(jobRepository, dispatcher, cronBatchSize);
  return {
    fetch(request, _env, context) {
      if (request.method === "POST" && new URL(request.url).pathname === "/v1/sync") {
        return sync(request);
      }
      if (request.method === "POST" && new URL(request.url).pathname === "/v1/qstash/failure") return failure(request);
      return ingress(request, context);
    },
    scheduled(controller, _env, context) {
      const cron = controller as { cron?: string };
      const work = cron.cron === "0 * * * *" ? reconciler.runHourly() : cron.cron === "0 */6 * * *" ? reconciler.runSixHourly() : reconciler.runFiveMinute();
      context.waitUntil(work);
    }
  };
}

export default {
  fetch(request: Request, env: Environment, context: WaitUntilContext): Promise<Response> {
    return createWorker(env).fetch(request, env, context);
  },
  scheduled(controller: unknown, env: Environment, context: ScheduledContext): void {
    createWorker(env).scheduled(controller, env, context);
  }
} satisfies WorkerShape;
