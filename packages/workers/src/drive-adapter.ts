import type { SyncEvent } from "@reliable-drive-sync/protocol/event";
import { GoogleServiceAccountCredential, type GoogleServiceAccountEnvironment } from "./service-account.js";

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

type DriveAuthEnvironment = GoogleServiceAccountEnvironment & {
  GOOGLE_DRIVE_ACCESS_TOKEN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
};

/** Production-shaped REST boundary; it remains inert until OAuth and folder bindings are configured. */
export class GoogleDriveCapability implements DriveCapability {
  private cached?: { token: string; expiresAt: number };
  private serviceAccount?: GoogleServiceAccountCredential;
  constructor(private readonly env: DriveAuthEnvironment, private readonly fetchLike: typeof fetch = fetch, private readonly now: () => number = () => Date.now()) {}
  private serviceCredential(): GoogleServiceAccountCredential {
    return this.serviceAccount ??= new GoogleServiceAccountCredential(this.env, this.fetchLike, this.now);
  }
  private async token(): Promise<string> {
    const hasServiceEmail = Boolean(this.env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
    const hasServiceKey = Boolean(this.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY);
    if (hasServiceEmail !== hasServiceKey) throw { status: 503, configuration: true };
    if (hasServiceEmail && hasServiceKey) return this.serviceCredential().token();
    if (this.env.GOOGLE_DRIVE_ACCESS_TOKEN) return this.env.GOOGLE_DRIVE_ACCESS_TOKEN;
    if (this.cached && this.cached.expiresAt > this.now() + 60_000) return this.cached.token;
    if (!this.env.GOOGLE_CLIENT_ID || !this.env.GOOGLE_CLIENT_SECRET || !this.env.GOOGLE_REFRESH_TOKEN) throw { status: 503 };
    const body = new URLSearchParams({ client_id: this.env.GOOGLE_CLIENT_ID, client_secret: this.env.GOOGLE_CLIENT_SECRET, refresh_token: this.env.GOOGLE_REFRESH_TOKEN, grant_type: "refresh_token" });
    const response = await this.fetchLike("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    if (!response.ok) throw { status: response.status === 429 ? 429 : response.status >= 500 ? response.status : 401 };
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
  // Operational trace only: it intentionally excludes response bodies, URLs, and credentials.
  console.warn("Google Drive sync request failed", { status: status ?? "network", configuration: isRecord(error) && error.configuration === true, phase: isRecord(error) && typeof error.phase === "string" ? error.phase : undefined });
  if (isRecord(error) && error.configuration === true) return { kind: "retryable", code: "drive_configuration_unavailable" };
  if (status === 429 || (status !== undefined && status >= 500 && status <= 599) || error instanceof TypeError) return { kind: "retryable", code: status === 429 ? "drive_rate_limited" : "drive_unavailable", retryAfterMs };
  return { kind: "permanent", code: status && status >= 400 && status < 500 ? "drive_request_rejected" : "drive_invalid_data" };
}

/** Immutable per-event files plus verified aggregate snapshots.  The capability can be backed by Google Drive later. */
export class DriveDestinationAdapter implements DestinationAdapter {
  constructor(private readonly drive: DriveCapability, private readonly eventsParentId: string, private readonly snapshotsParentId: string, private readonly now: () => Date = () => new Date()) {}

  async sync(event: SyncEvent): Promise<SyncOutcome> {
    try {
      if (!this.eventsParentId || !this.snapshotsParentId) return { kind: "retryable", code: "drive_configuration_unavailable" };
      if (event.destination !== "drive" || !event.userId) return { kind: "permanent", code: "invalid_drive_identity" };
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

export function createProductionDriveAdapter(env: DriveAuthEnvironment & { DRIVE_EVENTS_PARENT_ID?: string; DRIVE_SNAPSHOTS_PARENT_ID?: string }): DestinationAdapter {
  return new DriveDestinationAdapter(new GoogleDriveCapability(env), env.DRIVE_EVENTS_PARENT_ID ?? "", env.DRIVE_SNAPSHOTS_PARENT_ID ?? "");
}

const productionAdapterCache = new Map<string, DestinationAdapter>();
const CACHE_LIMIT = 64;
function cacheFingerprint(values: Array<string | undefined>): string {
  // Synchronous SHA-256: cache retains the complete one-way digest, never raw OAuth material.
  const input = new TextEncoder().encode(values.map((value) => `${value?.length ?? 0}:${value ?? ""}`).join("\u0000"));
  const bitLength = input.length * 8; const padded = new Uint8Array(((input.length + 9 + 63) >> 6) << 6); padded.set(input); padded[input.length] = 0x80;
  new DataView(padded.buffer).setUint32(padded.length - 4, bitLength, false);
  const h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  for (let offset = 0; offset < padded.length; offset += 64) { const w = new Uint32Array(64); const view = new DataView(padded.buffer, offset, 64); for (let i=0;i<16;i+=1) w[i]=view.getUint32(i*4,false); for(let i=16;i<64;i+=1){const a=w[i-15],b=w[i-2]; w[i]=(((a>>>7)|(a<<25))^((a>>>18)|(a<<14))^(a>>>3))+w[i-16]+(((b>>>17)|(b<<15))^((b>>>19)|(b<<13))^(b>>>10))+w[i-7];} let [a,b,c,d,e,f,g,hh]=h; for(let i=0;i<64;i+=1){const s1=((e>>>6)|(e<<26))^((e>>>11)|(e<<21))^((e>>>25)|(e<<7));const ch=(e&f)^((~e)&g);const t1=hh+s1+ch+k[i]+w[i];const s0=((a>>>2)|(a<<30))^((a>>>13)|(a<<19))^((a>>>22)|(a<<10));const maj=(a&b)^(a&c)^(b&c); hh=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+s0+maj)>>>0;} h[0]=(h[0]+a)>>>0;h[1]=(h[1]+b)>>>0;h[2]=(h[2]+c)>>>0;h[3]=(h[3]+d)>>>0;h[4]=(h[4]+e)>>>0;h[5]=(h[5]+f)>>>0;h[6]=(h[6]+g)>>>0;h[7]=(h[7]+hh)>>>0; }
  return [...h].map((part) => part.toString(16).padStart(8, "0")).join("");
}
/** Isolate-local only; the key includes every credential/folder identity to prevent cross-env reuse. */
export function cachedProductionDriveAdapter(env: DriveAuthEnvironment & { DRIVE_EVENTS_PARENT_ID?: string; DRIVE_SNAPSHOTS_PARENT_ID?: string }): DestinationAdapter {
  const key = cacheFingerprint([env.GOOGLE_SERVICE_ACCOUNT_EMAIL, env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY, env.GOOGLE_DRIVE_ACCESS_TOKEN, env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REFRESH_TOKEN, env.DRIVE_EVENTS_PARENT_ID, env.DRIVE_SNAPSHOTS_PARENT_ID]);
  let adapter = productionAdapterCache.get(key);
  if (adapter) { productionAdapterCache.delete(key); productionAdapterCache.set(key, adapter); return adapter; }
  adapter = createProductionDriveAdapter(env); productionAdapterCache.set(key, adapter);
  if (productionAdapterCache.size > CACHE_LIMIT) productionAdapterCache.delete(productionAdapterCache.keys().next().value!);
  return adapter;
}
/** Test seam; production cache is module-scoped and bounded. */
export function resetDriveAdapterCacheForTest(): void { productionAdapterCache.clear(); }
