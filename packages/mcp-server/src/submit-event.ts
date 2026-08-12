import { parseSyncEvent, type SyncEvent } from "@reliable-drive-sync/protocol/event";
import type { NoticeClient, SyncNotice } from "./notice-client.js";
import { DisabledNoticeClient } from "./notice-client.js";
import type { LocalOutbox, OutboxRecord } from "./outbox.js";

export type IngressResponse = { status: number; body: unknown };
export interface IngressTransport {
  send(event: SyncEvent, signal: AbortSignal): Promise<IngressResponse>;
}

export type DeliveryAttempt<T> =
  | { completed: true; value: T }
  | { completed: false };

export interface DeliveryDeadline {
  createBudget(): DeliveryBudget;
}

export interface DeliveryBudget {
  readonly expired: boolean;
  run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<DeliveryAttempt<T>>;
}

export type LocalSubmitResult = {
  accepted: boolean;
  eventKey: string;
  deliveryState: "cloud_accepted" | "pending";
  notices: SyncNotice[];
};

export class SubmitEventService {
  constructor(
    private readonly outbox: LocalOutbox,
    private readonly transport: IngressTransport,
    private readonly noticeClient: NoticeClient = new DisabledNoticeClient(),
    private readonly maxFlushEvents = 20,
    private readonly deadline: DeliveryDeadline = timeoutAfter(2_000)
  ) {}

  async submit(input: unknown): Promise<LocalSubmitResult> {
    const event = parseSyncEvent(input);
    this.outbox.enqueue(event);

    const pendingBeforeCurrent = this.outbox.listPending()
      .filter((record) => record.eventKey !== event.eventKey)
      .slice(0, this.maxFlushEvents);
    const preflushBudget = this.deadline.createBudget();
    for (const record of pendingBeforeCurrent) {
      if (preflushBudget.expired) break;
      await this.deliver(record, preflushBudget);
    }

    const accepted = await this.deliverByKey(event.eventKey, this.deadline.createBudget());
    // A notice is advisory only: failure to read it can never revoke durable ingress acceptance.
    const notices = accepted ? await this.readNotices(event.userId) : [];
    return {
      accepted,
      eventKey: event.eventKey,
      deliveryState: accepted ? "cloud_accepted" : "pending",
      notices
    };
  }

  private async readNotices(userId: string): Promise<SyncNotice[]> {
    try { return await this.noticeClient.listNotices(userId); }
    catch { return []; }
  }

  async flushPending(limit = this.maxFlushEvents): Promise<void> {
    const budget = this.deadline.createBudget();
    for (const record of this.outbox.listPending().slice(0, limit)) {
      if (budget.expired) break;
      await this.deliver(record, budget);
    }
  }

  private async deliverByKey(eventKey: string, budget: DeliveryBudget): Promise<boolean> {
    const record = this.outbox.listPending().find((item) => item.eventKey === eventKey);
    return record ? this.deliver(record, budget) : false;
  }

  private async deliver(record: OutboxRecord, budget: DeliveryBudget): Promise<boolean> {
    this.outbox.markSending(record.eventKey);
    try {
      const attempt = await budget.run((signal) => this.transport.send(record.event, signal));
      if (!attempt.completed) {
        this.outbox.markPending(record.eventKey, "ingress_timeout");
        return false;
      }
      const response = attempt.value;
      const jobId = readAcceptedJobId(response);
      if (jobId) return this.outbox.acknowledge(record.eventKey, jobId);
      this.outbox.markPending(record.eventKey, `ingress_${response.status}`);
    } catch {
      this.outbox.markPending(record.eventKey, "ingress_transport_error");
    }
    return false;
  }
}

function timeoutAfter(timeoutMs: number): DeliveryDeadline {
  return {
    createBudget(): DeliveryBudget {
      const startedAt = Date.now();
      let exhausted = false;
      return {
        get expired() { return exhausted || Date.now() - startedAt >= timeoutMs; },
        async run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<DeliveryAttempt<T>> {
          const remainingMs = timeoutMs - (Date.now() - startedAt);
          if (remainingMs <= 0) {
            exhausted = true;
            return { completed: false };
          }
          const controller = new AbortController();
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              operation(controller.signal).then((value) => ({ completed: true as const, value })),
              new Promise<DeliveryAttempt<T>>((resolve) => {
                timeout = setTimeout(() => {
                  exhausted = true;
                  controller.abort();
                  resolve({ completed: false });
                }, remainingMs);
              })
            ]);
          } finally {
            if (timeout) clearTimeout(timeout);
          }
        }
      };
    }
  };
}

function readAcceptedJobId(response: IngressResponse): string | null {
  if (response.status !== 202 || typeof response.body !== "object" || response.body === null) return null;
  const jobId = (response.body as Record<string, unknown>).jobId;
  return typeof jobId === "string" && jobId.trim() !== "" ? jobId : null;
}
