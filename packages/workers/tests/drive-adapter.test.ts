import { describe, expect, it } from "vitest";
import { DriveDestinationAdapter, type DriveCapability, type DriveFile } from "../src/drive-adapter.js";
import type { SyncEvent } from "@reliable-drive-sync/protocol/event";

const event: SyncEvent = { schemaVersion: "1", eventId: "e1", eventKey: "u1:lesson:1", type: "lesson", userId: "u1", sourceSkill: "algorithm", destination: "drive", createdAt: "2026-01-01T00:00:00.000Z", payload: { title: "two sum" } };
class MemoryDrive implements DriveCapability {
  files: DriveFile[] = []; creates = 0; failSnapshot = false;
  async list(parentId: string) { return this.files.filter((file) => file.parentId === parentId); }
  async create(parentId: string, name: string, json: unknown) { this.creates += 1; if (this.failSnapshot && parentId === "snapshots") throw { status: 429, retryAfterMs: 5000 }; const file = { id: String(this.creates), name, parentId, json }; this.files.push(file); return file; }
  async read(id: string) { return this.files.find((file) => file.id === id) ?? null; }
}
describe("DriveDestinationAdapter", () => {
  it("creates a verified immutable event and snapshot, then is duplicate safe", async () => {
    const drive = new MemoryDrive(); const adapter = new DriveDestinationAdapter(drive, "events", "snapshots", () => new Date("2026-01-02T00:00:00.000Z"));
    expect((await adapter.sync(event)).kind).toBe("success"); expect(drive.files.filter((f) => f.parentId === "events")).toHaveLength(1);
    expect((await adapter.sync(event)).kind).toBe("success"); expect(drive.files.filter((f) => f.parentId === "events")).toHaveLength(1);
  });
  it("rebuilds a missing snapshot when the immutable event exists", async () => {
    const drive = new MemoryDrive(); const adapter = new DriveDestinationAdapter(drive, "events", "snapshots"); await drive.create("events", "old", { schemaVersion: "1", kind: "event", userId: "u1", eventKey: event.eventKey, event });
    expect((await adapter.sync(event)).kind).toBe("success"); expect(drive.files.filter((f) => f.parentId === "snapshots")).toHaveLength(1);
  });
  it("returns retryable on snapshot rate limiting after the event is stored", async () => {
    const drive = new MemoryDrive(); drive.failSnapshot = true; const result = await new DriveDestinationAdapter(drive, "events", "snapshots").sync(event);
    expect(result).toMatchObject({ kind: "retryable", retryAfterMs: 5000 }); expect(drive.files.filter((f) => f.parentId === "events")).toHaveLength(1);
  });
});
