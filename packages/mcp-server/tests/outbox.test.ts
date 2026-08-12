import { describe, expect, test } from "vitest";
import { LocalOutbox } from "../src/outbox.js";

const event = {
  schemaVersion: "1",
  eventId: "event-1",
  eventKey: "qiao:profile:1",
  type: "profile.updated",
  userId: "qiao",
  sourceSkill: "algorithm-learning",
  destination: "drive" as const,
  createdAt: "2026-08-12T00:00:00.000Z",
  payload: { topic: "three-sum" }
};

describe("LocalOutbox", () => {
  test("deduplicates an event key while retaining one pending row", () => {
    const outbox = new LocalOutbox(":memory:");

    outbox.enqueue(event);
    outbox.enqueue({ ...event, eventId: "event-2" });

    expect(outbox.listPending()).toHaveLength(1);
    expect(outbox.listPending()[0]).toMatchObject({
      eventKey: "qiao:profile:1",
      state: "pending",
      attemptCount: 0
    });
  });

  test("recovers abandoned sending rows as pending during startup", () => {
    const outbox = new LocalOutbox(":memory:");
    outbox.enqueue(event);
    outbox.markSending("qiao:profile:1");
    outbox.recoverSending();

    expect(outbox.listPending()[0]?.state).toBe("pending");
  });
});
