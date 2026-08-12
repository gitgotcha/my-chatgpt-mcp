import type { DispatchRepository } from "./db.js";
import { QStashPublishError, type QStashPublisher } from "./qstash.js";

export type DispatcherEnvironment = {
  QSTASH_TOKEN?: string;
  QSTASH_URL?: string;
  SYNC_WORKER_URL?: string;
  QSTASH_FAILURE_CALLBACK_URL?: string;
};

function acknowledgedMessageId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const messageId = (value as { messageId?: unknown }).messageId;
  return typeof messageId === "string" && messageId.length > 0 ? messageId : null;
}

export class Dispatcher {
  constructor(
    private readonly repository: DispatchRepository,
    private readonly publisher: QStashPublisher,
    private readonly env: DispatcherEnvironment,
    private readonly clock: () => Date = () => new Date(),
    private readonly newLeaseOwner: () => string = () => crypto.randomUUID()
  ) {}

  async dispatch(jobId: string): Promise<void> {
    const now = this.clock();
    const leaseOwner = this.newLeaseOwner();
    const claimed = await this.repository.claimForDispatch(jobId, leaseOwner, now, new Date(now.getTime() + 5 * 60_000));
    if (!claimed) return;

    if (!this.env.QSTASH_TOKEN || !this.env.SYNC_WORKER_URL || !this.env.QSTASH_FAILURE_CALLBACK_URL) {
      await this.repository.recordDispatchFailure(jobId, leaseOwner, "qstash_config_missing", this.clock());
      return;
    }

    let acknowledgementReceived = false;
    let messageId: string | null = null;
    try {
      const acknowledgement = await this.publisher.publish({
        targetUrl: this.env.SYNC_WORKER_URL,
        failureCallbackUrl: this.env.QSTASH_FAILURE_CALLBACK_URL,
        job: { jobId: claimed.jobId, eventKey: claimed.eventKey, userId: claimed.userId }
      });
      messageId = acknowledgedMessageId(acknowledgement);
      if (!messageId) {
        await this.repository.recordDispatchFailure(jobId, leaseOwner, "qstash_invalid_ack", this.clock());
        return;
      }
      acknowledgementReceived = true;
      const persisted = await this.repository.markBrokerQueued(jobId, leaseOwner, messageId, this.clock());
      if (!persisted) await this.repository.markAcknowledgedUncertain(jobId, leaseOwner, messageId, this.clock());
    } catch (error) {
      if (acknowledgementReceived && messageId) {
        try {
          await this.repository.markAcknowledgedUncertain(jobId, leaseOwner, messageId, this.clock());
        } catch {
          // The durable dispatching claim remains the no-republish fence until reconciliation.
        }
        return;
      }
      const errorCode = error instanceof QStashPublishError
        ? `qstash_publish_http_${error.status}`
        : "qstash_publish_failed";
      await this.repository.recordDispatchFailure(jobId, leaseOwner, errorCode, this.clock());
    }
  }

  async dispatchPending(limit: number): Promise<void> {
    const jobs = await this.repository.listDispatchPending(Math.max(1, limit));
    await Promise.all(jobs.map((job) => this.dispatch(job.jobId)));
  }
}
