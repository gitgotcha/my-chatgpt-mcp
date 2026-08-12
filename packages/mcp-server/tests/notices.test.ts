import { describe, expect, test } from "vitest";
import { LocalOutbox } from "../src/outbox.js";
import { SubmitEventService } from "../src/submit-event.js";

const event = { schemaVersion: "1", eventId: "e", eventKey: "qiao:notice:1", type: "profile.updated", userId: "qiao", sourceSkill: "algorithm-learning", destination: "drive" as const, createdAt: "2026-08-12T00:00:00.000Z", payload: {} };

describe("notice delivery", () => {
  test("returns an open failure notice after a successful submit", async () => {
    const service = new SubmitEventService(new LocalOutbox(":memory:"), { send: async () => ({ status: 202, body: { jobId: "job-2" } }) }, { listNotices: async () => [{ code: "drive:authorization", message: "Google Drive 授权失效，需要重新授权。" }] });
    await expect(service.submit(event)).resolves.toMatchObject({ accepted: true, notices: [{ code: "drive:authorization", message: "Google Drive 授权失效，需要重新授权。" }] });
  });
});
