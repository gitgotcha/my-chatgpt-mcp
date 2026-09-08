// T00: the machine-local coordination store for the account gateway.
//
// This database deliberately contains only binding metadata. Business
// envelopes, profile data, credentials and tokens belong to other layers and
// must never be copied into this file. The exclusive callback is synchronous
// by contract: the SQLite write transaction is the cross-process mutex.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

function errorWithCode(code, detail) {
  const error = new Error(code);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

function isBusy(error) {
  return /database is locked|database table is locked|busy/i.test(String(error?.message ?? ""));
}

function rollbackQuietly(db) {
  try { db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
}

function normalizeRow(row) {
  if (!row) return null;
  return {
    singleton: Number(row.singleton),
    installationId: row.installation_id,
    bindingEpoch: Number(row.binding_epoch),
    bindingRevision: Number(row.binding_revision),
    userId: row.user_id,
    credentialRef: row.credential_ref
  };
}

class DeviceStore {
  #db;
  #closed = false;

  constructor(path) {
    if (typeof path !== "string" || !path.trim()) throw errorWithCode("invalid_path");
    mkdirSync(dirname(path), { recursive: true });
    try {
      this.#db = new DatabaseSync(path);
      // The timeout is set explicitly rather than relying on a runtime
      // default. A live owner is never stolen; callers get device_busy after
      // the bounded wait instead.
      this.#db.exec("PRAGMA busy_timeout = 5000;");
      this.#db.exec("PRAGMA journal_mode = WAL;");
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS device_binding (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          installation_id TEXT NOT NULL,
          binding_epoch INTEGER NOT NULL CHECK (binding_epoch >= 0),
          binding_revision INTEGER NOT NULL CHECK (binding_revision >= 0),
          user_id TEXT,
          credential_ref TEXT,
          CHECK ((user_id IS NULL AND credential_ref IS NULL)
              OR (user_id IS NOT NULL AND credential_ref IS NOT NULL))
        );
      `);
    } catch (error) {
      try { this.#db?.close(); } catch { /* best effort */ }
      if (isBusy(error)) throw errorWithCode("device_busy");
      throw error;
    }
  }

  #requireOpen() {
    if (this.#closed) throw errorWithCode("device_store_closed");
    return this.#db;
  }

  current() {
    const db = this.#requireOpen();
    try {
      return normalizeRow(db.prepare(
        `SELECT singleton, installation_id, binding_epoch, binding_revision,
                user_id, credential_ref
           FROM device_binding WHERE singleton = 1`
      ).get());
    } catch (error) {
      if (isBusy(error)) throw errorWithCode("device_busy");
      throw error;
    }
  }

  exclusive(action) {
    if (typeof action !== "function") throw errorWithCode("invalid_exclusive_action");
    const db = this.#requireOpen();
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if (isBusy(error)) throw errorWithCode("device_busy");
      throw error;
    }

    try {
      const result = action({ db });
      if (result && typeof result.then === "function") {
        // Do not leave an asynchronously resumed callback attached to an open
        // transaction. Attach a no-op rejection handler before rolling back so
        // a rejected Promise cannot become an unhandled process error.
        result.catch?.(() => {});
        rollbackQuietly(db);
        throw errorWithCode("async_in_device_lock");
      }
      db.exec("COMMIT");
      return result;
    } catch (error) {
      rollbackQuietly(db);
      if (error?.code === "async_in_device_lock") throw error;
      if (isBusy(error)) throw errorWithCode("device_busy");
      throw error;
    }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}

export function openDeviceStore({ path } = {}) {
  return new DeviceStore(path);
}
