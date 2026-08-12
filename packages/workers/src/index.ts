import { D1JobRepository, type D1Database, type DispatchRepository, type JobRepository, type SyncRepository } from "./db.js";
import type { DestinationAdapter } from "./drive-adapter.js";
import { createSyncHandler, type SyncEnvironment } from "./sync.js";
import { Dispatcher, type DispatcherEnvironment } from "./dispatcher.js";
import { createIngressHandler, type WaitUntilContext, type WorkerEnvironment } from "./ingress.js";
import { createQStashPublisher, type QStashPublisher } from "./qstash.js";

export type WorkerConfig = WorkerEnvironment & DispatcherEnvironment & SyncEnvironment;

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
  repository?: JobRepository & DispatchRepository & SyncRepository,
  publisher: QStashPublisher = createQStashPublisher(env.QSTASH_TOKEN ?? ""),
  cronBatchSize = 100,
  adapter?: DestinationAdapter
): WorkerShape {
  const jobRepository = repository ?? new D1JobRepository((env as Environment).DB);
  const dispatcher = new Dispatcher(jobRepository, publisher, env);
  const ingress = createIngressHandler(env, jobRepository, dispatcher);
  const sync = adapter ? createSyncHandler(env, jobRepository, adapter) : undefined;
  return {
    fetch(request, _env, context) {
      if (request.method === "POST" && new URL(request.url).pathname === "/v1/sync") {
        return sync ? sync(request) : Promise.resolve(new Response(null, { status: 503 }));
      }
      return ingress(request, context);
    },
    scheduled(_controller, _env, context) {
      context.waitUntil(dispatcher.dispatchPending(cronBatchSize));
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
