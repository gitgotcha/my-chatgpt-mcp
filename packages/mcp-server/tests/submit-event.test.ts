import { describe, expect, test } from "vitest";
import { LocalOutbox } from "../src/outbox.js";
import { SubmitEventService, type DeliveryDeadline } from "../src/submit-event.js";

const baseEvent = {
  schemaVersion: "1",
  eventId: "event-current",
  eventKey: "qiao:current:1",
  type: "profile.updated",
  userId: "qiao",
  sourceSkill: "algorithm-learning",
  destination: "drive" as const,
  createdAt: "2026-08-12T00:00:00.000Z",
  payload: { topic: "three-sum" }
};

describe("SubmitEventService", () => {
  test("acknowledges an event only after a valid 202 job response", async () => {
    const outbox = new LocalOutbox(":memory:");
    const service = new SubmitEventService(outbox, {
      send: async () => ({ status: 202, body: { jobId: "job-123" } })
    });

    await expect(service.submit(baseEvent)).resolves.toEqual({
      accepted: true,
      eventKey: "qiao:current:1",
      deliveryState: "cloud_accepted",
      notices: []
    });
    expect(outbox.listPending()).toHaveLength(0);
  });

  test("keeps an event pending after a transport timeout", async () => {
    const outbox = new LocalOutbox(":memory:");
    const service = new SubmitEventService(outbox, {
      send: async () => { throw new Error("timeout"); }
    });

    await expect(service.submit(baseEvent)).resolves.toMatchObject({
      accepted: false,
      eventKey: "qiao:current:1",
      deliveryState: "pending"
    });
    expect(outbox.listPending()).toHaveLength(1);
  });

  test("keeps an event pending after a malformed 202 response", async () => {
    const outbox = new LocalOutbox(":memory:");
    const service = new SubmitEventService(outbox, {
      send: async () => ({ status: 202, body: { jobId: "" } })
    });

    await expect(service.submit(baseEvent)).resolves.toMatchObject({
      accepted: false,
      deliveryState: "pending"
    });
    expect(outbox.listPending()).toHaveLength(1);
  });

  test("continues with the current event when an earlier pending event fails", async () => {
    const outbox = new LocalOutbox(":memory:");
    outbox.enqueue({ ...baseEvent, eventId: "event-old", eventKey: "qiao:old:1" });
    const service = new SubmitEventService(outbox, {
      send: async (event) => event.eventKey === "qiao:old:1"
        ? { status: 503, body: {} }
        : { status: 202, body: { jobId: "job-current" } }
    });

    await expect(service.submit(baseEvent)).resolves.toMatchObject({
      accepted: true,
      eventKey: "qiao:current:1",
      deliveryState: "cloud_accepted"
    });
    expect(outbox.listPending()).toHaveLength(1);
    expect(outbox.listPending()[0]?.eventKey).toBe("qiao:old:1");
  });

  test("submits the current event when an earlier send never resolves", async () => {
    const outbox = new LocalOutbox(":memory:");
    outbox.enqueue({ ...baseEvent, eventId: "event-old", eventKey: "qiao:old:1" });
    let attempts = 0;
    const timeoutOldOnly: DeliveryDeadline = {
      run: async (operation) => {
        if (++attempts === 1) {
          void operation();
          return { completed: false };
        }
        return { completed: true, value: await operation() };
      }
    };
    const service = new SubmitEventService(outbox, {
      send: async (event) => event.eventKey === "qiao:old:1"
        ? new Promise(() => undefined)
        : { status: 202, body: { jobId: "job-current" } }
    }, undefined, 20, timeoutOldOnly);

    await expect(service.submit(baseEvent)).resolves.toMatchObject({
      accepted: true,
      eventKey: "qiao:current:1",
      deliveryState: "cloud_accepted"
    });
    expect(outbox.listPending()[0]?.eventKey).toBe("qiao:old:1");
  });

  test("reports a concurrent duplicate as pending when the in-flight delivery later fails", async () => {
    const outbox = new LocalOutbox(":memory:");
    let rejectFirst!: (reason: Error) => void;
    const firstResponse = new Promise<never>((_resolve, reject) => { rejectFirst = reject; });
    const service = new SubmitEventService(outbox, { send: async () => firstResponse });

    const first = service.submit(baseEvent);
    await Promise.resolve();
    await expect(service.submit(baseEvent)).resolves.toMatchObject({
      accepted: false,
      eventKey: "qiao:current:1",
      deliveryState: "pending"
    });
    rejectFirst(new Error("ingress unavailable"));
    await expect(first).resolves.toMatchObject({ accepted: false, deliveryState: "pending" });
  });
});
