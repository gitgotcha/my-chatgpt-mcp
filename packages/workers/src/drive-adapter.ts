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

type ImmutableEvent = { schemaVersion: string; kind: "event"; userId: string; eventKey: string; event: SyncEvent };
type Snapshot = { schemaVersion: string; kind: "snapshot"; userId: string; sourceEventKeys: string[]; generatedAt: string; events: SyncEvent[] };

function eventName(event: SyncEvent): string { return `event-${encodeURIComponent(event.eventKey)}.json`; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function validEvent(value: unknown, userId: string): value is ImmutableEvent {
  return isRecord(value) && value.kind === "event" && value.schemaVersion === "1" && value.userId === userId && typeof value.eventKey === "string" && isRecord(value.event) && value.eventKey === value.event.eventKey && value.event.userId === userId;
}
function validSnapshot(value: unknown, userId: string, keys: string[]): value is Snapshot {
  return isRecord(value) && value.kind === "snapshot" && value.schemaVersion === "1" && value.userId === userId && typeof value.generatedAt === "string" && Array.isArray(value.sourceEventKeys) && value.sourceEventKeys.every((key) => typeof key === "string") && sameKeys(value.sourceEventKeys, keys);
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
      const complete = candidateSnapshots.filter((file) => file.parentId === this.snapshotsParentId && validSnapshot(file.json, event.userId, keys))
        .sort((a, b) => String((b.json as Snapshot).generatedAt).localeCompare(String((a.json as Snapshot).generatedAt)) || b.id.localeCompare(a.id));
      if (complete.length > 0) return { kind: "success", syncedAt: (complete[0].json as Snapshot).generatedAt };
      const generatedAt = this.now().toISOString();
      const snapshot: Snapshot = { schemaVersion: "1", kind: "snapshot", userId: event.userId, sourceEventKeys: keys, generatedAt, events: keys.map((key) => known.get(key)!) };
      const created = await this.drive.create(this.snapshotsParentId, `snapshot-${generatedAt.replace(/[:.]/g, "-")}-${crypto.randomUUID()}.json`, snapshot);
      const reread = await this.drive.read(created.id);
      if (!reread || reread.parentId !== this.snapshotsParentId || !validSnapshot(reread.json, event.userId, keys)) return { kind: "retryable", code: "snapshot_readback_failed" };
      return { kind: "success", syncedAt: generatedAt };
    } catch (error) { return problem(error); }
  }
}
