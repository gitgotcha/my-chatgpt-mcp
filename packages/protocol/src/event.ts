export type SyncEvent = {
  schemaVersion: string;
  eventId: string;
  eventKey: string;
  type: string;
  userId: string;
  sourceSkill: string;
  destination: "drive";
  createdAt: string;
  payload: Record<string, unknown>;
};

const requiredStringFields = [
  "schemaVersion",
  "eventId",
  "eventKey",
  "type",
  "userId",
  "sourceSkill",
  "createdAt"
] as const;

export function parseSyncEvent(input: unknown): SyncEvent {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Sync event must be an object");
  }

  const event = input as Record<string, unknown>;
  for (const field of requiredStringFields) {
    if (typeof event[field] !== "string" || event[field].length === 0) {
      throw new TypeError(`Sync event ${field} must be a non-empty string`);
    }
  }

  if (event.destination !== "drive") {
    throw new TypeError('Sync event destination must be "drive"');
  }

  if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
    throw new TypeError("Sync event payload must be an object");
  }

  const eventKey = event.eventKey as string;
  const userId = event.userId as string;
  if (eventKey.split(":", 1)[0] !== userId) {
    throw new TypeError("Sync event eventKey must begin with userId");
  }

  return event as SyncEvent;
}
