import { describe, expect, it, vi } from "vitest";
import { cachedProductionDriveAdapter, DRIVE_FOLDER_MIME_TYPE, DriveDestinationAdapter, GoogleDriveCapability, resetDriveAdapterCacheForTest, type DriveCapability, type DriveFile } from "../src/drive-adapter.js";
import type { SyncEvent } from "@reliable-drive-sync/protocol/event";

const event: SyncEvent = { schemaVersion: "1", eventId: "e1", eventKey: "u1:lesson:1", type: "lesson", userId: "u1", sourceSkill: "algorithm", destination: "drive", createdAt: "2026-01-01T00:00:00.000Z", payload: { title: "two sum" } };
class MemoryDrive implements DriveCapability {
  files: DriveFile[] = []; creates = 0; calls = 0; failSnapshot = false; failSnapshotRead = false;
  async list(parentId: string) { this.calls += 1; return this.files.filter((file) => file.parentId === parentId); }
  async create(parentId: string, name: string, json: unknown) { this.creates += 1; if (this.failSnapshot && parentId.includes("snapshots")) throw { status: 429, retryAfterMs: 5000 }; const file = { id: String(this.creates), name, parentId, mimeType: "application/json", json }; this.files.push(file); return file; }
  async ensureFolder(parentId: string, name: string) { this.calls += 1; return this.files.find((file) => file.parentId === parentId && file.name === name && file.mimeType === DRIVE_FOLDER_MIME_TYPE) ?? (() => { const file = { id: `${parentId}/${name}`, name, parentId, mimeType: DRIVE_FOLDER_MIME_TYPE, json: null }; this.files.push(file); return file; })(); }
  async read(id: string) { const file = this.files.find((file) => file.id === id) ?? null; return this.failSnapshotRead && file?.parentId.includes("snapshots") ? null : file; }
}

