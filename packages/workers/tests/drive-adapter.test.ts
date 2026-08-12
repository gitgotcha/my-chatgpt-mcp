import { describe, expect, it } from "vitest";
import { cachedProductionDriveAdapter, DriveDestinationAdapter, GoogleDriveCapability, type DriveCapability, type DriveFile } from "../src/drive-adapter.js";
import type { SyncEvent } from "@reliable-drive-sync/protocol/event";

const event: SyncEvent = { schemaVersion: "1", eventId: "e1", eventKey: "u1:lesson:1", type: "lesson", userId: "u1", sourceSkill: "algorithm", destination: "drive", createdAt: "2026-01-01T00:00:00.000Z", payload: { title: "two sum" } };
class MemoryDrive implements DriveCapability {
  files: DriveFile[] = []; creates = 0; failSnapshot = false; failSnapshotRead = false;
  async list(parentId: string) { return this.files.filter((file) => file.parentId === parentId); }
  async create(parentId: string, name: string, json: unknown) { this.creates += 1; if (this.failSnapshot && parentId === "snapshots") throw { status: 429, retryAfterMs: 5000 }; const file = { id: String(this.creates), name, parentId, json }; this.files.push(file); return file; }
  async read(id: string) { const file = this.files.find((file) => file.id === id) ?? null; return this.failSnapshotRead && file?.parentId === "snapshots" ? null : file; }
}
describe("DriveDestinationAdapter", () => {
  it("uses Drive JSON media endpoints and multipart JSON bytes without putting payload in metadata", async () => { const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = []; const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => { calls.push([input, init]); return new Response(JSON.stringify({ id: "f1", name: "a.json", parents: ["p"] }), { status: 200 }); }; const drive = new GoogleDriveCapability({ GOOGLE_DRIVE_ACCESS_TOKEN: "fast" }, fetchMock as typeof fetch); await drive.create("p", "a.json", { safe: true }); expect(String(calls[0][0])).toContain("/upload/drive/v3/files?uploadType=multipart"); expect(String(calls[0][1]?.body)).toContain('"safe":true'); expect(String(calls[0][1]?.body)).not.toContain("description"); });
  it("treats missing OAuth configuration and refresh 5xx as retryable", async () => { const drive = new GoogleDriveCapability({}); expect(await new DriveDestinationAdapter(drive, "events", "snapshots").sync(event)).toMatchObject({ kind: "retryable", code: "drive_unavailable" }); const failing = new GoogleDriveCapability({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret", GOOGLE_REFRESH_TOKEN: "refresh" }, (async () => new Response("", { status: 503 })) as typeof fetch); expect(await new DriveDestinationAdapter(failing, "events", "snapshots").sync(event)).toMatchObject({ kind: "retryable" }); });
  it("treats absent Drive parent bindings as retryable configuration unavailable", async () => { expect(await new DriveDestinationAdapter(new MemoryDrive(), "", "").sync(event)).toMatchObject({ kind: "retryable", code: "drive_configuration_unavailable" }); });
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
  it("does not report success when snapshot readback fails", async () => { const drive = new MemoryDrive(); drive.failSnapshotRead = true; expect(await new DriveDestinationAdapter(drive, "events", "snapshots").sync(event)).toMatchObject({ kind: "retryable", code: "snapshot_readback_failed" }); });
  it("ignores corrupt/partial snapshots and selects the newest coherent complete snapshot", async () => {
    const drive = new MemoryDrive(); const immutable = { schemaVersion: "1", kind: "event", userId: "u1", eventKey: event.eventKey, event }; await drive.create("events", "event", immutable);
    drive.files.push({ id: "partial", name: "partial", parentId: "snapshots", json: { schemaVersion: "1", kind: "snapshot", userId: "u1", sourceEventKeys: [event.eventKey], generatedAt: "2026-01-03", events: [] } });
    drive.files.push({ id: "altered", name: "altered", parentId: "snapshots", json: { schemaVersion: "1", kind: "snapshot", userId: "u1", sourceEventKeys: [event.eventKey], generatedAt: "2026-01-05", events: [{ ...event, payload: { title: "altered" } }] } });
    drive.files.push({ id: "old", name: "old", parentId: "snapshots", json: { schemaVersion: "1", kind: "snapshot", userId: "u1", sourceEventKeys: [event.eventKey], generatedAt: "2026-01-02", events: [event] } });
    drive.files.push({ id: "new", name: "new", parentId: "snapshots", json: { schemaVersion: "1", kind: "snapshot", userId: "u1", sourceEventKeys: [event.eventKey], generatedAt: "2026-01-04", events: [event] } });
    const result = await new DriveDestinationAdapter(drive, "events", "snapshots").sync(event);
    expect(result).toMatchObject({ kind: "success", syncedAt: "2026-01-04" }); expect(drive.creates).toBe(1);
  });
});

it("reuses the isolate-local capability only for the same Drive configuration", () => {
  const same = { GOOGLE_CLIENT_ID: "client-a", GOOGLE_CLIENT_SECRET: "secret-a", GOOGLE_REFRESH_TOKEN: "refresh-a", DRIVE_EVENTS_PARENT_ID: "events", DRIVE_SNAPSHOTS_PARENT_ID: "snapshots" };
  expect(cachedProductionDriveAdapter(same)).toBe(cachedProductionDriveAdapter({ ...same }));
  expect(cachedProductionDriveAdapter(same)).not.toBe(cachedProductionDriveAdapter({ ...same, GOOGLE_REFRESH_TOKEN: "refresh-b" }));
});
