// G2-F1: focused unit tests for the bounded staging-read interface.
//
// The engine — not the reducer — owns the read plan: it validates the shapes,
// merges and dedupes same-kind declarations, judges the per-kind unique key
// count against the page's event count (and an absolute cap of 50), prices
// the WHOLE plan before issuing a single query, and enforces a hard call cap.
// These tests pin that contract directly; the engine-level tests
// (rds2-projection-engine) only exercise plans small enough never to hit it.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { withD1, applySchema } from "./support/rds2-d1.js";
import { createInvocationIo } from "../src/rds2/io/invocation-io.js";
import {
  readStagedWithinBudget, planReadCost,
  STAGING_READ_MAX_CALLS, STAGING_READ_CHUNK, STAGING_READ_MAX_KEYS_PER_KIND
} from "../src/rds2/projection/staging-read.js";

const MIGRATION_SQL = readFileSync(fileURLToPath(
  new URL("../migrations/0006_rds2_v2_tables.sql", import.meta.url)
), "utf8");
const NOW = "2026-09-07T00:00:00.000Z";
const SCOPE = { userId: "u-sr", namespace: "algorithm", projectionName: "learning" };

async function seedRow(rawDb, { userId = SCOPE.userId, generation = 1, rowKind = "topic", rowKey, value = { n: 1 } }) {
  await rawDb.prepare(
    `INSERT INTO rds2_projection_rows (user_id, namespace, projection_name, generation,
       row_kind, row_key, member_key, sort_key, value_json, updated_at)
     VALUES (?, 'algorithm', 'learning', ?, ?, ?, NULL, NULL, ?, ?)`
  ).bind(userId, generation, rowKind, rowKey, JSON.stringify(value), NOW).run();
}

test("F1 planReadCost prices chunks synchronously and rejects bad plans", () => {
  assert.equal(planReadCost({ reads: [] }, 5), 0, "an empty plan costs nothing");
  assert.equal(planReadCost({ reads: [{ rowKind: "topic", rowKeys: ["a"] }] }, 5), 1);
  assert.equal(planReadCost({ reads: [{ rowKind: "topic", rowKeys: Array.from({ length: 33 }, (_, i) => `k${i}`) }] }, 40), 2,
    "33 keys need two chunks of 32");
  assert.equal(planReadCost({
    reads: [
      { rowKind: "topic", rowKeys: Array.from({ length: STAGING_READ_CHUNK }, (_, i) => `t${i}`) },
      { rowKind: "problem", rowKeys: ["p1"] }
    ]
  }, 40), 2, "each rowKind is priced separately");
  assert.throws(
    () => planReadCost({ reads: [{ rowKind: "evidence", rowKeys: ["x"] }] }, 5),
    (error) => error.code === "build_read_kind_rejected",
    "unsupported row kinds are rejected; T11 member/event_activity are explicit exceptions"
  );
  assert.throws(
    () => planReadCost({ reads: [{ rowKind: "topic", rowKeys: [7] }] }, 5),
    (error) => error.code === "build_read_key_invalid",
    "keys must be non-empty strings"
  );
});

test("T12 staging reads expose interview row kinds through the same bounded adapter", async () => {
  await withD1(async (binding, rawDb) => {
    await applySchema(rawDb, MIGRATION_SQL);
    const io = createInvocationIo({ db: rawDb, limit: 24 });
    await seedRow(rawDb, { rowKind: "session", rowKey: "S-1", value: { sessionId: "S-1" } });
    const staged = await readStagedWithinBudget({
      io, scope: SCOPE, stagingGeneration: 1, eventCount: 1,
      plan: { reads: [{ rowKind: "session", rowKeys: ["S-1"] }] }
    });
    assert.deepEqual(staged.session.get("S-1"), { sessionId: "S-1" }, `(${binding}) session row is available`);
  });
});

