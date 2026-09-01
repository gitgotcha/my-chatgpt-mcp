import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalOutbox } from "../local-outbox.mjs";

const envelope = (overrides = {}) => ({
  schemaVersion: "1.2",
  namespace: "system",
  eventType: "system.user-registered",
  identity: { username: "乔炳源" },
  payload: { displayName: "乔炳源" },
  requestId: "request-1",
  ...overrides
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "reliable-drive-sync-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "outbox.sqlite");
  const outbox = new LocalOutbox(filename, () => "2026-09-01T00:00:00.000Z");
  t.after(() => outbox.close());
  return { filename, outbox };
}

test("enqueue is durable and identical requestId retries are idempotent", async (t) => {
  const { filename, outbox } = await fixture(t);
  outbox.enqueue(envelope());
  outbox.enqueue(envelope());
  assert.equal(outbox.listPending().length, 1);
  outbox.close();

  const reopened = new LocalOutbox(filename);
  t.after(() => reopened.close());
  assert.equal(reopened.listPending()[0].requestId, "request-1");
});

test("same requestId with different content is rejected", async (t) => {
  const { outbox } = await fixture(t);
  outbox.enqueue(envelope());
  assert.throws(
    () => outbox.enqueue(envelope({ payload: { displayName: "另一个人" } })),
    /request_id_conflict/
  );
});

test("sending rows recover after restart and only a valid cloud job acknowledgement deletes them", async (t) => {
  const { filename, outbox } = await fixture(t);
  outbox.enqueue(envelope());
  outbox.markSending("request-1");
  assert.equal(outbox.acknowledge("request-1", ""), false);
  outbox.close();

  const reopened = new LocalOutbox(filename);
  t.after(() => reopened.close());
  assert.equal(reopened.listPending()[0].state, "pending");
  reopened.markSending("request-1");
  assert.equal(reopened.acknowledge("request-1", "job-1"), true);
  assert.deepEqual(reopened.listPending(), []);
});

test("identity cache survives restart", async (t) => {
  const { filename, outbox } = await fixture(t);
  outbox.rememberIdentity(" 乔炳源 ", "11111111-1111-4111-8111-111111111111");
  outbox.close();
  const reopened = new LocalOutbox(filename);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.findIdentity("乔炳源"), {
    username: "乔炳源",
    userId: "11111111-1111-4111-8111-111111111111"
  });
});

test("identity cache keeps normalized names case-sensitive", async (t) => {
  const { outbox } = await fixture(t);
  outbox.rememberIdentity("Alice", "11111111-1111-4111-8111-111111111111");
  assert.equal(outbox.findIdentity("alice"), null);
});

test("blocked rows are not retried", async (t) => {
  const { outbox } = await fixture(t);
  outbox.enqueue(envelope());
  outbox.markBlocked("request-1", "identity_mismatch");
  assert.deepEqual(outbox.listPending(), []);
});
