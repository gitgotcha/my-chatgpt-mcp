// T05: the local account gateway. It owns only the current-device binding,
// encrypted credential references and non-secret account metadata. All cloud
// calls happen outside the SQLite critical section; the lock is used only for
// a short compare-and-swap of the default binding.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { normalizeName, sameBinding } from "../../../shared/device-binding-protocol.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PAGE = 20;

function fail(code, detail) {
  const error = new Error(code);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

function uuid() {
  return crypto.randomUUID();
}

function checkedUuid(value, code = "invalid_account_handle") {
  if (typeof value !== "string" || !UUID.test(value)) throw fail(code);
  return value;
}

function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function readMetadata(path) {
  if (!existsSync(path)) return { version: 0, accounts: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || !Number.isSafeInteger(parsed.version) || !Array.isArray(parsed.accounts)) throw new Error("bad metadata");
    return { version: parsed.version, accounts: parsed.accounts.filter((item) => item && typeof item.userId === "string") };
  } catch (cause) {
    throw fail("secure_store_unavailable", { cause: String(cause?.message ?? "") });
  }
}

function bindingContext(row) {
  if (!row) return null;
  if (!UUID.test(String(row.installationId)) || !UUID.test(String(row.bindingEpoch))
    || !Number.isSafeInteger(Number(row.bindingRevision)) || Number(row.bindingRevision) < 0) {
    throw fail("secure_store_unavailable");
  }
  return {
    installationId: String(row.installationId),
    bindingEpoch: String(row.bindingEpoch),
    bindingRevision: Number(row.bindingRevision),
    userId: row.userId === null ? null : checkedUuid(String(row.userId), "secure_store_unavailable")
  };
}

function rowToContext(row) {
  return bindingContext(row);
}

function accountEntry(metadata, handle) {
  const item = metadata.accounts.find((candidate) => candidate.userId === handle || candidate.accountHandle === handle);
  if (!item) throw fail("account_not_found");
  return item;
}