test("F1 a plan priced over the cap is refused before any query goes out", async () => {
  await withD1(async (binding, rawDb) => {
    await applySchema(rawDb, MIGRATION_SQL);
    const io = createInvocationIo({ db: rawDb, limit: 24 });
    // Plan §2.2 (review P1-3): after the cross-read merge, 165 unique keys on
    // one rowKind exceed the absolute 50-key cap — no eventCount can rescue
    // that. The refusal still happens before a single query goes out.
    const plan = {
      reads: [1, 2, 3, 4, 5].map((group) => ({
        rowKind: "topic",
        rowKeys: Array.from({ length: 33 }, (_, i) => `g${group}-k${i}`)
      }))
    };
    assert.throws(
      () => planReadCost(plan, 165),
      (error) => error.code === "build_read_limit_exceeded"
        && error.detail?.maxKeysPerKind === STAGING_READ_MAX_KEYS_PER_KIND,
      "the per-kind key cap refuses the plan synchronously"
    );
    await assert.rejects(
      () => readStagedWithinBudget({ io, scope: SCOPE, stagingGeneration: 1, eventCount: 165, plan }),
      (error) => error.code === "build_read_limit_exceeded",
      `(${binding}) an over-cap plan must be refused`
    );
    // The event-count bound is independent of the 50 cap: 11 unique keys fit
    // the absolute cap but still exceed a 10-event page.
    const tight = { reads: [{ rowKind: "topic", rowKeys: Array.from({ length: 11 }, (_, i) => `k${i}`) }] };
    assert.throws(
      () => planReadCost(tight, 10),
      (error) => error.code === "build_read_limit_exceeded",
      "unique keys may never exceed the page's event count"
    );
    assert.equal(io.budget.snapshot().used, 0,
      `(${binding}) the refusal must happen before a single query is issued`);
  });
});

test("F1 duplicate keys are deduped before pricing", async () => {
  await withD1(async (binding, rawDb) => {
    await applySchema(rawDb, MIGRATION_SQL);
    const io = createInvocationIo({ db: rawDb, limit: 24 });
    // 40 declared keys, 8 duplicates → 32 unique → exactly one chunk.
    const keys = Array.from({ length: 40 }, (_, i) => `t${i % 32}`);
    const plan = { reads: [{ rowKind: "topic", rowKeys: keys }] };
    assert.equal(planReadCost(plan, 40), 1, "dedupe happens before pricing");
    for (let i = 0; i < 32; i += 1) await seedRow(rawDb, { rowKey: `t${i}`, value: { i } });
    const staged = await readStagedWithinBudget({ io, scope: SCOPE, stagingGeneration: 1, eventCount: 40, plan });
    assert.equal(staged.topic.size, 32, `(${binding}) every unique key is read back`);
    assert.equal(io.budget.snapshot().used, 1, `(${binding}) one chunk is one sub-request`);
  });
});

test("F1 a read that would not fit beside the reserve waits without querying", async () => {
  await withD1(async (binding, rawDb) => {
    await applySchema(rawDb, MIGRATION_SQL);
    const io = createInvocationIo({ db: rawDb, limit: 2 });
    const plan = { reads: [{ rowKind: "topic", rowKeys: ["a", "b"] }] };
    await assert.rejects(
      () => readStagedWithinBudget({ io, scope: SCOPE, stagingGeneration: 1, eventCount: 2, plan }),
      (error) => error.code === "budget_reserve_insufficient",
      `(${binding}) a read that would eat the close-out reserve must wait`
    );
    assert.equal(io.budget.snapshot().used, 0, `(${binding}) nothing was queried`);
  });
});

test("F1 same-kind reads scattered across declarations merge into one deduped read", async () => {
  await withD1(async (binding, rawDb) => {
    await applySchema(rawDb, MIGRATION_SQL);
    const io = createInvocationIo({ db: rawDb, limit: 24 });
    // The review's counter-example: two topic reads declaring the SAME key
    // plus one problem read. Three declarations, but the merged plan is one
    // deduped topic read and one problem read — cost 2, not 3.
    const plan = {
      reads: [
        { rowKind: "topic", rowKeys: ["same"] },
        { rowKind: "topic", rowKeys: ["same"] },
        { rowKind: "problem", rowKeys: ["p"] }
      ]
    };
    assert.equal(planReadCost(plan, 2), 2,
      "same-kind declarations merge and dedupe before pricing");
    await seedRow(rawDb, { rowKey: "same", value: { merged: true } });
    await seedRow(rawDb, { rowKind: "problem", rowKey: "p", value: { n: 1 } });
    const staged = await readStagedWithinBudget({ io, scope: SCOPE, stagingGeneration: 1, eventCount: 2, plan });
    assert.deepEqual(staged.topic.get("same"), { merged: true },
      `(${binding}) the duplicated key is read back once`);
    assert.deepEqual(staged.problem.get("p"), { n: 1 },
      `(${binding}) the other kind still reads its own key`);
    assert.equal(io.budget.snapshot().used, 2,
      `(${binding}) the merged plan costs two sub-requests, not three`);
  });
});

