import type { DispatchRepository } from "./db.js";
import type { QStashPublisher } from "./qstash.js";

export type DispatcherEnvironment = {
  QSTASH_TOKEN?: string;
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

    try {
      const acknowledgement = await this.publisher.publish({
        targetUrl: this.env.SYNC_WORKER_URL,
        failureCallbackUrl: this.env.QSTASH_FAILURE_CALLBACK_URL,
        job: { jobId: claimed.jobId, eventKey: claimed.eventKey, userId: claimed.userId }
      });
      const messageId = acknowledgedMessageId(acknowledgement);
      if (!messageId) {
        await this.repository.recordDispatchFailure(jobId, leaseOwner, "qstash_invalid_ack", this.clock());
        return;
      }
      await this.repository.markBrokerQueued(jobId, leaseOwner, messageId, this.clock());
    } catch {
      await this.repository.recordDispatchFailure(jobId, leaseOwner, "qstash_publish_failed", this.clock());
    }
  }

  async dispatchPending(limit: number): Promise<void> {
    const jobs = await this.repository.listDispatchPending(Math.max(1, limit));
    await Promise.all(jobs.map((job) => this.dispatch(job.jobId)));
  }
}
