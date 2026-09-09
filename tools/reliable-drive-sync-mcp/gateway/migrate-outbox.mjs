// T06: one-way, idempotent migration from the legacy shared Outbox to the V2
// per-user stores. The source remains untouched; ambiguity or an unknown owner
// stops the run instead of guessing an account.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LocalOutboxV2 } from "../local-outbox-v2.mjs";

function fail(code, detail) {
  const error = new Error(code);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

function ownerOf(envelope) {
  const id = envelope?.identity?.userId ?? envelope?.payload?.userId ?? envelope?.payload?.event?.userId;
  if (typeof id !== "string" || !id.trim()) throw fail("migration_unknown_owner");
  return id;
}

function rowsOf(source) {
  if (typeof source?.inspect === "function") return source.inspect();
  if (typeof source?.listPending === "function") return source.listPending();
  throw fail("invalid_migration_source");
}

export function migrateOutbox({ source, targetRoot, deviceStore, clock = () => new Date().toISOString(), owner = `migration-${randomUUID()}` } = {}) {
  if (!source || typeof targetRoot !== "string" || !targetRoot.trim()) throw fail("invalid_migration_input");
  if (!deviceStore || typeof deviceStore.exclusive !== "function") throw fail("invalid_device_store");
  mkdirSync(targetRoot, { recursive: true });
  const rows = rowsOf(source);
  const targets = new Map();
  const openTarget = (userId) => {
    if (!targets.has(userId)) {
      const directory = join(targetRoot, userId);
      mkdirSync(directory, { recursive: true });
      targets.set(userId, new LocalOutboxV2({ path: join(directory, "outbox-v2.sqlite"), clock, owner: `${owner}-${userId}` }));
    }
    return targets.get(userId);
  };
  const result = { copied: 0, duplicates: 0, byUser: {} };
  try {
    deviceStore.exclusive(() => {
      for (const row of rows) {
        const userId = ownerOf(row.envelope);
        const imported = openTarget(userId).restore(row);
        if (imported.duplicate) result.duplicates += 1;
        else { result.copied += 1; result.byUser[userId] = (result.byUser[userId] ?? 0) + 1; }
      }
    });
    return result;
  } finally {
    for (const target of targets.values()) target.close();
  }
}