test("P1-4 the only legal empty plan is { reads: [] } — a missing or null reads is refused", async () => {
  await withD1(async (binding, rawDb) => {
    await applySchema(rawDb, MIGRATION_SQL);
    const io = createInvocationIo({ db: rawDb, limit: 24 });
    // Frozen contract (final review P1): the plan is a non-null plain object
    // whose OWN "reads" field is an array. A missing, null or non-array reads
    // is a caller bug — never silently an empty plan. Pricing and execution
    // share the same strict check, so neither can accept what the other
    // refuses.
    const badPlans = [null, undefined, {}, { reads: null }, { reads: undefined }, { reads: 123 }, { reads: "abc" }];
    for (let index = 0; index < badPlans.length; index += 1) {
      const plan = badPlans[index];
      const label = `#${index} ${JSON.stringify(plan)}`;
      assert.throws(
        () => planReadCost(plan, 3),
        (error) => error.code === "build_read_plan_invalid",
        `(${binding}) planReadCost refuses plan ${label}`
      );
      await assert.rejects(
        () => readStagedWithinBudget({ io, scope: SCOPE, stagingGeneration: 1, eventCount: 3, plan }),
        (error) => error.code === "build_read_plan_invalid",
        `(${binding}) readStagedWithinBudget refuses plan ${label}`
      );
    }
    // An INHERITED reads is not an own field: this is the only input that
    // separates the two guards (the field reads fine and is an array, yet the
    // plan does not own it). Without the hasOwnProperty check it would be
    // accepted — which is exactly why it is pinned separately.
    const inherited = Object.create({ reads: ["inherited"] });
    assert.throws(
      () => planReadCost(inherited, 3),
      (error) => error.code === "build_read_plan_invalid",
      `(${binding}) an inherited reads is not an own field`
    );
    await assert.rejects(
      () => readStagedWithinBudget({ io, scope: SCOPE, stagingGeneration: 1, eventCount: 3, plan: inherited }),
      (error) => error.code === "build_read_plan_invalid",
      `(${binding}) the executor rejects an inherited reads too`
    );
    // The one legal empty plan still prices to zero and queries nothing.
    assert.equal(planReadCost({ reads: [] }, 3), 0, "an explicit empty plan is legal");
    const staged = await readStagedWithinBudget({
      io, scope: SCOPE, stagingGeneration: 1, eventCount: 3, plan: { reads: [] }
    });
    assert.equal(staged.topic.size, 0, `(${binding}) an empty plan reads nothing`);
    assert.equal(io.budget.snapshot().used, 0, `(${binding}) nothing was queried`);
  });
});

test("P1-3 malformed plan shapes are rejected with stable codes, never raw TypeErrors", async () => {
  await withD1(async (binding, rawDb) => {
    await applySchema(rawDb, MIGRATION_SQL);
    const io = createInvocationIo({ db: rawDb, limit: 24 });
    for (const badKeys of ["abc", { 0: "a" }, null]) {
      const plan = { reads: [{ rowKind: "topic", rowKeys: badKeys }] };
      assert.throws(
        () => planReadCost(plan, 3),
        (error) => error.code === "build_read_key_invalid",
        `(${binding}) planReadCost rejects rowKeys ${JSON.stringify(badKeys)} stably`
      );
      await assert.rejects(
        () => readStagedWithinBudget({ io, scope: SCOPE, stagingGeneration: 1, eventCount: 3, plan }),
        (error) => error.code === "build_read_key_invalid",
        `(${binding}) readStagedWithinBudget rejects rowKeys ${JSON.stringify(badKeys)} stably`
      );
    }
    // plan.reads itself must be an array (a non-iterable used to throw a raw
    // TypeError from the for..of loop).
    assert.throws(
      () => planReadCost({ reads: 123 }, 3),
      (error) => error.code === "build_read_plan_invalid",
      `(${binding}) plan.reads must be an array`
    );
    // eventCount is part of the contract: missing or malformed is refused
    // deterministically, never priced against an unknown bound.
    for (const badCount of [undefined, "10", -1, 1.5]) {
      assert.throws(
        () => planReadCost({ reads: [] }, badCount),
        (error) => error.code === "build_read_plan_invalid",
        `(${binding}) eventCount ${String(badCount)} must be a safe non-negative integer`
      );
    }
    await assert.rejects(
      () => readStagedWithinBudget({ io, scope: SCOPE, stagingGeneration: 1, plan: { reads: [] } }),
      (error) => error.code === "build_read_plan_invalid",
      `(${binding}) the executor demands eventCount too`
    );
    assert.equal(io.budget.snapshot().used, 0, `(${binding}) nothing was queried`);
  });
});

