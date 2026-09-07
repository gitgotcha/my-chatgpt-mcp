// T09: the local durable outbox behind the reliable receipt.
//
// These tests are written BEFORE the module exists: they must fail with
// "module not found" first, and only afterwards with real business
// assertions. The contract comes from the frozen design addendum §10:
//   pending -> sending -> acknowledged | blocked, with explicit transactions;
//   sending carries an owner and a lease, and only EXPIRED leases are
//   recovered — a live process is never robbed; a receipt is acknowledged only
//   after it matches the attempted request id, the identity and the event
//   association; acknowledged rows are retained (30 days) and never take
//   pending/blocked rows with them; pure reads must not create the file.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { LocalOutboxV2 } from "../local-outbox-v2.mjs";

const CLEANUP = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 };
const USER_ID = "11111111-1111-4111-8111-111111111111";

const envelope = (overrides = {}) => ({
  requestId: "req-1",
  namespace: "algorithm",
  eventType: "algorithm.learning.completed",
  payload: { topic: "two-sum" },
  ...overrides
});

// A receipt exactly as the Worker returns it after a committed D1 batch.
const receipt = (overrides = {}) => ({
  storageVersion: 2,
  attemptedRequestId: "req-1",
  canonicalRequestId: "req-1",
  eventId: "a0000000-0000-4000-8000-000000000001",
  jobId: "job-1",
  userId: USER_ID,
  disposition: "accepted",
  ignoredDuplicate: false,
  cloudPersistence: "d1_committed",
  ...overrides
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

// Node runs `t.after` hooks in registration order, so every SQLite handle has
// to be closed inside the same hook that removes the directory: closing in a
// later hook leaves the file locked on Windows and `rm` fails with EBUSY.
async function fixture(t, { owner = "process-a" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "rds2-outbox-v2-"));
  const handles = [];
  const track = (handle) => {
    handles.push(handle);
    return handle;
  };
  const clock = controllableClock();
  t.after(async () => {
    for (const handle of handles.reverse()) handle.close();
    await rm(directory, CLEANUP);
  });
  return {
    directory,
    clock,
    filename: join(directory, "outbox.sqlite"),
    open: (nextOwner = owner) => track(new LocalOutboxV2({
      path: join(directory, "outbox.sqlite"),
      clock,
      owner: nextOwner
    }))
  };
}

test("T09 the outbox uses explicit transactions and never db.transaction", async (t) => {
  // Portability first: node:sqlite has no `transaction` helper on either
  // supported runtime, so any implementation relying on it cannot exist.
  assert.equal(typeof DatabaseSync.prototype.transaction, "undefined",
    "node:sqlite exposes no transaction helper — BEGIN IMMEDIATE is mandatory");
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../local-outbox-v2.mjs", import.meta.url), "utf8"));
  assert.doesNotMatch(source, /\.transaction\s*\(/,
    "the outbox must open its own BEGIN IMMEDIATE transactions");
  assert.match(source, /BEGIN IMMEDIATE/);
});

test("T09 enqueue is durable and an identical resubmit is idempotent", async (t) => {
  const { open, clock } = await fixture(t);
  const outbox = open();
  outbox.enqueue(envelope());
  outbox.enqueue(envelope());
  const claimed = outbox.claimDue({ limit: 20 });
  assert.equal(claimed.length, 1, "the same envelope is stored once");
  assert.equal(claimed[0].requestId, "req-1");
  assert.equal(claimed[0].state, "sending");
  assert.equal(claimed[0].leaseOwner, "process-a");
  assert.ok(claimed[0].leaseUntil > clock(), "a claim carries a live lease");
});

test("T09 the same requestId with different content is blocked, never overwritten", async (t) => {
  const { open } = await fixture(t);
  const outbox = open();
  outbox.enqueue(envelope());
  outbox.enqueue(envelope({ payload: { topic: "another-topic" } }));

  const claimed = outbox.claimDue({ limit: 20 });
  assert.deepEqual(claimed.map((row) => row.requestId), [],
    "a conflicting resubmit must not be delivered");
  const rows = outbox.inspect();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "blocked", "the conflict is parked for a human");
  assert.equal(rows[0].lastErrorCode, "request_id_conflict");
});

test("T09 a live lease on another process is never stolen", async (t) => {
  const { open } = await fixture(t);
  const first = open("process-a");
  first.enqueue(envelope());
  assert.equal(first.claimDue({ limit: 20 }).length, 1);

  const second = open("process-b");
  assert.deepEqual(second.claimDue({ limit: 20 }), [],
    "process-b must not take a row whose lease is still live");
  assert.equal(second.inspect()[0].state, "sending");
  assert.equal(second.inspect()[0].leaseOwner, "process-a");
});

test("T09 only an EXPIRED sending lease is recovered", async (t) => {
  const { open, clock } = await fixture(t);
  const first = open("process-a");
  first.enqueue(envelope());
  first.claimDue({ limit: 20 });

  const second = open("process-b");
  // Still inside the lease: nothing to deliver.
  clock.advance(5_000);
  assert.deepEqual(second.claimDue({ limit: 20 }), []);

  // Past the lease: the row is recovered and offered again.
  clock.advance(30_000);
  const recovered = second.claimDue({ limit: 20 });
  assert.equal(recovered.length, 1, "an expired lease is recovered");
  assert.equal(recovered[0].leaseOwner, "process-b");
  assert.equal(recovered[0].attemptCount, 2, "the redelivery counts as an attempt");
});

test("T09 confirm acknowledges only a receipt that matches the attempt, identity and event", async (t) => {
  const { open } = await fixture(t);
  const outbox = open();
  outbox.enqueue(envelope());
  outbox.claimDue({ limit: 20 });

  // A receipt for another request must never acknowledge this row.
  assert.throws(
    () => outbox.confirm(receipt({ attemptedRequestId: "req-other" })),
    (error) => error.code === "receipt_mismatch"
  );
  // Nor one that never reached D1.
  assert.throws(
    () => outbox.confirm(receipt({ cloudPersistence: "unknown" })),
    (error) => error.code === "receipt_mismatch"
  );
  assert.equal(outbox.inspect()[0].state, "sending", "a rejected receipt changes nothing");

  const result = outbox.confirm(receipt());
  assert.equal(result.acknowledged, true);
  const row = outbox.inspect()[0];
  assert.equal(row.state, "acknowledged");
  assert.equal(row.receipt.eventId, "a0000000-0000-4000-8000-000000000001");
});

test("T09 acknowledged rows are retained and purging never touches pending or blocked", async (t) => {
  const { open, clock } = await fixture(t);
  const outbox = open();
  // Settle one row first: claiming later would also pick up the pending row
  // we want to keep pending.
  outbox.enqueue(envelope({ requestId: "req-ack" }));
  outbox.claimDue({ limit: 20 });
  outbox.confirm(receipt({ attemptedRequestId: "req-ack", canonicalRequestId: "req-ack" }));
  outbox.enqueue(envelope({ requestId: "req-pending" }));
  outbox.enqueue(envelope({ requestId: "req-blocked" }));
  outbox.fail({ requestId: "req-blocked", code: "request_id_conflict" });

  // Fresh acknowledgements survive a purge and a restart.
  clock.advance(60 * 60 * 1000);
  assert.equal(outbox.purgeAcknowledged({ limit: 100 }), 0, "nothing is old enough yet");
  assert.equal(outbox.inspect().filter((row) => row.state === "acknowledged").length, 1);

  // After the retention window the acknowledged row goes, the others stay.
  clock.advance(31 * 24 * 60 * 60 * 1000);
  assert.equal(outbox.purgeAcknowledged({ limit: 100 }), 1);
  const states = outbox.inspect().map((row) => row.state).sort();
  assert.deepEqual(states, ["blocked", "pending"], "pending and blocked are never purged");
});

test("T09 the first failure is backed off 30 seconds and later failures grow", async (t) => {
  const { open, clock } = await fixture(t);
  const outbox = open();
  outbox.enqueue(envelope());
  outbox.claimDue({ limit: 20 });
  const before = clock();

  outbox.fail({ requestId: "req-1", code: "upstream_unavailable" });
  const row = outbox.inspect()[0];
  assert.equal(row.state, "pending", "a transient failure returns to pending");
  assert.equal(Date.parse(row.availableAt) - Date.parse(before), 30_000,
    "the first retry waits 30 seconds");
  assert.equal(outbox.claimDue({ limit: 20 }).length, 0, "backoff is respected");

  clock.advance(30_000);
  assert.equal(outbox.claimDue({ limit: 20 }).length, 1, "the row comes back when due");
});

test("T09 blocked rows are never redelivered", async (t) => {
  const { open, clock } = await fixture(t);
  const outbox = open();
  outbox.enqueue(envelope());
  outbox.fail({ requestId: "req-1", code: "request_id_conflict" });
  assert.equal(outbox.inspect()[0].state, "blocked");

  clock.advance(24 * 60 * 60 * 1000);
  assert.deepEqual(outbox.claimDue({ limit: 20 }), [], "a blocked row stays put");
});

test("T09 a read-only open does not create the database file", async (t) => {
  const { directory, open } = await fixture(t);
  const filename = join(directory, "outbox.sqlite");
  assert.equal(existsSync(filename), false);

  // Opening for recovery alone must not conjure a file into existence: a
  // machine that only ever reads must stay untouched.
  const reader = open();
  assert.equal(existsSync(filename), true, "the outbox itself is created on open");
  reader.close();

  const absent = join(directory, "nested", "outbox.sqlite");
  const missing = new LocalOutboxV2({ path: absent, clock: () => "2026-09-07T00:00:00.000Z", owner: "probe", readOnly: true });
  assert.equal(existsSync(absent), false, "a pure read must not create the file");
  missing.close();
});

test("T09 a missing parent directory is created on the first write", async (t) => {
  const { directory, open } = await fixture(t);
  const nested = join(directory, "deep", "deeper", "outbox.sqlite");
  const outbox = new LocalOutboxV2({ path: nested, clock: open().clock ?? (() => "2026-09-07T00:00:00.000Z"), owner: "writer" });
  try {
    outbox.enqueue(envelope());
    assert.equal(existsSync(nested), true, "the parent directories are created");
    assert.equal(outbox.inspect()[0].state, "pending");
  } finally {
    outbox.close();
  }
});
