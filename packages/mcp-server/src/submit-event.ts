import { parseSyncEvent, type SyncEvent } from "@reliable-drive-sync/protocol/event";
import type { NoticeClient, SyncNotice } from "./notice-client.js";
import { DisabledNoticeClient } from "./notice-client.js";
import type { LocalOutbox, OutboxRecord } from "./outbox.js";

export type IngressResponse = { status: number; body: unknown };
export interface IngressTransport {
  send(event: SyncEvent): Promise<IngressResponse>;
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
    private readonly maxFlushEvents = 20
  ) {}

  async submit(input: unknown): Promise<LocalSubmitResult> {
    const event = parseSyncEvent(input);
    this.outbox.enqueue(event);

    const pendingBeforeCurrent = this.outbox.listPending()
      .filter((record) => record.eventKey !== event.eventKey)
      .slice(0, this.maxFlushEvents);
    for (const record of pendingBeforeCurrent) await this.deliver(record);

    const accepted = await this.deliverByKey(event.eventKey);
    return {
      accepted,
      eventKey: event.eventKey,
      deliveryState: accepted ? "cloud_accepted" : "pending",
      notices: await this.noticeClient.listNotices()
    };
  }

  async flushPending(limit = this.maxFlushEvents): Promise<void> {
    for (const record of this.outbox.listPending().slice(0, limit)) await this.deliver(record);
  }

  private async deliverByKey(eventKey: string): Promise<boolean> {
    const record = this.outbox.listPending().find((item) => item.eventKey === eventKey);
    return record ? this.deliver(record) : true;
  }

  private async deliver(record: OutboxRecord): Promise<boolean> {
    this.outbox.markSending(record.eventKey);
    try {
      const response = await this.transport.send(record.event);
      const jobId = readAcceptedJobId(response);
      if (jobId) return this.outbox.acknowledge(record.eventKey, jobId);
      this.outbox.markPending(record.eventKey, `ingress_${response.status}`);
    } catch {
      this.outbox.markPending(record.eventKey, "ingress_transport_error");
    }
    return false;
  }
}

function readAcceptedJobId(response: IngressResponse): string | null {
  if (response.status !== 202 || typeof response.body !== "object" || response.body === null) return null;
  const jobId = (response.body as Record<string, unknown>).jobId;
  return typeof jobId === "string" && jobId.trim() !== "" ? jobId : null;
}
