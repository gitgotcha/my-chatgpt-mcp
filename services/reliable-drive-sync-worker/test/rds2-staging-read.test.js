// G2-F1: focused unit tests for the bounded staging-read interface.
//
// The engine — not the reducer — owns the read plan: it validates, dedupes,
// prices the WHOLE plan before issuing a single query, and enforces a hard
// call cap. These tests pin that contract directly; the engine-level tests
// (rds2-projection-engine) only exercise plans small enough never to hit it.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { withD1, applySchema } from "./support/rds2-d1.js";
import { createInvocationIo } from "../src/rds2/io/invocation-io.js";
import {
  readStagedWithinBudget, planReadCost,
  STAGING_READ_MAX_CALLS, STAGING_READ_CHUNK
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
  assert.equal(planReadCost({ reads: [] }), 0, "an empty plan costs nothing");
  assert.equal(planReadCost({ reads: [{ rowKind: "topic", rowKeys: ["a"] }] }), 1);
  assert.equal(planReadCost({ reads: [{ rowKind: "topic", rowKeys: Array.from({ length: 33 }, (_, i) => `k${i}`) }] }), 2,
    "33 keys need two chunks of 32");
  assert.equal(planReadCost({
    reads: [
      { rowKind: "topic", rowKeys: Array.from({ length: STAGING_READ_CHUNK }, (_, i) => `t${i}`) },
      { rowKind: "problem", rowKeys: ["p1"] }
    ]
  }), 2, "each rowKind is priced separately");
  assert.throws(
    () => planReadCost({ reads: [{ rowKind: "evidence", rowKeys: ["x"] }] }),
    (error) => error.code === "build_read_kind_rejected",
    "only topic/problem may be read back"
  );
  assert.throws(
    () => planReadCost({ reads: [{ rowKind: "topic", rowKeys: [7] }] }),
    (error) => error.code === "build_read_key_invalid",
    "keys must be non-empty strings"
  );
});

test("F1 a plan priced over the cap is refused before any query goes out", async () => {
  await withD1(async (binding, rawDb) => {
    await applySchema(rawDb, MIGRATION_SQL);
    const io = createInvocationIo({ db: rawDb, limit: 24 });
    // Three topic reads of 33 keys each → 6 chunks → 6 calls > 4.
    const plan = {
      reads: [1, 2, 3].map((group) => ({
        rowKind: "topic",
        rowKeys: Array.from({ length: 33 }, (_, i) => `g${group}-k${i}`)
      }))
    };
    assert.equal(planReadCost(plan), 6);
    await assert.rejects(
      () => readStagedWithinBudget({ io, scope: SCOPE, stagingGeneration: 1, plan }),
      (error) => error.code === "build_read_limit_exceeded",
      `(${binding}) an over-cap plan must be refused`
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
    assert.equal(planReadCost(plan), 1, "dedupe happens before pricing");
    for (let i = 0; i < 32; i += 1) await seedRow(rawDb, { rowKey: `t${i}`, value: { i } });
    const staged = await readStagedWithinBudget({ io, scope: SCOPE, stagingGeneration: 1, plan });
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
      () => readStagedWithinBudget({ io, scope: SCOPE, stagingGeneration: 1, plan }),
      (error) => error.code === "budget_reserve_insufficient",
      `(${binding}) a read that would eat the close-out reserve must wait`
    );
    assert.equal(io.budget.snapshot().used, 0, `(${binding}) nothing was queried`);
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
      io, scope: SCOPE, stagingGeneration: 1,
      plan: { reads: [{ rowKind: "topic", rowKeys: ["shared"] }] }
    });
    assert.deepEqual(staged.topic.get("shared"), { mine: true },
      `(${binding}) another user's row, another generation's row and another rowKind must not leak`);
    assert.equal(staged.problem.size, 0, `(${binding}) kinds are read separately`);
  });
});