async function servicePrivateKeyPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  );
  const bytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `-----BEGIN PRIVATE KEY-----\n${btoa(binary).match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
}
describe("DriveDestinationAdapter", () => {
  it("creates a Drive folder as folder metadata and reuses a deterministic match", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const created = new GoogleDriveCapability({ GOOGLE_DRIVE_ACCESS_TOKEN: "fast" }, (async (input, init) => {
      calls.push([input, init]);
      if ((init?.method ?? "GET") === "POST") return new Response(JSON.stringify({ id: "new-folder", name: "algorithm-learning", parents: ["root"], mimeType: DRIVE_FOLDER_MIME_TYPE }));
      return new Response(JSON.stringify({ files: [] }));
    }) as typeof fetch);
    await expect(created.ensureFolder("root", "algorithm-learning")).resolves.toMatchObject({ id: "new-folder", mimeType: DRIVE_FOLDER_MIME_TYPE });
    expect(new Headers(calls[1]?.[1]?.headers).get("content-type")).toBe("application/json");
    expect(String(calls[1]?.[1]?.body)).toContain(DRIVE_FOLDER_MIME_TYPE);

    const reused = new GoogleDriveCapability({ GOOGLE_DRIVE_ACCESS_TOKEN: "fast" }, (async () => new Response(JSON.stringify({ files: [
      { id: "z-folder", name: "algorithm-learning", parents: ["root"], mimeType: DRIVE_FOLDER_MIME_TYPE },
      { id: "a-folder", name: "algorithm-learning", parents: ["root"], mimeType: DRIVE_FOLDER_MIME_TYPE },
    ] }))) as typeof fetch);
    await expect(reused.ensureFolder("root", "algorithm-learning")).resolves.toMatchObject({ id: "a-folder" });
  });
  it("uses Drive JSON media endpoints and multipart JSON bytes without putting payload in metadata", async () => { const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = []; const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => { calls.push([input, init]); return new Response(JSON.stringify({ id: "f1", name: "a.json", parents: ["p"] }), { status: 200 }); }; const drive = new GoogleDriveCapability({ GOOGLE_DRIVE_ACCESS_TOKEN: "fast" }, fetchMock as typeof fetch); await drive.create("p", "a.json", { safe: true }); expect(String(calls[0][0])).toContain("/upload/drive/v3/files?uploadType=multipart"); expect(String(calls[0][1]?.body)).toContain('"safe":true'); expect(String(calls[0][1]?.body)).not.toContain("description"); });
  it("calls OAuth refresh fetch without rebinding the platform receiver", async () => { const fetchMock = async function (this: unknown, input: RequestInfo | URL): Promise<Response> { expect(this).toBeUndefined(); return String(input).includes("oauth2.googleapis.com") ? new Response(JSON.stringify({ access_token: "token", expires_in: 3600 })) : new Response(JSON.stringify({ files: [] })); }; const drive = new GoogleDriveCapability({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret", GOOGLE_REFRESH_TOKEN: "refresh" }, fetchMock as typeof fetch); await expect(drive.list("events")).resolves.toEqual([]); });
  it("marks missing OAuth configuration distinctly while keeping refresh 5xx retryable", async () => { const drive = new GoogleDriveCapability({}); expect(await new DriveDestinationAdapter(drive, "events", "snapshots").sync(event)).toMatchObject({ kind: "retryable", code: "drive_configuration_unavailable" }); const failing = new GoogleDriveCapability({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret", GOOGLE_REFRESH_TOKEN: "refresh" }, (async () => new Response("", { status: 503 })) as typeof fetch); expect(await new DriveDestinationAdapter(failing, "events", "snapshots").sync(event)).toMatchObject({ kind: "retryable", code: "drive_unavailable" }); });
  it("treats absent Drive parent bindings as retryable configuration unavailable", async () => { expect(await new DriveDestinationAdapter(new MemoryDrive(), "", "").sync(event)).toMatchObject({ kind: "retryable", code: "drive_configuration_unavailable" }); });
  it("creates a verified immutable event and snapshot, then is duplicate safe", async () => {
    const drive = new MemoryDrive(); const adapter = new DriveDestinationAdapter(drive, "events", "snapshots", () => new Date("2026-01-02T00:00:00.000Z"));
    expect((await adapter.sync(event)).kind).toBe("success"); expect(drive.files.filter((f) => f.parentId === "events")).toHaveLength(1);
    expect((await adapter.sync(event)).kind).toBe("success"); expect(drive.files.filter((f) => f.parentId === "events")).toHaveLength(1);
  });
  it("stores new events and snapshots under their skill and user directories", async () => {
    const drive = new MemoryDrive();
    const scoped = { ...event, userId: "qiaobingyuan", sourceSkill: "algorithm-learning", eventKey: "qiaobingyuan:algorithm-learning:two-sum:1" };
    await expect(new DriveDestinationAdapter(drive, "events", "snapshots").sync(scoped)).resolves.toMatchObject({ kind: "success" });

    const eventFile = drive.files.find((file) => file.name.startsWith("event-"));
    const snapshotFile = drive.files.find((file) => file.name.startsWith("snapshot-"));
    expect(eventFile?.parentId).toBe("events/algorithm-learning/qiaobingyuan");
    expect(snapshotFile?.parentId).toBe("snapshots/algorithm-learning/qiaobingyuan");
  });
  it("keeps snapshots isolated between skills for the same user", async () => {
    const drive = new MemoryDrive();
    const algorithms = { ...event, userId: "qiaobingyuan", sourceSkill: "algorithm-learning", eventKey: "qiaobingyuan:algorithm-learning:one" };
    const interviews = { ...event, userId: "qiaobingyuan", sourceSkill: "interview", eventKey: "qiaobingyuan:interview:one" };
    const adapter = new DriveDestinationAdapter(drive, "events", "snapshots");
    await adapter.sync(algorithms); await adapter.sync(interviews);

    const algorithmSnapshot = drive.files.find((file) => file.parentId === "snapshots/algorithm-learning/qiaobingyuan" && file.name.startsWith("snapshot-"));
    const interviewSnapshot = drive.files.find((file) => file.parentId === "snapshots/interview/qiaobingyuan" && file.name.startsWith("snapshot-"));
    expect((algorithmSnapshot?.json as { sourceEventKeys: string[] }).sourceEventKeys).toEqual([algorithms.eventKey]);
    expect((interviewSnapshot?.json as { sourceEventKeys: string[] }).sourceEventKeys).toEqual([interviews.eventKey]);
  });
  it("rejects unsafe directory components before Drive I/O", async () => {
    const drive = new MemoryDrive();
    const unsafe = { ...event, sourceSkill: "../unsafe" };
    await expect(new DriveDestinationAdapter(drive, "events", "snapshots").sync(unsafe)).resolves.toEqual({ kind: "permanent", code: "invalid_drive_identity" });
    expect(drive.calls).toBe(0);
  });
  it("rebuilds a missing snapshot when the immutable event exists", async () => {
    const drive = new MemoryDrive(); const adapter = new DriveDestinationAdapter(drive, "events", "snapshots"); await drive.create("events/algorithm/u1", "old", { schemaVersion: "1", kind: "event", userId: "u1", eventKey: event.eventKey, event });
    expect((await adapter.sync(event)).kind).toBe("success"); expect(drive.files.filter((f) => f.parentId === "snapshots")).toHaveLength(1);
  });
  it("returns retryable on snapshot rate limiting after the event is stored", async () => {
    const drive = new MemoryDrive(); drive.failSnapshot = true; const result = await new DriveDestinationAdapter(drive, "events", "snapshots").sync(event);
    expect(result).toMatchObject({ kind: "retryable", retryAfterMs: 5000 }); expect(drive.files.filter((f) => f.parentId === "events")).toHaveLength(1);
  });
  it("does not report success when snapshot readback fails", async () => { const drive = new MemoryDrive(); drive.failSnapshotRead = true; expect(await new DriveDestinationAdapter(drive, "events", "snapshots").sync(event)).toMatchObject({ kind: "retryable", code: "snapshot_readback_failed" }); });
  it("ignores corrupt/partial snapshots and selects the newest coherent complete snapshot", async () => {
    const drive = new MemoryDrive(); const immutable = { schemaVersion: "1", kind: "event", userId: "u1", eventKey: event.eventKey, event }; await drive.create("events/algorithm/u1", "event", immutable);
    drive.files.push({ id: "partial", name: "partial", parentId: "snapshots/algorithm/u1", mimeType: "application/json", json: { schemaVersion: "1", kind: "snapshot", userId: "u1", sourceEventKeys: [event.eventKey], generatedAt: "2026-01-03", events: [] } });
    drive.files.push({ id: "altered", name: "altered", parentId: "snapshots/algorithm/u1", mimeType: "application/json", json: { schemaVersion: "1", kind: "snapshot", userId: "u1", sourceEventKeys: [event.eventKey], generatedAt: "2026-01-05", events: [{ ...event, payload: { title: "altered" } }] } });
    drive.files.push({ id: "old", name: "old", parentId: "snapshots/algorithm/u1", mimeType: "application/json", json: { schemaVersion: "1", kind: "snapshot", userId: "u1", sourceEventKeys: [event.eventKey], generatedAt: "2026-01-02", events: [event] } });
    drive.files.push({ id: "new", name: "new", parentId: "snapshots/algorithm/u1", mimeType: "application/json", json: { schemaVersion: "1", kind: "snapshot", userId: "u1", sourceEventKeys: [event.eventKey], generatedAt: "2026-01-04", events: [event] } });
    const result = await new DriveDestinationAdapter(drive, "events", "snapshots").sync(event);
    expect(result).toMatchObject({ kind: "success", syncedAt: "2026-01-04" }); expect(drive.creates).toBe(1);
  });
});

it("reuses the isolate-local capability only for the same Drive configuration", () => {
  resetDriveAdapterCacheForTest();
  const same = { GOOGLE_CLIENT_ID: "client-a", GOOGLE_CLIENT_SECRET: "secret-a", GOOGLE_REFRESH_TOKEN: "refresh-a", DRIVE_EVENTS_PARENT_ID: "events", DRIVE_SNAPSHOTS_PARENT_ID: "snapshots" };
  expect(cachedProductionDriveAdapter(same)).toBe(cachedProductionDriveAdapter({ ...same }));
  expect(cachedProductionDriveAdapter(same)).not.toBe(cachedProductionDriveAdapter({ ...same, GOOGLE_REFRESH_TOKEN: "refresh-b" }));
});

it("bounds the capability cache and evicts least-recently-used configurations", () => {
  resetDriveAdapterCacheForTest();
  const original = cachedProductionDriveAdapter({ GOOGLE_REFRESH_TOKEN: "one" });
  for (let index = 0; index < 65; index += 1) cachedProductionDriveAdapter({ GOOGLE_REFRESH_TOKEN: `other-${index}` });
  expect(cachedProductionDriveAdapter({ GOOGLE_REFRESH_TOKEN: "one" })).not.toBe(original);
});

it("uses the service-account token before an explicit OAuth access token", async () => {
  const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
  const drive = new GoogleDriveCapability(
    {
      GOOGLE_SERVICE_ACCOUNT_EMAIL: "sync@test.iam.gserviceaccount.com",
      GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: await servicePrivateKeyPem(),
      GOOGLE_DRIVE_ACCESS_TOKEN: "must-not-be-used",
    },
    (async (input, init) => {
      calls.push([input, init]);
      if (String(input) === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "service-token", expires_in: 3600 }));
      return new Response(JSON.stringify({ files: [] }));
    }) as typeof fetch,
    () => 1_700_000_000_000,
  );

  await expect(drive.list("events")).resolves.toEqual([]);
  expect(calls).toHaveLength(2);
  expect(new Headers(calls[1]![1]?.headers).get("authorization")).toBe("Bearer service-token");
});

it("treats partial service-account configuration as retryable without OAuth fallback", async () => {
  const fetchMock = vi.fn(async () => { throw new TypeError("must not request Drive"); });
  const adapter = new DriveDestinationAdapter(
    new GoogleDriveCapability(
      { GOOGLE_SERVICE_ACCOUNT_EMAIL: "sync@test.iam.gserviceaccount.com", GOOGLE_DRIVE_ACCESS_TOKEN: "must-not-be-used" },
      fetchMock as typeof fetch,
    ),
    "events",
    "snapshots",
  );

  await expect(adapter.sync(event)).resolves.toMatchObject({ kind: "retryable", code: "drive_configuration_unavailable" });
  expect(fetchMock).not.toHaveBeenCalled();
});

it("separates service-account adapter cache identities", () => {
  resetDriveAdapterCacheForTest();
  const base = { GOOGLE_SERVICE_ACCOUNT_EMAIL: "sync@test.iam.gserviceaccount.com", DRIVE_EVENTS_PARENT_ID: "events", DRIVE_SNAPSHOTS_PARENT_ID: "snapshots" };
  expect(cachedProductionDriveAdapter({ ...base, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "key-a" }))
    .not.toBe(cachedProductionDriveAdapter({ ...base, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "key-b" }));
});

it.each([
  [429, { kind: "retryable", code: "drive_rate_limited" }],
  [503, { kind: "retryable", code: "drive_unavailable" }],
  [401, { kind: "permanent", code: "drive_request_rejected" }],
])("maps service-account token endpoint status %i through the Drive outcome", async (status, expected) => {
  const adapter = new DriveDestinationAdapter(
    new GoogleDriveCapability(
      { GOOGLE_SERVICE_ACCOUNT_EMAIL: "sync@test.iam.gserviceaccount.com", GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: await servicePrivateKeyPem() },
      (async () => new Response("", { status })) as typeof fetch,
    ),
    "events",
    "snapshots",
  );

  await expect(adapter.sync(event)).resolves.toMatchObject(expected);
});
