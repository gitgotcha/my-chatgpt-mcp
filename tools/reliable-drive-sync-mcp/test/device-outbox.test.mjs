import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDeviceStore } from "../gateway/device-store.mjs";
import { createBusinessTransport } from "../gateway/business-transport.mjs";
import { migrateOutbox } from "../gateway/migrate-outbox.mjs";

const A = "11111111-1111-4111-8111-111111111111";
const EPOCH = "22222222-2222-4222-8222-222222222222";

function envelope(userId = A, requestId = "req-1") {
  return {
    schemaVersion: "1.2",
    namespace: "profile",
    eventType: "profile.evidence.recorded",
    identity: { userId, username: "乔" },
    payload: { domain: "english-learning", event: { schemaVersion: "1.0", eventId: "30000000-0000-4000-8000-000000000001", eventKey: `key-${requestId}`, observedAt: "2026-09-01T10:00:00.000Z", sourceSkill: "english-learning", action: "observe", observations: [{ dimensionKey: "vocabulary", subjectKey: "concurrency", outcome: "stuck", evidence: "evidence", confidence: "high", sourceRef: `conversation:${requestId}` }] } },
    requestId,
    bindingContext: { installationId: "33333333-3333-4333-8333-333333333333", bindingEpoch: EPOCH, bindingRevision: 0, userId }
  };
}

async function fixture(t, { account = A } = {}) {
  const root = await mkdtemp(join(tmpdir(), "rds2-business-transport-"));
  const store = openDeviceStore({ path: join(root, "control.sqlite") });
  store.exclusive(({ db }) => db.prepare("INSERT INTO device_binding(singleton, installation_id, binding_epoch, binding_revision, user_id, credential_ref) VALUES(1, ?, ?, 0, ?, ?)").run("33333333-3333-4333-8333-333333333333", EPOCH, account, `credential.${account}`));
  const calls = [];
  let outbox;
  let delivery;
  const accounts = {
    async authorizeCurrent(expected) {
      calls.push(["authorize", expected]);
      const current = store.current();
      const context = { installationId: current.installationId, bindingEpoch: String(current.bindingEpoch), bindingRevision: current.bindingRevision, userId: current.userId };
      if (JSON.stringify(context) !== JSON.stringify(expected)) throw Object.assign(new Error("binding_changed"), { code: "binding_changed" });
      return { userId: current.userId, username: "乔", context, credential: `secret-${current.userId}`, credentialRef: current.credentialRef };
    }
  };
  const outboxFactory = ({ userId }) => {
    calls.push(["outbox", userId]);
    outbox = { rows: [], enqueue(value) { this.rows.push(value); return { state: "pending", duplicate: false }; }, get: () => null };
    delivery = { async flush() { return { delivered: 0 }; }, close() {} };
    return { outbox, delivery };
  };
  const transport = createBusinessTransport({ deviceStore: store, accounts, outboxFactory, fetchImpl: async (...args) => { calls.push(["fetch", ...args]); return new Response(JSON.stringify({ ok: true }), { status: 200 }); } });
  t.after(async () => { delivery?.close(); store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return { root, store, transport, accounts, calls, get outbox() { return outbox; } };
}

test("T06 business write refuses missing or stale binding before any local enqueue", async (t) => {
  const f = await fixture(t);
  const missing = envelope(); delete missing.bindingContext;
  await assert.rejects(() => f.transport.submit(missing), /binding_context_required/);
  assert.equal(f.outbox, undefined);
});

test("T06 submit captures account A and enqueues under the shared control lock", async (t) => {
  const f = await fixture(t);
  const result = await f.transport.submit(envelope());
  assert.equal(result.persistence.localOutbox, "pending");
  assert.equal(f.outbox.rows[0].identity.userId, A);
  assert.equal(f.outbox.rows[0].bindingContext, undefined);
  assert.equal(f.calls.filter(([kind]) => kind === "fetch").length, 0, "network is not part of local acceptance");
});

test("T06 binding change between authorization and local accept rejects without enqueue", async (t) => {
  const f = await fixture(t);
  const original = f.accounts.authorizeCurrent;
  f.accounts.authorizeCurrent = async (expected) => {
    const result = await original(expected);
    f.store.exclusive(({ db }) => db.prepare("UPDATE device_binding SET binding_epoch = ?, binding_revision = binding_revision + 1 WHERE singleton = 1").run("44444444-4444-4444-8444-444444444444"));
    return result;
  };
  await assert.rejects(() => f.transport.submit(envelope()), /binding_changed/);
  assert.equal(f.outbox, undefined);
});

test("T06 migration copies each owner idempotently and never deletes the source", async (t) => {
  const f = await fixture(t);
  const source = {
    rows: [{ requestId: "legacy-1", envelope: envelope(), state: "pending", attemptCount: 2, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" }],
    inspect() { return this.rows.map((row) => ({ ...row })); }
  };
  const result = migrateOutbox({ source, targetRoot: join(f.root, "migrated"), deviceStore: f.store, clock: () => "2026-09-01T00:00:00.000Z" });
  assert.deepEqual(result, { copied: 1, duplicates: 0, byUser: { [A]: 1 } });
  assert.equal(source.rows.length, 1);
  const again = migrateOutbox({ source, targetRoot: join(f.root, "migrated"), deviceStore: f.store, clock: () => "2026-09-01T00:00:00.000Z" });
  assert.deepEqual(again, { copied: 0, duplicates: 1, byUser: {} });
});

test("T06 migration stops on an ownerless row without creating a guessed target", async (t) => {
  const f = await fixture(t);
  const source = { inspect: () => [{ requestId: "legacy-unknown", envelope: { requestId: "legacy-unknown" }, state: "pending" }] };
  assert.throws(() => migrateOutbox({ source, targetRoot: join(f.root, "migrated"), deviceStore: f.store }), /migration_unknown_owner/);
});
