import { describe, expect, it } from "vitest";

import { parseSyncEvent } from "../src/event.js";

const validInput = {
  schemaVersion: "1.0",
  eventId: "evt-1",
  eventKey: "u-1:profile.sync.requested:evt-1",
  type: "profile.sync.requested",
  userId: "u-1",
  sourceSkill: "algorithm-learning",
  destination: "drive",
  createdAt: "2026-08-12T00:00:00.000Z",
  payload: {}
};

describe("parseSyncEvent", () => {
  it("returns valid Drive sync events unchanged", () => {
    expect(parseSyncEvent(validInput)).toEqual(validInput);
  });

  it("rejects a non-Drive destination", () => {
    expect(() => parseSyncEvent({ ...validInput, destination: "s3" })).toThrow(
      /destination/i
    );
  });

  it("rejects an event key whose first segment differs from userId", () => {
    expect(() =>
      parseSyncEvent({ ...validInput, eventKey: "u-2:profile.sync.requested:evt-1" })
    ).toThrow(/eventKey/i);
  });
});
