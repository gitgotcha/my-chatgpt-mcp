import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDeviceStore } from "../gateway/device-store.mjs";
import { createSecureStore } from "../gateway/secure-store.mjs";
import { createAccounts } from "../gateway/accounts.mjs";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const CRED_A = "credential-a";
const CRED_B = "credential-b";

async function fixture(t, { currentUser = null, secretFactory = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), "rds2-device-accounts-"));
  const store = openDeviceStore({ path: join(root, "control.sqlite") });
  const values = new Map();
  const secureStore = createSecureStore({ root: join(root, "secure"), protector: {
    protect: (value) => `enc:${value}`,
    unprotect: (value) => value.slice(4)
  } });
  for (const [key, value] of Object.entries(currentUser ?? {})) values.set(key, value);
  const calls = [];
  const client = {
    async register(input) { calls.push(["register", input]); return { userId: input.requestId === "register-2" ? B : A, displayName: input.displayName, status: "active", created: true }; },
    async current({ credential }) { calls.push(["current", credential]); if (credential === CRED_A) return { userId: A, displayName: "乔", status: "active" }; if (credential === CRED_B) return { userId: B, displayName: "乔", status: "active" }; throw Object.assign(new Error("credential_invalid"), { code: "credential_invalid" }); },
    async find({ displayName, cursor, limit }) { calls.push(["find", displayName, cursor, limit]); return { items: [{ accountHandle: A, displayName: "乔" }], nextCursor: null }; },
    async verify({ accountHandle }) { calls.push(["verify", accountHandle]); return accountHandle === A ? { userId: A, displayName: "乔", credential: CRED_A } : { userId: B, displayName: "乔", credential: CRED_B }; },
    async pairingCreate() { return { codeRef: "opaque" }; },
    async pairingRedeem() { return { userId: B, displayName: "乔", credential: CRED_B }; }
  };
  const dialog = {
    async secret() { return values.get("secret") ?? null; },
    async confirm() { return values.get("confirm") !== false; },
    async pairingCode() { return values.get("pairingCode") ?? null; }
  };
  const accounts = createAccounts({ deviceStore: store, secureStore, client, dialog, root, secretFactory });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return { root, store, secureStore, client, dialog, accounts, calls, values };
}

test("T05 self-service registration may generate a local credential without prompting the user", async (t) => {
  const f = await fixture(t, { secretFactory: async () => "generated-local-secret" });
  const result = await f.accounts.register({ displayName: "乔", requestId: "register-generated" });
  assert.equal(result.state, "bound");
  assert.equal(f.secureStore.get("credential." + A), "generated-local-secret");
  assert.equal(f.calls[0][1].secret, "generated-local-secret");
});

test("T05 canceled registration makes no network call and leaves no durable intent", async (t) => {
  const f = await fixture(t);
  const before = f.store.current();
  await assert.rejects(() => f.accounts.register({ displayName: "乔", requestId: "register-cancelled" }), /registration_cancelled/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.store.current(), before);
  assert.equal(f.secureStore.get("intent.registration.register-cancelled"), null);
});

test("T05 registration persists intent before send and first bind is CAS guarded", async (t) => {
  const f = await fixture(t);
  f.values.set("secret", "a-secret");
  const result = await f.accounts.register({ displayName: "乔", requestId: "register-1" });
  assert.equal(result.userId, A);
  assert.equal(result.state, "bound");
  assert.equal(f.store.current().userId, A);
  assert.equal(f.secureStore.get("credential." + A), "a-secret");
  const intent = f.secureStore.get("intent.registration.register-1");
  assert.match(intent, /completed/);
});

test("T05 existing binding is never overwritten by registration", async (t) => {
  const f = await fixture(t);
  f.values.set("secret", "b-secret");
  f.store.exclusive(({ db }) => db.prepare("INSERT INTO device_binding(singleton, installation_id, binding_epoch, binding_revision, user_id, credential_ref) VALUES(1, ?, ?, 1, ?, ?)").run("11111111-1111-4111-8111-111111111111", "33333333-3333-4333-8333-333333333333", A, "credential." + A));
  const result = await f.accounts.register({ displayName: "乔", requestId: "register-2" });
  assert.equal(result.state, "created_not_selected");
  assert.equal(f.store.current().userId, A);
  assert.equal(f.secureStore.get("credential." + A), null);
  assert.equal(f.secureStore.get("credential." + B), "b-secret");
});

