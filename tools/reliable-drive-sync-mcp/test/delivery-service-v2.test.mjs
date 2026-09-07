// T09: the delivery service that turns the local outbox into a reliable
// receipt. Written before the module exists — it must first fail because the
// module is missing, then because the behaviour is missing.
//
// The frozen rules under test:
//   - a power loss after the send leaves the row recoverable, never lost;
//   - a lost cloud response is replayed with the SAME ids and settles on the
//     original receipt (already_recorded), never a second event;
//   - a failed local confirm keeps the cloud-accepted row pending locally;
//   - a confirmed row answers a repeat submit from the local receipt without
//     touching the network;
//   - flushDue delivers at most 20 rows, one HTTP request each;
//   - the wake-up timer starts on the first write and is cancelled on close.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalOutboxV2 } from "../local-outbox-v2.mjs";
import { createDeliveryServiceV2 } from "../delivery-service-v2.mjs";

const CLEANUP = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 };
const USER_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "a0000000-0000-4000-8000-000000000001";

const envelope = (overrides = {}) => ({
  requestId: "req-1",
  namespace: "algorithm",
  eventType: "algorithm.learning.completed",
  payload: { topic: "two-sum" },
  ...overrides
});

const acceptedReceipt = (requestId, eventId = EVENT_ID) => ({
  storageVersion: 2,
  attemptedRequestId: requestId,
  canonicalRequestId: requestId,
  eventId,
  jobId: "job-1",
  userId: USER_ID,
  disposition: "accepted",
  ignoredDuplicate: false,
  cloudPersistence: "d1_committed"
});

// The cloud already had this fact: the alias receipt points back at the
// canonical request and the original event, so no second event is created.
const alreadyRecordedReceipt = (requestId) => ({
  ...acceptedReceipt(requestId),
  canonicalRequestId: "req-1",
  disposition: "already_recorded"
});

function controllableClock(start = "2026-09-07T00:00:00.000Z") {
  let current = Date.parse(start);
  const now = () => new Date(current).toISOString();
  now.advance = (ms) => {
    current += ms;
    return now();
  };
  return now;
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "rds2-delivery-v2-"));
  const handles = [];
  const track = (handle) => {
    handles.push(handle);
    return handle;
  };
  t.after(async () => {
    for (const handle of handles.reverse()) {
      if (typeof handle.close === "function") handle.close();
    }
    await rm(directory, CLEANUP);
  });
  const clock = controllableClock();
  const filename = join(directory, "outbox.sqlite");
  return {
    clock,
    filename,
    open: (owner = "process-a") => track(new LocalOutboxV2({ path: filename, clock, owner }))
  };
}

test("T09 submit keeps the row durable and reports local retention before the cloud answers", async (t) => {
  const { open } = await fixture(t);
  const outbox = open();
  const calls = [];
  const service = createDeliveryServiceV2({
    outbox,
    clock: () => "2026-09-07T00:00:00.000Z",
    send: async (payload) => {
      calls.push(payload.requestId);
      return acceptedReceipt(payload.requestId);
    }
  });
  t.after(() => service.close());

  const result = await service.submit(envelope());
  assert.equal(result.persistence.localOutbox, "pending",
    "before any send the row is local-only");
  assert.equal(result.receipt, null, "no receipt is invented locally");
  assert.deepEqual(calls, [], "submit alone must not send");
  assert.equal(outbox.inspect()[0].state, "pending");
});

test("T09 a power loss after the send leaves the row recoverable, never lost", async (t) => {
  const { open, clock } = await fixture(t);
  const first = open();
  const service = createDeliveryServiceV2({
    outbox: first,
    clock,
    send: async () => {
      // The request reaches the cloud and then the process dies: no confirm.
      throw new Error("process_died_after_send");
    }
  });
  await service.submit(envelope());
  await service.flushDue();
  service.close();
  const survived = first.inspect();
  assert.equal(survived.length, 1, "the row survives a crash after the send");
  assert.notEqual(survived[0].state, "acknowledged", "no receipt is invented for a lost attempt");
  first.close();

  // A restart past the lease re-offers the same row with the same ids.
  clock.advance(60_000);
  const second = open("process-b");
  const replayed = [];
  const restarted = createDeliveryServiceV2({
    outbox: second,
    clock,
    send: async (payload) => {
      replayed.push(payload.requestId);
      return acceptedReceipt(payload.requestId);
    }
  });
  t.after(() => restarted.close());
  await restarted.flushDue();
  assert.deepEqual(replayed, ["req-1"], "the very same request is replayed");
  assert.equal(second.inspect()[0].state, "acknowledged");
});

