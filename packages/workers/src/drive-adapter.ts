import type { SyncEvent } from "@reliable-drive-sync/protocol/event";

export type SyncOutcome =
  | { kind: "success"; syncedAt: string }
  | { kind: "retryable"; code: string; retryAfterMs?: number }
  | { kind: "permanent"; code: string };

export interface DestinationAdapter { sync(event: SyncEvent): Promise<SyncOutcome>; }

export type DriveFile = { id: string; name: string; parentId: string; json: unknown };
export interface DriveCapability {
  list(parentId: string): Promise<DriveFile[]>;
  create(parentId: string, name: string, json: unknown): Promise<DriveFile>;
  read(fileId: string): Promise<DriveFile | null>;
}

/** Production-shaped REST boundary; it remains inert until OAuth and folder bindings are configured. */
export class GoogleDriveCapability implements DriveCapability {
  private cached?: { token: string; expiresAt: number };
  constructor(private readonly env: { GOOGLE_DRIVE_ACCESS_TOKEN?: string; GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string; GOOGLE_REFRESH_TOKEN?: string }, private readonly fetchLike: typeof fetch = fetch, private readonly now: () => number = () => Date.now()) {}
  private async token(): Promise<string> {
    if (this.env.GOOGLE_DRIVE_ACCESS_TOKEN) return this.env.GOOGLE_DRIVE_ACCESS_TOKEN;
    if (this.cached && this.cached.expiresAt > this.now() + 60_000) return this.cached.token;
    if (!this.env.GOOGLE_CLIENT_ID || !this.env.GOOGLE_CLIENT_SECRET || !this.env.GOOGLE_REFRESH_TOKEN) throw { status: 503, configuration: true };
    const body = new URLSearchParams({ client_id: this.env.GOOGLE_CLIENT_ID, client_secret: this.env.GOOGLE_CLIENT_SECRET, refresh_token: this.env.GOOGLE_REFRESH_TOKEN, grant_type: "refresh_token" });
    const response = await this.fetchLike("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    if (!response.ok) throw { status: response.status === 429 ? 429 : 401 };
    const value = await response.json() as { access_token?: unknown; expires_in?: unknown }; if (typeof value.access_token !== "string") throw { status: 503 };
    this.cached = { token: value.access_token, expiresAt: this.now() + (typeof value.expires_in === "number" ? value.expires_in : 300) * 1000 };
    return this.cached.token;
  }
  private async request(path: string, init?: RequestInit, upload = false): Promise<Response> {
    const response = await this.fetchLike(`${upload ? "https://www.googleapis.com/upload/drive/v3/" : "https://www.googleapis.com/drive/v3/"}${path}`, { ...init, headers: { authorization: `Bearer ${await this.token()}`, ...(init?.headers ?? {}) } });
    if (!response.ok) { const retryAfter = Number(response.headers.get("retry-after")); throw { status: response.status, retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined }; }
    return response;
  }
  async list(parentId: string): Promise<DriveFile[]> { const response = await this.request(`files?q=${encodeURIComponent(`'${parentId}' in parents and trashed = false`)}&fields=files(id,name,parents,mimeType)`); const body = await response.json() as { files?: Array<{ id: string; name: string; parents?: string[]; mimeType?: string }> }; return Promise.all((body.files ?? []).filter((file) => file.mimeType === "application/json").map(async (file) => { const json = await (await this.request(`files/${encodeURIComponent(file.id)}?alt=media`)).json(); return { id: file.id, name: file.name, parentId: file.parents?.[0] ?? "", json }; })); }
  async create(parentId: string, name: string, json: unknown): Promise<DriveFile> { const boundary = `reliable-${crypto.randomUUID()}`; const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [parentId], mimeType: "application/json" })}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(json)}\r\n--${boundary}--`; const response = await this.request("files?uploadType=multipart&fields=id,name,parents", { method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body }, true); const file = await response.json() as { id: string; name: string; parents?: string[] }; return { id: file.id, name: file.name, parentId: file.parents?.[0] ?? parentId, json }; }
  async read(fileId: string): Promise<DriveFile | null> { try { const metadata = await (await this.request(`files/${encodeURIComponent(fileId)}?fields=id,name,parents,mimeType`)).json() as { id: string; name: string; parents?: string[]; mimeType?: string }; if (metadata.mimeType !== "application/json") return null; const json = await (await this.request(`files/${encodeURIComponent(fileId)}?alt=media`)).json(); return { id: metadata.id, name: metadata.name, parentId: metadata.parents?.[0] ?? "", json }; } catch (error) { if (isRecord(error) && error.status === 404) return null; throw error; } }
}

type ImmutableEvent = { schemaVersion: string; kind: "event"; userId: string; eventKey: string; event: SyncEvent };
type Snapshot = { schemaVersion: string; kind: "snapshot"; userId: string; sourceEventKeys: string[]; generatedAt: string; events: SyncEvent[] };

function eventName(event: SyncEvent): string { return `event-${encodeURIComponent(event.eventKey)}.json`; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function validEvent(value: unknown, userId: string): value is ImmutableEvent {
  return isRecord(value) && value.kind === "event" && value.schemaVersion === "1" && value.userId === userId && typeof value.eventKey === "string" && isRecord(value.event) && value.eventKey === value.event.eventKey && value.event.userId === userId;
}
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function validSnapshot(value: unknown, userId: string, keys: string[], immutable: Map<string, SyncEvent>): value is Snapshot {
  return isRecord(value) && value.kind === "snapshot" && value.schemaVersion === "1" && value.userId === userId && typeof value.generatedAt === "string" && Array.isArray(value.sourceEventKeys) && value.sourceEventKeys.every((key) => typeof key === "string") && Array.isArray(value.events) && value.events.every((event) => isRecord(event) && event.userId === userId && typeof event.eventKey === "string") && sameKeys(value.sourceEventKeys, keys) && sameKeys(value.events.map((event) => String((event as Record<string, unknown>).eventKey)), keys) && value.events.every((item) => canonical(item) === canonical(immutable.get(String((item as Record<string, unknown>).eventKey))));
}
function sameKeys(left: string[], right: string[]): boolean { return left.length === right.length && [...left].sort().every((key, index) => key === [...right].sort()[index]); }
function problem(error: unknown): SyncOutcome {
  const status = isRecord(error) && typeof error.status === "number" ? error.status : undefined;
  const retryAfterMs = isRecord(error) && typeof error.retryAfterMs === "number" ? Math.min(Math.max(error.retryAfterMs, 0), 3_600_000) : undefined;
  if (status === 429 || (status !== undefined && status >= 500 && status <= 599) || error instanceof TypeError) return { kind: "retryable", code: status === 429 ? "drive_rate_limited" : "drive_unavailable", retryAfterMs };
  return { kind: "permanent", code: status && status >= 400 && status < 500 ? "drive_request_rejected" : "drive_invalid_data" };
}

/** Immutable per-event files plus verified aggregate snapshots.  The capability can be backed by Google Drive later. */
export class DriveDestinationAdapter implements DestinationAdapter {
  constructor(private readonly drive: DriveCapability, private readonly eventsParentId: string, private readonly snapshotsParentId: string, private readonly now: () => Date = () => new Date()) {}

  async sync(event: SyncEvent): Promise<SyncOutcome> {
    try {
      if (event.destination !== "drive" || !event.userId || !this.eventsParentId || !this.snapshotsParentId) return { kind: "permanent", code: "invalid_drive_identity" };
      const existingEvents = await this.drive.list(this.eventsParentId);
      const known = new Map<string, SyncEvent>();
      for (const file of existingEvents) if (file.parentId === this.eventsParentId && validEvent(file.json, event.userId)) known.set(file.json.eventKey, file.json.event);
      if (!known.has(event.eventKey)) {
        const immutable: ImmutableEvent = { schemaVersion: "1", kind: "event", userId: event.userId, eventKey: event.eventKey, event };
        const created = await this.drive.create(this.eventsParentId, eventName(event), immutable);
        const reread = await this.drive.read(created.id);
        if (!reread || reread.parentId !== this.eventsParentId || !validEvent(reread.json, event.userId) || reread.json.eventKey !== event.eventKey) return { kind: "retryable", code: "event_readback_failed" };
        known.set(event.eventKey, event);
      }
      const keys = [...known.keys()].sort();
      const candidateSnapshots = await this.drive.list(this.snapshotsParentId);
      const complete = candidateSnapshots.filter((file) => file.parentId === this.snapshotsParentId && validSnapshot(file.json, event.userId, keys, known))
        .sort((a, b) => String((b.json as Snapshot).generatedAt).localeCompare(String((a.json as Snapshot).generatedAt)) || b.id.localeCompare(a.id));
      if (complete.length > 0) return { kind: "success", syncedAt: (complete[0].json as Snapshot).generatedAt };
      const generatedAt = this.now().toISOString();
      const snapshot: Snapshot = { schemaVersion: "1", kind: "snapshot", userId: event.userId, sourceEventKeys: keys, generatedAt, events: keys.map((key) => known.get(key)!) };
      const created = await this.drive.create(this.snapshotsParentId, `snapshot-${generatedAt.replace(/[:.]/g, "-")}-${crypto.randomUUID()}.json`, snapshot);
      const reread = await this.drive.read(created.id);
      if (!reread || reread.parentId !== this.snapshotsParentId || !validSnapshot(reread.json, event.userId, keys, known)) return { kind: "retryable", code: "snapshot_readback_failed" };
      return { kind: "success", syncedAt: generatedAt };
    } catch (error) { return problem(error); }
  }
}

export function createProductionDriveAdapter(env: { GOOGLE_DRIVE_ACCESS_TOKEN?: string; GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string; GOOGLE_REFRESH_TOKEN?: string; DRIVE_EVENTS_PARENT_ID?: string; DRIVE_SNAPSHOTS_PARENT_ID?: string }): DestinationAdapter {
  return new DriveDestinationAdapter(new GoogleDriveCapability(env), env.DRIVE_EVENTS_PARENT_ID ?? "", env.DRIVE_SNAPSHOTS_PARENT_ID ?? "");
}