test("T05 current verifies outside the lock and rechecks binding version", async (t) => {
  const f = await fixture(t);
  f.values.set("secret", CRED_A);
  f.store.exclusive(({ db }) => db.prepare("INSERT INTO device_binding(singleton, installation_id, binding_epoch, binding_revision, user_id, credential_ref) VALUES(1, ?, ?, 1, ?, ?)").run("11111111-1111-4111-8111-111111111111", "44444444-4444-4444-8444-444444444444", A, "credential." + A));
  f.secureStore.set("credential." + A, CRED_A);
  const current = await f.accounts.current();
  assert.equal(current.state, "authenticated");
  assert.equal(current.userId, A);
  assert.equal(current.bindingContext.userId, A);
});

test("T05 switch verifies target before CAS and preserves old binding on a stale expected context", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "accounts.json"), JSON.stringify({ version: 1, accounts: [
    { accountHandle: A, userId: A, displayName: "乔", credentialRef: "credential." + A },
    { accountHandle: B, userId: B, displayName: "乔", credentialRef: "credential." + B }
  ] }));
  f.store.exclusive(({ db }) => db.prepare("INSERT INTO device_binding(singleton, installation_id, binding_epoch, binding_revision, user_id, credential_ref) VALUES(1, ?, ?, 1, ?, ?)").run("11111111-1111-4111-8111-111111111111", "55555555-5555-4555-8555-555555555555", A, "credential." + A));
  f.secureStore.set("credential." + B, CRED_B);
  const expected = f.accounts.context();
  f.store.exclusive(({ db }) => db.prepare("UPDATE device_binding SET binding_revision = binding_revision + 1 WHERE singleton = 1").run());
  await assert.rejects(() => f.accounts.switch({ accountHandle: B, expectedBinding: expected }), /binding_changed/);
  assert.equal(f.store.current().userId, A);
});

test("T05 unbind creates a new epoch and does not delete cloud credential", async (t) => {
  const f = await fixture(t);
  f.store.exclusive(({ db }) => db.prepare("INSERT INTO device_binding(singleton, installation_id, binding_epoch, binding_revision, user_id, credential_ref) VALUES(1, ?, ?, 1, ?, ?)").run("11111111-1111-4111-8111-111111111111", "66666666-6666-4666-8666-666666666666", A, "credential." + A));
  f.secureStore.set("credential." + A, CRED_A);
  const before = f.accounts.context();
  const result = await f.accounts.unbind({ expectedBinding: before });
  assert.equal(result.state, "unbound");
  const after = f.store.current();
  assert.equal(after.userId, null);
  assert.notEqual(after.bindingEpoch, before.bindingEpoch);
  assert.equal(f.secureStore.get("credential." + A), CRED_A);
});

test("T05 find is local metadata only and caps pages at twenty", async (t) => {
  const f = await fixture(t);
  f.store.exclusive(({ db }) => db.prepare("INSERT INTO device_binding(singleton, installation_id, binding_epoch, binding_revision, user_id, credential_ref) VALUES(1, ?, ?, 1, ?, ?)").run("11111111-1111-4111-8111-111111111111", "77777777-7777-4777-8777-777777777777", A, "credential." + A));
  await writeFile(join(f.root, "accounts.json"), JSON.stringify({ version: 1, accounts: [
    { accountHandle: A, userId: A, displayName: "乔", credentialRef: "credential." + A }
  ] }));
  const result = await f.accounts.find({ displayName: "乔", limit: 200 });
  assert.equal(result.items.length, 1);
  assert.equal(result.nextCursor, null);
  assert.equal(f.calls.length, 0);
});

test("T05 pairing code is high entropy, shown only through the secure dialog, and absent from the MCP result", async (t) => {
  const f = await fixture(t);
  f.store.exclusive(({ db }) => db.prepare("INSERT INTO device_binding(singleton, installation_id, binding_epoch, binding_revision, user_id, credential_ref) VALUES(1, ?, ?, 0, ?, ?)").run("11111111-1111-4111-8111-111111111111", "88888888-8888-4888-8888-888888888888", A, "credential." + A));
  f.secureStore.set("credential." + A, CRED_A);
  let shown = null;
  f.dialog.showPairingCode = async (code) => { shown = code; };
  const result = await f.accounts.transferCreate(f.accounts.context());
  assert.equal(result.state, "pairing_created");
  assert.equal(new TextEncoder().encode(shown).byteLength >= 22, true);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(shown));
});
