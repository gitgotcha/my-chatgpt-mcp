import { D1JobRepository, type D1Database, type DispatchRepository, type FailureRepository, type JobRepository, type SyncRepository } from "./db.js";
import { cachedProductionDriveAdapter, type DestinationAdapter } from "./drive-adapter.js";
import { createProductionArtifactAdapter } from "./drive-adapter.js";
import { D1ArtifactRepository } from "./artifact-jobs.js";
import { ArtifactDispatcher, createArtifactSyncHandler, type R2Bucket } from "./artifact-flow.js";
import { createFailureCallbackHandler, createSyncHandler, type SyncEnvironment } from "./sync.js";
import { Dispatcher, type DispatcherEnvironment } from "./dispatcher.js";
import { createIngressHandler, type WaitUntilContext, type WorkerEnvironment } from "./ingress.js";
import { createQStashPublisher, type QStashPublisher } from "./qstash.js";
import { Reconciler } from "./reconciler.js";

export type WorkerConfig = WorkerEnvironment & DispatcherEnvironment & SyncEnvironment & { QSTASH_FAILURE_CALLBACK_URL?: string; GOOGLE_DRIVE_ACCESS_TOKEN?: string; GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string; GOOGLE_REFRESH_TOKEN?: string; GOOGLE_SERVICE_ACCOUNT_EMAIL?: string; GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?: string; DRIVE_EVENTS_PARENT_ID?: string; DRIVE_SNAPSHOTS_PARENT_ID?: string; DRIVE_ARTIFACTS_PARENT_ID?: string; ARTIFACTS?: R2Bucket };

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
  publisher: QStashPublisher = createQStashPublisher(env.QSTASH_TOKEN ?? "", fetch, env.QSTASH_URL),
  cronBatchSize = 100,
  adapter?: DestinationAdapter
): WorkerShape {
  const jobRepository = repository ?? new D1JobRepository((env as Environment).DB);
  const artifactRepository = new D1ArtifactRepository((env as Environment).DB);
  const dispatcher = new Dispatcher(jobRepository, publisher, env);
  const artifactDispatcher = new ArtifactDispatcher(artifactRepository, publisher, env);
  const ingress = createIngressHandler(env, jobRepository, dispatcher, { repository: artifactRepository, bucket: env.ARTIFACTS, dispatcher: artifactDispatcher });
  const sync = createSyncHandler(env, jobRepository, adapter ?? cachedProductionDriveAdapter(env));
  const artifactSync = createArtifactSyncHandler(env, artifactRepository, env.ARTIFACTS, createProductionArtifactAdapter(env));
  const failure = createFailureCallbackHandler(env, jobRepository, () => new Date());
  const reconciler = new Reconciler(jobRepository, dispatcher, cronBatchSize);
  return {
    async fetch(request, _env, context) {
      if (request.method === "POST" && new URL(request.url).pathname === "/v1/sync") {
        try { const body = await request.clone().json() as { kind?: unknown }; return body.kind === "artifact" ? artifactSync(request) : sync(request); }
        catch { return sync(request); }
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
