import { QStashPublishError } from "./qstash.js";

export { QStashPublishError } from "./qstash.js";

function messageIdOf(value) {
  const messageId = value && typeof value === "object" ? value.messageId : null;
  return typeof messageId === "string" && messageId ? messageId : null;
}

export class Dispatcher {
  constructor(
    repository,
    publisher,
    env,
    clock = () => new Date(),
    newLeaseOwner = () => crypto.randomUUID()
  ) {
    this.repository = repository;
    this.publisher = publisher;
    this.env = env;
    this.clock = clock;
    this.newLeaseOwner = newLeaseOwner;
  }

  async dispatch(jobId) {
    const now = this.clock();
    const leaseOwner = this.newLeaseOwner();
    const claimed = await this.repository.claimForDispatch(
      jobId,
      leaseOwner,
      now,
      new Date(now.getTime() + 5 * 60_000)
    );
    if (!claimed) return;

    if (!this.env.QSTASH_TOKEN || !this.env.SYNC_WORKER_URL || !this.env.QSTASH_FAILURE_CALLBACK_URL) {
      await this.repository.recordDispatchFailure(jobId, leaseOwner, "qstash_config_missing", this.clock());
      return;
    }

    try {
      const acknowledgement = await this.publisher.publish({
        targetUrl: this.env.SYNC_WORKER_URL,
        failureCallbackUrl: this.env.QSTASH_FAILURE_CALLBACK_URL,
        job: {
          jobId: claimed.jobId,
          requestId: claimed.requestId,
          userId: claimed.userId
        }
      });
      const messageId = messageIdOf(acknowledgement);
      if (!messageId) {
        await this.repository.recordDispatchFailure(jobId, leaseOwner, "qstash_invalid_ack", this.clock());
        return;
      }
      const persisted = await this.repository.markBrokerQueued(jobId, leaseOwner, messageId, this.clock());
      if (!persisted) {
        await this.repository.recordDispatchFailure(jobId, leaseOwner, "qstash_ack_persist_failed", this.clock());
      }
    } catch (cause) {
      const code = cause instanceof QStashPublishError
        ? `qstash_publish_http_${cause.status}`
        : "qstash_publish_failed";
      await this.repository.recordDispatchFailure(jobId, leaseOwner, code, this.clock());
    }
  }

  async dispatchPending(limit = 100) {
    const jobs = await this.repository.listDispatchPending(Math.max(1, limit));
    await Promise.all(jobs.map((job) => this.dispatch(job.jobId)));
  }
}
