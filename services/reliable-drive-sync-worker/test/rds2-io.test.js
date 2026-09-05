import test from "node:test";
import assert from "node:assert/strict";
import { createBudget } from "../src/rds2/io/budget.js";
import { wrapD1, wrapQueue, wrapFetch, createInvocationIo } from "../src/rds2/io/invocation-io.js";
import { withD1 } from "./support/rds2-d1.js";

function countingNative() {
  const native = {
    calls: 0,
    prepare() {
      const statement = {
        bind: () => statement,
        first: async () => { native.calls += 1; return null; },
        all: async () => { native.calls += 1; return { results: [], meta: {} }; },
        run: async () => { native.calls += 1; return { results: [], meta: { changes: 0 } }; }
      };
      return statement;
    }
  };
  return native;
}

test("budget rejects the 41st outbound call before it happens", async () => {
  const native = countingNative();
  const budget = createBudget(40);
  const db = wrapD1(native, budget);
  for (let index = 0; index < 40; index += 1) {
    await db.prepare("select 1").run();
  }
  assert.equal(native.calls, 40);
  await assert.rejects(async () => db.prepare("select 1").run(), (error) => {
    assert.equal(error.code, "budget_exhausted");
    return true;
  });
  assert.equal(native.calls, 40, "the 41st outbound call must never be issued");
  assert.equal(budget.snapshot().used, 40);
});

test("budget limit can be set below the product hard cap", () => {
  const budget = createBudget(20);
  for (let index = 0; index < 20; index += 1) budget.consume("d1");
  assert.equal(budget.remaining(), 0);
  assert.throws(() => budget.consume("queue"), (error) => error.code === "budget_exhausted");
});

test("R5 the business subrequest cap of 40 cannot be configured away", () => {
  assert.throws(() => createBudget(41), (error) => {
    assert.equal(error.message, "invalid_budget_limit");
    return true;
  });
  assert.throws(() => createBudget(50), (error) => error.message === "invalid_budget_limit");
  const budget = createBudget(40);
  assert.equal(budget.snapshot().limit, 40);
  for (let index = 0; index < 40; index += 1) budget.consume("d1");
  assert.throws(() => budget.consume("http"), (error) => error.code === "budget_exhausted");
});

test("failed outbound calls still consume budget", async () => {
  const budget = createBudget(5);
  const statement = {
    bind: () => statement,
    run: async () => { throw new Error("d1_down"); }
  };
  const failing = { prepare: () => statement };
  const db = wrapD1(failing, budget);
  await assert.rejects(async () => db.prepare("update x set y=1").run(), /d1_down/);
  assert.equal(budget.snapshot().used, 1);
  assert.equal(budget.remaining(), 4);
});

test("wrapped statements compose bind, first, all and run", async () => {
  const seen = [];
  const native = {
    prepare: (sql) => {
      const statement = {
        bind: (...values) => { seen.push({ sql, values }); return statement; },
        first: async (...args) => { seen.push({ op: "first", args }); return { id: 7 }; },
        all: async () => { seen.push({ op: "all" }); return { results: [{ id: 7 }], meta: { changes: 0 } }; },
        run: async () => { seen.push({ op: "run" }); return { results: [], meta: { changes: 1 } }; }
      };
      return statement;
    }
  };
  const db = wrapD1(native, { consume: () => {} });
  assert.equal((await db.prepare("select a from t where b=?").bind(1).first()).id, 7);
  assert.equal((await db.prepare("select a from t").all()).results[0].id, 7);
  assert.equal((await db.prepare("insert into t values (1)").run()).meta.changes, 1);
  assert.deepEqual(seen[0], { sql: "select a from t where b=?", values: [1] });
  assert.deepEqual(seen[1], { op: "first", args: [] });
});

test("batch unwraps statements before invoking native D1", async () => {
  const native = { bind() { return this; } };
  let calls = 0;
  const db = wrapD1({
    prepare() { return native; },
    async batch(rows) {
      assert.equal(rows[0], native);
      return [{ results: [{ id: 1 }], meta: { changes: 1 } }];
    }
  }, { consume() { calls++; } });
  const result = await db.batch([db.prepare("select 1").bind()]);
  assert.equal(result[0].results[0].id, 1);
  assert.equal(calls, 1);
});

test("foreign statements are rejected with zero outbound calls", async () => {
  let consumed = 0;
  const budget = { consume: () => { consumed += 1; } };
  const dbA = wrapD1({ prepare: () => ({}), batch: async () => [] }, budget);
  const dbB = wrapD1({ prepare: () => ({}), batch: async () => [] }, budget);
  const foreign = dbA.prepare("select 1");
  await assert.rejects(() => dbB.batch([foreign]), (error) => error.message === "foreign_statement");
  assert.equal(consumed, 0, "a rejected batch must not consume or emit anything");
});