test("P1-3 51 unique keys over a 50-event page are refused before any query", async () => {
  await withD1(async (binding, rawDb) => {
    await applySchema(rawDb, MIGRATION_SQL);
    const io = createInvocationIo({ db: rawDb, limit: 24 });
    // 51 declared keys, all unique, on a 50-event page: the merged plan is
    // 51 unique topic keys > eventCount — refused with zero queries.
    const keys = Array.from({ length: 51 }, (_, i) => `k${i}`);
    const plan = { reads: [{ rowKind: "topic", rowKeys: keys }] };
    assert.throws(
      () => planReadCost(plan, 50),
      (error) => error.code === "build_read_limit_exceeded"
        && error.detail?.rowKind === "topic" && error.detail?.keys === 51,
      "the pricing itself refuses 51 unique keys on a 50-event page"
    );
    await assert.rejects(
      () => readStagedWithinBudget({ io, scope: SCOPE, stagingGeneration: 1, eventCount: 50, plan }),
      (error) => error.code === "build_read_limit_exceeded",
      `(${binding}) the executor refuses the same bound`
    );
    assert.equal(io.budget.snapshot().used, 0,
      `(${binding}) zero queries went out for the refused plan`);
  });
});

test("P1-3 two same-kind declarations totalling 51 unique keys are refused too", async () => {
  await withD1(async (binding, rawDb) => {
    await applySchema(rawDb, MIGRATION_SQL);
    const io = createInvocationIo({ db: rawDb, limit: 24 });
    // Scattering the same excess across declarations changes nothing: the cap
    // is judged on the MERGED unique key count, after dedupe.
    const plan = {
      reads: [
        { rowKind: "topic", rowKeys: Array.from({ length: 25 }, (_, i) => `a${i}`) },
        { rowKind: "topic", rowKeys: Array.from({ length: 26 }, (_, i) => `b${i}`) }
      ]
    };
    assert.throws(
      () => planReadCost(plan, 50),
      (error) => error.code === "build_read_limit_exceeded",
      "the merged count is what the cap judges"
    );
    await assert.rejects(
      () => readStagedWithinBudget({ io, scope: SCOPE, stagingGeneration: 1, eventCount: 50, plan }),
      (error) => error.code === "build_read_limit_exceeded",
      `(${binding}) scattered excess is refused like a single excess read`
    );
    assert.equal(io.budget.snapshot().used, 0,
      `(${binding}) zero queries went out for the refused plan`);
  });
});

test("P1-3 many duplicate declarations under the event count still merge and execute", async () => {
  await withD1(async (binding, rawDb) => {
    await applySchema(rawDb, MIGRATION_SQL);
    const io = createInvocationIo({ db: rawDb, limit: 24 });
    // Five declarations of the SAME 10 keys on a 10-event page: the merged
    // plan is 10 unique keys — legal — and costs exactly one chunk.
    for (let i = 0; i < 10; i += 1) await seedRow(rawDb, { rowKey: `t${i}`, value: { i } });
    const keys = Array.from({ length: 10 }, (_, i) => `t${i}`);
    const plan = { reads: [1, 2, 3, 4, 5].map(() => ({ rowKind: "topic", rowKeys: keys })) };
    assert.equal(planReadCost(plan, 10), 1,
      "five declarations of the same 10 keys merge to one chunk");
    const staged = await readStagedWithinBudget({ io, scope: SCOPE, stagingGeneration: 1, eventCount: 10, plan });
    assert.equal(staged.topic.size, 10, `(${binding}) every unique key is read back once`);
    assert.equal(io.budget.snapshot().used, 1,
      `(${binding}) one merged chunk is one sub-request, whatever the declaration count`);
  });
});

