import { D1JobRepository, type D1Database, type DispatchRepository, type JobRepository } from "./db.js";
import { Dispatcher, type DispatcherEnvironment } from "./dispatcher.js";
import { createIngressHandler, type WaitUntilContext, type WorkerEnvironment } from "./ingress.js";
import { createQStashPublisher, type QStashPublisher } from "./qstash.js";

export type WorkerConfig = WorkerEnvironment & DispatcherEnvironment;

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
  repository?: JobRepository & DispatchRepository,
  publisher: QStashPublisher = createQStashPublisher(env.QSTASH_TOKEN ?? ""),
  cronBatchSize = 100
): WorkerShape {
  const jobRepository = repository ?? new D1JobRepository((env as Environment).DB);
  const dispatcher = new Dispatcher(jobRepository, publisher, env);
  const ingress = createIngressHandler(env, jobRepository, dispatcher);
  return {
    fetch(request, _env, context) {
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