test("empty and oversized batches are rejected before accounting", async () => {
  let consumed = 0;
  const db = wrapD1({ prepare: () => ({}), batch: async () => [] }, { consume: () => { consumed += 1; } });
  await assert.rejects(() => db.batch([]), (error) => error.message === "invalid_batch_size");
  const statements = Array.from({ length: 33 }, () => db.prepare("select 1"));
  await assert.rejects(() => db.batch(statements), (error) => error.message === "invalid_batch_size");
  assert.equal(consumed, 0);
});

test("sqlite and real D1 bindings preserve INSERT RETURNING and SELECT results", async () => {
  await withD1(async (binding, db) => {
    await db.batch([
      db.prepare("CREATE TABLE rds2_io_probe (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT UNIQUE)")
    ]);
    const inserted = await db.batch([
      db.prepare("INSERT INTO rds2_io_probe (v) VALUES (?) RETURNING id").bind("alpha"),
      db.prepare("SELECT id, v FROM rds2_io_probe")
    ]);
    assert.equal(inserted.length, 2);
    assert.equal(inserted[0].results[0].id, 1);
    assert.deepEqual(inserted[1].results, [{ id: 1, v: "alpha" }]);
    const selected = await db.prepare("SELECT v FROM rds2_io_probe WHERE id = ?").bind(1).first("v");
    assert.equal(selected, "alpha");
    const missing = await db.prepare("SELECT v FROM rds2_io_probe WHERE id = ?").bind(99).first();
    assert.equal(missing, null);
    const written = await db.prepare("INSERT INTO rds2_io_probe (v) VALUES (?)").bind("beta").run();
    assert.equal(written.meta.changes, 1);
    assert.deepEqual(written.results, []);
  });
});

test("a failing batch rolls back entirely on both bindings", async () => {
  await withD1(async (binding, db) => {
    await db.batch([
      db.prepare("CREATE TABLE rds2_rollback_probe (id INTEGER PRIMARY KEY, v TEXT UNIQUE)")
    ]);
    await assert.rejects(() => db.batch([
      db.prepare("INSERT INTO rds2_rollback_probe (id, v) VALUES (1, 'ok')"),
      db.prepare("INSERT INTO rds2_rollback_probe (id, v) VALUES (2, 'ok')")
    ]));
    const afterFirstFailure = await db.prepare("SELECT COUNT(*) AS n FROM rds2_rollback_probe").first("n");
    assert.equal(afterFirstFailure, 0, `${binding}: a unique violation inside batch must roll back the whole batch`);
    await db.batch([
      db.prepare("INSERT INTO rds2_rollback_probe (id, v) VALUES (1, 'ok')"),
      db.prepare("INSERT INTO rds2_rollback_probe (id, v) VALUES (2, 'other')")
    ]);
    const count = await db.prepare("SELECT COUNT(*) AS n FROM rds2_rollback_probe").first("n");
    assert.equal(count, 2);
  });
});

test("queue send counts every message against the shared budget", async () => {
  const budget = createBudget(40);
  const sent = [];
  const queue = wrapQueue({ send: async (message) => { sent.push(message); } }, budget);
  await queue.send({ taskId: "t-1" });
  await assert.rejects(async () => {
    for (let index = 0; index < 40; index += 1) budget.consume("queue");
  }, (error) => error.code === "budget_exhausted");
  assert.equal(budget.snapshot().used, 40);
  assert.equal(sent.length, 1);
});

test("budgeted fetch forces manual redirects and rejects 3xx as controlled errors", async () => {
  const budget = createBudget(10);
  const inits = [];
  const fetchImpl = async (input, init) => {
    inits.push(init);
    return new Response(null, { status: 302, headers: { location: "https://elsewhere.example" } });
  };
  const fetcher = wrapFetch(fetchImpl, budget);
  await assert.rejects(() => fetcher("https://drive.example/upload", { method: "POST" }), (error) => {
    assert.equal(error.code, "http_redirect_rejected");
    assert.equal(error.status, 302);
    return true;
  });
  assert.deepEqual(inits.map((init) => init.redirect), ["manual"]);
  assert.equal(budget.snapshot().used, 1);
  assert.equal(budget.snapshot().entries[0].category, "http");
});