test("F1 the hard call cap is a separate guard from the per-kind key cap", async () => {
  await withD1(async (binding, rawDb) => {
    await applySchema(rawDb, MIGRATION_SQL);
    const io = createInvocationIo({ db: rawDb, limit: 24 });
    // 33 unique topic keys satisfy BOTH key caps on a 40-event page, yet they
    // are two chunks — over a one-call cap. Since the 50-key cap makes the
    // default cap of four unreachable, this input is the only thing that keeps
    // the call-cap guard itself pinned.
    const plan = { reads: [{ rowKind: "topic", rowKeys: Array.from({ length: 33 }, (_, i) => `k${i}`) }] };
    await assert.rejects(
      () => readStagedWithinBudget({ io, scope: SCOPE, stagingGeneration: 1, eventCount: 40, plan, maxCalls: 1 }),
      (error) => error.code === "build_read_limit_exceeded",
      `(${binding}) two chunks over a one-call cap must be refused`
    );
    assert.equal(io.budget.snapshot().used, 0, `(${binding}) nothing was queried`);
    assert.equal(planReadCost(plan, 40), 2, "the same plan is two chunks under the default cap");
  });
});

test("T11 member reads may exceed event count but remain bounded at 50 keys", async () => {
  await withD1(async (binding, rawDb) => {
    await applySchema(rawDb, MIGRATION_SQL);
    const io = createInvocationIo({ db: rawDb, limit: 24 });
    const keys = Array.from({ length: 50 }, (_, i) => `member-${i}`);
    const plan = { reads: [{ rowKind: "member", rowKeys: keys }] };
    assert.equal(planReadCost(plan, 1), 2,
      `(${binding}) one event may legitimately touch up to 50 member keys`);
    const staged = await readStagedWithinBudget({
      io, scope: SCOPE, stagingGeneration: 1, eventCount: 1, plan
    });
    assert.equal(staged.member.size, 0,
      `(${binding}) missing member rows are still a valid bounded read`);
    assert.equal(io.budget.snapshot().used, 2,
      `(${binding}) 50 member keys are two chunks, within the four-call cap`);
  });
});

test("T11 member reads over 50 keys are rejected before querying", async () => {
  await withD1(async (binding, rawDb) => {
    await applySchema(rawDb, MIGRATION_SQL);
    const io = createInvocationIo({ db: rawDb, limit: 24 });
    const plan = { reads: [{ rowKind: "member", rowKeys: Array.from({ length: 51 }, (_, i) => `m-${i}`) }] };
    await assert.rejects(
      () => readStagedWithinBudget({ io, scope: SCOPE, stagingGeneration: 1, eventCount: 1, plan }),
      (error) => error.code === "build_read_limit_exceeded",
      `(${binding}) member keys above the absolute cap are refused`
    );
    assert.equal(io.budget.snapshot().used, 0,
      `(${binding}) the refusal happens before the first query`);
  });
});

test("F1 every staged read binds all four scope segments", async () => {
  await withD1(async (binding, rawDb) => {
    await applySchema(rawDb, MIGRATION_SQL);
    const io = createInvocationIo({ db: rawDb, limit: 24 });
    await seedRow(rawDb, { rowKey: "shared", value: { mine: true } });
    await seedRow(rawDb, { userId: "u-other", rowKey: "shared", value: { mine: false } });
    await seedRow(rawDb, { generation: 2, rowKey: "shared", value: { old: true } });
    await seedRow(rawDb, { rowKind: "problem", rowKey: "shared", value: { problem: true } });

    const staged = await readStagedWithinBudget({
      io, scope: SCOPE, stagingGeneration: 1, eventCount: 1,
      plan: { reads: [{ rowKind: "topic", rowKeys: ["shared"] }] }
    });
    assert.deepEqual(staged.topic.get("shared"), { mine: true },
      `(${binding}) another user's row, another generation's row and another rowKind must not leak`);
    assert.equal(staged.problem.size, 0, `(${binding}) kinds are read separately`);
  });
});