test("T09 a lost cloud response settles on the original receipt without a second event", async (t) => {
  const { open, clock } = await fixture(t);
  const outbox = open();
  const attempts = [];
  const service = createDeliveryServiceV2({
    outbox,
    clock,
    send: async (payload) => {
      attempts.push(payload.requestId);
      if (attempts.length === 1) throw new Error("response_lost");
      return alreadyRecordedReceipt(payload.requestId);
    }
  });
  t.after(() => service.close());

  await service.submit(envelope());
  await service.flushDue();
  assert.equal(outbox.inspect()[0].state, "pending",
    "an unknown outcome keeps the row, it is never dropped");

  // Past the backoff the very same request is replayed; the cloud recognises
  // the fact and answers with the original receipt.
  clock.advance(30_000);
  await service.flushDue();
  const row = outbox.inspect()[0];
  assert.equal(row.state, "acknowledged", "the replay confirms the original fact");
  assert.equal(row.receipt.eventId, EVENT_ID, "no second event was created");
  assert.equal(row.receipt.disposition, "already_recorded");
  assert.equal(attempts.length, 2, "exactly one replay");
});

test("T09 a failed local confirm keeps the cloud-accepted row instead of losing it", async (t) => {
  const { open, clock } = await fixture(t);
  const outbox = open();
  let confirmCalls = 0;
  // A forwarding stand-in: the service must drive the outbox through its
  // public surface only, never through internals.
  const fragile = {
    enqueue: (value) => outbox.enqueue(value),
    claimDue: (value) => outbox.claimDue(value),
    get: (value) => outbox.get(value),
    fail: (value) => outbox.fail(value),
    close: () => {},
    confirm: (value) => {
      confirmCalls += 1;
      if (confirmCalls === 1) throw new Error("local_confirm_failed");
      return outbox.confirm(value);
    }
  };
  const service = createDeliveryServiceV2({
    outbox: fragile,
    clock,
    send: async (payload) => acceptedReceipt(payload.requestId)
  });
  t.after(() => service.close());

  await service.submit(envelope());
  await service.flushDue();
  const row = outbox.inspect()[0];
  assert.notEqual(row.state, "blocked", "a cloud-accepted row is never parked as a conflict");
  assert.notEqual(row.state, "acknowledged", "the local commit failed, so it is not confirmed yet");
  assert.equal(row.lastErrorCode, "local_confirm_failed");

  // Retrying replays the same ids: the cloud already holds the fact and
  // answers with the very same receipt, so this cannot duplicate anything.
  clock.advance(30_000);
  await service.flushDue();
  assert.equal(outbox.inspect()[0].state, "acknowledged", "the retry closes it out");
});

test("T09 a confirmed row answers a repeat submit from the local receipt without a network call", async (t) => {
  const { open, clock } = await fixture(t);
  const outbox = open();
  let sends = 0;
  const service = createDeliveryServiceV2({
    outbox,
    clock,
    send: async (payload) => {
      sends += 1;
      return acceptedReceipt(payload.requestId);
    }
  });
  t.after(() => service.close());

  await service.submit(envelope());
  await service.flushDue();
  assert.equal(sends, 1);

  const again = await service.submit(envelope());
  assert.equal(sends, 1, "a confirmed row is answered locally");
  assert.equal(again.persistence.localOutbox, "acknowledged");
  assert.equal(again.receipt.eventId, EVENT_ID);
});

test("T09 flushDue delivers at most 20 rows and one HTTP request each", async (t) => {
  const { open } = await fixture(t);
  const outbox = open();
  const seen = [];
  const service = createDeliveryServiceV2({
    outbox,
    clock: () => "2026-09-07T00:00:00.000Z",
    send: async (payload) => {
      seen.push(payload.requestId);
      return acceptedReceipt(payload.requestId);
    }
  });
  t.after(() => service.close());

  for (let index = 0; index < 25; index += 1) {
    await service.submit(envelope({ requestId: `req-${index}` }));
  }
  await service.flushDue();
  assert.equal(seen.length, 20, "one flush carries at most 20 rows");
  assert.equal(new Set(seen).size, 20, "every row is its own HTTP request");
  assert.equal(outbox.inspect().filter((row) => row.state === "acknowledged").length, 20);

  await service.flushDue();
  assert.equal(seen.length, 25, "the remainder goes on the next flush");
});

test("T09 the wake-up timer starts on the first write and is cancelled on close", async (t) => {
  const { open } = await fixture(t);
  const outbox = open();
  const scheduled = [];
  let cancelled = 0;
  const service = createDeliveryServiceV2({
    outbox,
    clock: () => "2026-09-07T00:00:00.000Z",
    send: async (payload) => acceptedReceipt(payload.requestId),
    schedule: (action, ms) => {
      scheduled.push(ms);
      return { unref: () => {}, cancel: () => { cancelled += 1; } };
    }
  });

  assert.deepEqual(scheduled, [], "no timer before anything is written");
  await service.submit(envelope());
  assert.equal(scheduled.length, 1, "the first write arms the timer");

  service.close();
  assert.equal(cancelled, 1, "close cancels the timer");
  assert.equal(service.timerActive, false);
});