test("createInvocationIo wraps db, queues and fetch behind one budget", async () => {
  const native = countingNative();
  const sent = [];
  const io = createInvocationIo({
    db: {
      prepare: (sql) => native.prepare(sql),
      batch: async () => []
    },
    queues: { PROJECTION: { send: async (message) => { sent.push(message); } } },
    fetchImpl: async () => new Response("{}", { status: 200 }),
    limit: 40
  });
  await io.db.prepare("select 1").first();
  await io.queues.PROJECTION.send({ taskId: "t-9" });
  const response = await io.fetch("https://api.example/x");
  assert.equal(response.status, 200);
  const snapshot = io.budget.snapshot();
  assert.deepEqual(snapshot.entries.map((entry) => entry.category), ["d1", "queue", "http"]);
  assert.equal(snapshot.used, 3);
  assert.equal(snapshot.remaining, 37);
  assert.throws(() => io.budget.consume("disk"), (error) => error.message === "unknown_budget_category");
});

test("budget snapshot records category, index and count without payloads", () => {
  const budget = createBudget(3);
  budget.consume("d1");
  budget.consume("http", 2);
  assert.deepEqual(budget.snapshot().entries, [
    { category: "d1", index: 1, count: 1 },
    { category: "http", index: 2, count: 2 }
  ]);
  assert.equal(budget.snapshot().limit, 3);
  assert.equal(budget.snapshot().used, 3);
  assert.throws(() => budget.consume("d1"), (error) => error.code === "budget_exhausted");
});

test("R6 simulator metadata matches real D1 field by field", async () => {
  await withD1(async (binding, db) => {
    await db.batch([db.prepare("CREATE TABLE rds2_meta_probe (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)")]);
    const capture = {};
    const cap = async (label, stmt) => {
      const r = await stmt.all();
      capture[label] = { changes: r.meta.changes, results: r.results, last_row_id: r.meta.last_row_id };
    };
    await cap("read-empty", db.prepare("SELECT COUNT(*) AS n FROM rds2_meta_probe"));
    await cap("insert-returning-1", db.prepare("INSERT INTO rds2_meta_probe (v) VALUES (?) RETURNING id").bind("a"));
    await cap("insert-returning-2", db.prepare("INSERT INTO rds2_meta_probe (v) VALUES (?) RETURNING id").bind("b"));
    await cap("read-two", db.prepare("SELECT COUNT(*) AS n FROM rds2_meta_probe"));
    await cap("update-returning-hit", db.prepare("UPDATE rds2_meta_probe SET v = ? WHERE v = ? RETURNING id").bind("x", "a"));
    await cap("update-returning-miss", db.prepare("UPDATE rds2_meta_probe SET v = ? WHERE v = ? RETURNING id").bind("y", "missing"));
    await cap("delete-returning", db.prepare("DELETE FROM rds2_meta_probe WHERE v = ? RETURNING id").bind("x"));
    await cap("insert-plain", db.prepare("INSERT INTO rds2_meta_probe (v) VALUES (?)").bind("p"));

    // Field-by-field D1 semantics, asserted identically on both bindings:
    assert.equal(capture["read-empty"].changes, 0, `(${binding}) SELECT reports changes 0`);
    assert.deepEqual(capture["read-empty"].results, [{ n: 0 }]);
    assert.equal(capture["insert-returning-1"].changes, 1, `(${binding}) INSERT RETURNING reports its write count`);
    assert.deepEqual(capture["insert-returning-1"].results, [{ id: 1 }]);
    assert.equal(capture["insert-returning-1"].last_row_id, 1, `(${binding}) INSERT RETURNING reports its rowid`);
    assert.equal(capture["insert-returning-2"].changes, 1);
    assert.deepEqual(capture["insert-returning-2"].results, [{ id: 2 }]);
    assert.equal(capture["insert-returning-2"].last_row_id, 2);
    assert.equal(capture["read-two"].changes, 0, `(${binding}) SELECT after writes still reports changes 0`);
    assert.deepEqual(capture["read-two"].results, [{ n: 2 }]);
    assert.equal(capture["update-returning-hit"].changes, 1);
    assert.deepEqual(capture["update-returning-hit"].results, [{ id: 1 }]);
    assert.equal(capture["update-returning-miss"].changes, 0);
    assert.deepEqual(capture["update-returning-miss"].results, []);
    assert.equal(capture["delete-returning"].changes, 1);
    assert.deepEqual(capture["delete-returning"].results, [{ id: 1 }]);
    assert.equal(capture["insert-plain"].changes, 1, `(${binding}) a plain insert reports its write count`);
    assert.deepEqual(capture["insert-plain"].results, []);
  });
});
