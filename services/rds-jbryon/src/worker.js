// RDS-JBryon Worker entry: HTTP + Queue consumer + Cron dispatcher (design §4, §10).
//
// The HTTP surface never sends Queue messages: accept commits the event, the
// receipt and the task in one D1 batch. A separate dispatcher/cron claims due
// tasks, hands them to the Queue as `queued`, and the consumer takes a lease.
// If the Queue send is lost, the task row remains and the next cron run retries.
import { createRdsStore } from "./store.js";
import { createRdsHandler } from "./routes.js";
import { createProjectionQueue } from "./queue.js";

const json = (body, status) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" }
});

export function createWorker({ createStore = createRdsStore } = {}) {  function storeFor(env) {
    return createStore({ db: env.DB, epoch: env.RDS_WORKSPACE_EPOCH });
  }

  return {
    async fetch(request, env) {
      if (typeof env?.RDS_TOKEN !== "string" || !env.RDS_TOKEN.trim()) {
        return json({ error: { code: "service_not_configured" } }, 503);
      }
      return createRdsHandler({ store: storeFor(env), token: env.RDS_TOKEN }).handle(request);
    },

    /** Queue consumer: the message carries identity only; the lease decides. */
    async queue(batch, env) {
      const store = storeFor(env);
      const owner = `queue-${env?.RDS_INSTANCE_ID ?? "worker"}`;
      const queue = createProjectionQueue({ store, owner });
      const outcomes = [];
      for (const message of batch.messages) {
        try {
          const result = await queue.consume(message.body);
          outcomes.push(result);
          message.ack?.();
        } catch (error) {
          // Do not ack: a transient failure must be redelivered.
          message.retry?.();
          outcomes.push({ ok: false, code: error?.code ?? "consumer_failed" });
        }
      }
      return { processed: outcomes.length, outcomes };
    },

    /** Cron: reclaim expired leases and push due tasks to the Queue. */
    async scheduled(controller, env) {
      const store = storeFor(env);
      const dispatcher = createProjectionQueue({ store, owner: `cron-${env?.RDS_INSTANCE_ID ?? "worker"}` });
      const messages = await dispatcher.dispatchDue({ limit: Number(env?.RDS_DISPATCH_LIMIT) || 20 });
      const sent = [];
      for (const message of messages) {
        try {
          await env.QUEUE.send(message);
          sent.push(message.taskId);
        } catch (error) {
          // Queue.send can fail after the task was staged. Release only this
          // exact queued epoch; if a consumer already claimed it, the update
          // is a no-op and that consumer retains its lease.
          const code = error?.code ?? "queue_send_failed";
          const released = await store.releaseQueuedTask?.({
            taskId: message.taskId,
            epoch: message.attempt,
            error: code
          });
          sent.push({ taskId: message.taskId, error: code, released: released?.released ?? false });
        }
      }
      return { dispatched: messages.length, sent };
    }
  };
}

// The shipped module's own entry (`scriptPath` deploy target). Tests that build
// a worker through createWorker keep using the factory.
export default createWorker();