function encodeCursor(version, offset) {
  return Buffer.from(JSON.stringify({ version, offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor, version) {
  if (cursor === undefined || cursor === null) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (value.version !== version || !Number.isSafeInteger(value.offset) || value.offset < 0) throw new Error("cursor");
    return value.offset;
  } catch { throw fail("cursor_expired"); }
}

export function createAccounts({ deviceStore, secureStore, client, dialog, root } = {}) {
  if (!deviceStore || typeof deviceStore.current !== "function" || typeof deviceStore.exclusive !== "function") throw fail("invalid_device_store");
  if (!secureStore || typeof secureStore.get !== "function" || typeof secureStore.set !== "function") throw fail("invalid_secure_store");
  if (!client || typeof client !== "object") throw fail("invalid_account_client");
  if (!dialog || typeof dialog !== "object") throw fail("invalid_account_dialog");
  if (typeof root !== "string" || !root.trim()) throw fail("invalid_account_root");
  mkdirSync(root, { recursive: true });
  const metadataPath = join(root, "accounts.json");

  function metadata() { return readMetadata(metadataPath); }
  function persistAccount(entry) {
    const current = metadata();
    const without = current.accounts.filter((item) => item.userId !== entry.userId);
    without.push({ accountHandle: entry.accountHandle ?? entry.userId, userId: entry.userId, displayName: entry.displayName, credentialRef: `credential.${entry.userId}` });
    atomicJson(metadataPath, { version: current.version + 1, accounts: without });
  }
  function ensureBinding() {
    let row = deviceStore.current();
    if (!row) {
      deviceStore.exclusive(({ db }) => {
        if (!db.prepare("SELECT singleton FROM device_binding WHERE singleton = 1").get()) {
          db.prepare("INSERT INTO device_binding(singleton, installation_id, binding_epoch, binding_revision, user_id, credential_ref) VALUES(1, ?, ?, 0, NULL, NULL)").run(uuid(), uuid());
        }
      });
      row = deviceStore.current();
    }
    // T00's initial schema used an integer epoch. Upgrade that one legacy row
    // lazily, without carrying its value into a new binding context.
    if (row && !UUID.test(String(row.bindingEpoch))) {
      deviceStore.exclusive(({ db }) => db.prepare("UPDATE device_binding SET binding_epoch = ?, binding_revision = binding_revision + 1 WHERE singleton = 1").run(uuid()));
      row = deviceStore.current();
    }
    return row;
  }
  function context() { return rowToContext(ensureBinding()); }
  function expectedOrCurrent(expected) {
    const current = context();
    if (!sameBinding(current, expected)) throw fail("binding_changed");
    return current;
  }
  function credentialFor(row) {
    if (!row?.credentialRef) return null;
    return secureStore.get(row.credentialRef);
  }
  async function current() {
    const row = ensureBinding();
    const ctx = rowToContext(row);
    if (ctx.userId === null) return { state: "unbound", userId: null, displayName: null, bindingContext: ctx };
    const credential = credentialFor(row);
    if (!credential) return { state: "reauth_required", userId: ctx.userId, displayName: null, bindingContext: ctx };
    let remote;
    try {
      if (typeof client.current !== "function") throw fail("verification_unavailable");
      remote = await client.current({ credential, userId: ctx.userId });
    } catch (cause) {
      const code = cause?.code ?? "verification_unavailable";
      if (["credential_invalid", "invalid_credential", "unknown_credential", "credential_revoked"].includes(code)) {
        return { state: "reauth_required", userId: ctx.userId, displayName: null, bindingContext: ctx };
      }
      return { state: "verification_unavailable", userId: ctx.userId, displayName: null, bindingContext: ctx };
    }
    const after = rowToContext(ensureBinding());
    if (!sameBinding(ctx, after)) return { state: "binding_changed", userId: after.userId, displayName: null, bindingContext: after };
    if (!remote || remote.userId !== ctx.userId) return { state: "reauth_required", userId: ctx.userId, displayName: null, bindingContext: ctx };
    return { state: "authenticated", userId: ctx.userId, displayName: remote.displayName ?? null, bindingContext: ctx };
  }
  async function authorizeCurrent(expected) {
    const result = await current();
    if (expected && !sameBinding(result.bindingContext, expected)) throw fail("binding_changed");
    if (result.state !== "authenticated") throw fail(result.state === "verification_unavailable" ? "verification_unavailable" : "reauth_required");
    const row = ensureBinding();
    const credential = credentialFor(row);
    return Object.freeze({ userId: result.userId, context: result.bindingContext, credentialRef: row.credentialRef, credential });
  }
  async function register({ displayName, requestId } = {}) {
    const name = normalizeName(displayName);
    if (typeof requestId !== "string" || !requestId.trim()) throw fail("invalid_request_id");
    const intentKey = `intent.registration.${requestId}`;
    let intent = null;
    const encoded = secureStore.get(intentKey);
    if (encoded) { try { intent = JSON.parse(encoded); } catch { throw fail("secure_store_unavailable"); } }
    let secret = intent?.secret;
    if (intent && intent.displayName !== name) throw fail("registration_conflict");
    if (intent?.status === "completed" && intent.result) return { ...intent.result, state: intent.selected ? "bound" : "created_not_selected", replayed: true };
    if (!secret) {
      secret = await dialog.secret({ purpose: "register", displayName: name });
      if (typeof secret !== "string" || !secret) throw fail("registration_cancelled");
      secureStore.set(intentKey, JSON.stringify({ operation: "register", requestId, displayName: name, secret, status: "pending" }));
    }
    // Capture the unbound context before any network call. A concurrent
    // process may bind the device while registration is in flight; that late
    // result must become created_not_selected rather than stealing the new
    // default account.
    const expected = context();
    if (typeof client.register !== "function") throw fail("verification_unavailable");
    const result = await client.register({ displayName: name, requestId, secret });
    checkedUuid(result.userId, "registration_conflict");
    secureStore.set(`credential.${result.userId}`, secret);
    persistAccount(result);
    let selected = false;
    try {
      deviceStore.exclusive(({ db }) => {
        const now = deviceStore.current();
        if (now && now.userId === null && sameBinding(rowToContext(now), expected)) {
          db.prepare("UPDATE device_binding SET binding_epoch = ?, binding_revision = binding_revision + 1, user_id = ?, credential_ref = ? WHERE singleton = 1").run(uuid(), result.userId, `credential.${result.userId}`);
          selected = true;
        }
      });
    } catch (cause) { if (cause?.code === "binding_changed") throw cause; throw cause; }
    const output = { storageVersion: 2, userId: result.userId, displayName: result.displayName ?? name, status: result.status ?? "active", created: result.created !== false, state: selected ? "bound" : "created_not_selected", replayed: result.replayed === true };
    secureStore.set(intentKey, JSON.stringify({ operation: "register", requestId, displayName: name, secret, status: "completed", selected, result: output }));
    return output;
  }
  async function find({ displayName, cursor, limit = MAX_PAGE } = {}) {
    const state = context();
    if (state.userId === null) throw fail("unbound");
    const data = metadata();
    const offset = decodeCursor(cursor, data.version);
    const name = displayName === undefined ? null : normalizeName(displayName);
    const all = data.accounts.filter((item) => !name || item.displayName === name);
    const page = all.slice(offset, offset + Math.min(MAX_PAGE, Math.max(1, Number(limit) || MAX_PAGE)));
    const next = offset + page.length < all.length ? encodeCursor(data.version, offset + page.length) : null;
    return { storageVersion: 2, items: page.map(({ accountHandle, userId, displayName: shown }) => ({ accountHandle, userId, displayName: shown })), nextCursor: next };
  }
  async function verifyTarget(accountHandle) {
    const entry = accountEntry(metadata(), checkedUuid(accountHandle));
    const credential = secureStore.get(entry.credentialRef);
    if (!credential) throw fail("reauth_required");
    if (typeof client.verify !== "function") throw fail("verification_unavailable");
    const remote = await client.verify({ accountHandle: entry.accountHandle ?? entry.userId, credential });
    if (!remote || remote.userId !== entry.userId) throw fail("credential_invalid");
    return { entry, credential };
  }
  async function bind({ accountHandle, expectedBinding } = {}) {
    const target = await verifyTarget(accountHandle);
    const expected = expectedOrCurrent(expectedBinding);
    let selected = false;
    deviceStore.exclusive(({ db }) => {
      const row = deviceStore.current();
      if (!sameBinding(rowToContext(row), expected)) throw fail("binding_changed");
      if (row.userId !== null) return;
      db.prepare("UPDATE device_binding SET binding_epoch = ?, binding_revision = binding_revision + 1, user_id = ?, credential_ref = ? WHERE singleton = 1").run(uuid(), target.entry.userId, target.entry.credentialRef);
      selected = true;
    });
    return { state: selected ? "bound" : "bound_not_selected", userId: target.entry.userId, bindingContext: context() };
  }
  async function switchAccount({ accountHandle, expectedBinding } = {}) {
    const target = await verifyTarget(accountHandle);
    if (typeof dialog.confirm === "function" && !(await dialog.confirm({ purpose: "switch", accountHandle }))) throw fail("switch_cancelled");
    const expected = expectedOrCurrent(expectedBinding);
    deviceStore.exclusive(({ db }) => {
      const row = deviceStore.current();
      if (!sameBinding(rowToContext(row), expected)) throw fail("binding_changed");
      db.prepare("UPDATE device_binding SET binding_epoch = ?, binding_revision = binding_revision + 1, user_id = ?, credential_ref = ? WHERE singleton = 1").run(uuid(), target.entry.userId, target.entry.credentialRef);
    });
    return { state: "bound", userId: target.entry.userId, bindingContext: context() };
  }
  async function unbind({ expectedBinding } = {}) {
    const expected = expectedOrCurrent(expectedBinding);
    if (typeof dialog.confirm === "function" && !(await dialog.confirm({ purpose: "unbind" }))) throw fail("unbind_cancelled");
    deviceStore.exclusive(({ db }) => {
      const row = deviceStore.current();
      if (!sameBinding(rowToContext(row), expected)) throw fail("binding_changed");
      db.prepare("UPDATE device_binding SET binding_epoch = ?, binding_revision = binding_revision + 1, user_id = NULL, credential_ref = NULL WHERE singleton = 1").run(uuid());
    });
    return { state: "unbound", userId: null, bindingContext: context() };
  }
  async function transferCreate(expected) {
    const authorized = await authorizeCurrent(expected);
    if (typeof client.pairingCreate !== "function") throw fail("verification_unavailable");
    const result = await client.pairingCreate({ credential: authorized.credential, userId: authorized.userId });
    if (result?.code && typeof dialog.showPairingCode === "function") await dialog.showPairingCode(result.code, { expiresAt: result.expiresAt });
    return { state: "pairing_created", userId: authorized.userId, expiresAt: result?.expiresAt ?? null };
  }
  async function transferRedeem({ requestId } = {}) {
    if (typeof requestId !== "string" || !requestId.trim()) throw fail("invalid_request_id");
    const code = await dialog.pairingCode({ purpose: "redeem" });
    const secret = await dialog.secret({ purpose: "redeem" });
    if (!code || !secret) throw fail("pairing_cancelled");
    const key = `intent.redeem.${requestId}`;
    secureStore.set(key, JSON.stringify({ operation: "redeem", requestId, code, secret, status: "pending" }));
    if (typeof client.pairingRedeem !== "function") throw fail("verification_unavailable");
    const result = await client.pairingRedeem({ requestId, code, secret });
    checkedUuid(result.userId, "pairing_conflict");
    secureStore.set(`credential.${result.userId}`, secret);
    persistAccount(result);
    const expected = context();
    let selected = false;
    deviceStore.exclusive(({ db }) => {
      const row = deviceStore.current();
      if (row.userId === null && sameBinding(rowToContext(row), expected)) {
        db.prepare("UPDATE device_binding SET binding_epoch = ?, binding_revision = binding_revision + 1, user_id = ?, credential_ref = ? WHERE singleton = 1").run(uuid(), result.userId, `credential.${result.userId}`);
        selected = true;
      }
    });
    const output = { state: selected ? "bound" : "bound_not_selected", userId: result.userId, displayName: result.displayName ?? null };
    secureStore.set(key, JSON.stringify({ operation: "redeem", requestId, code, secret, status: "completed", selected, result: output }));
    return output;
  }
  return { current, find, register, bind, switch: switchAccount, unbind, transferCreate, transferRedeem, authorizeCurrent, context };
}
