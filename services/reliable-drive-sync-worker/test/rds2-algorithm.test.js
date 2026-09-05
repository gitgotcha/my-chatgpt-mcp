import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withD1, applySchema } from "./support/rds2-d1.js";
import { createInvocationIo } from "../src/rds2/io/invocation-io.js";
import { acceptEvent } from "../src/rds2/events/accept.js";
import { dispatchOne } from "../src/rds2/tasks/dispatcher.js";
import { projectOne } from "../src/rds2/projection/engine.js";
import { continueBuild, ensureBuild } from "../src/rds2/projection/builds.js";
import {
  algorithmReducer,
  updateTopic,
  latestWins,
  problemIdOf,
  ALGORITHM_ROW_KINDS
} from "../src/rds2/projection/algorithm.js";
import { rebuildAlgorithmProfile } from "../src/algorithm-profile-model.js";

const MIGRATION_SQL = readFileSync(fileURLToPath(
  new URL("../migrations/0006_rds2_v2_tables.sql", import.meta.url)
), "utf8");
const NOW = "2026-09-06T00:00:00.000Z";
const USER = "11111111-1111-4111-8111-111111111111";
const NAME = "乔炳源";
const PROJECTION_LIMIT = 24;

function learningEvent({ userId = USER, ...overrides } = {}) {
  const eventId = overrides.eventId ?? "44444444-4444-4444-8444-444444444444";
  return {
    schemaVersion: "1.2",
    namespace: "algorithm",
    eventType: "algorithm.learning.completed",
    identity: { username: NAME, userId },
    payload: {
      event: {
        schemaVersion: "1.2",
        eventId,
        eventKey: overrides.eventKey ?? `${userId}:algorithm-learning:two-sum:2026-09-06T10:00:00.000Z`,
        eventType: "algorithm.learning.completed",
        userId,
        username: NAME,
        observedAt: overrides.observedAt ?? "2026-09-06T10:00:00.000Z",
        source: "qa",
        topic: overrides.topic ?? "two-sum",
        problem: overrides.problem ?? { title: "Two Sum", source: "Hot100", url: "" },
        outcome: overrides.outcome ?? "consulted",
        evidence: "讲解",
        tags: [],
        confidence: "medium"
      }
    },
    requestId: overrides.requestId ?? `req-${eventId.slice(-4)}-${Math.random().toString(36).slice(2, 8)}`
  };
}

function dailyPlanEvent(requestId, planId) {
  return {
    schemaVersion: "1.2",
    namespace: "algorithm",
    eventType: "algorithm.daily-plan-created",
    identity: { username: NAME, userId: USER },
    payload: {
      event: {
        schemaVersion: "1.2",
        eventId: "55555555-5555-4555-8555-555555555555",
        eventKey: `${USER}:algorithm-plan:2026-09-07:${planId}`,
        eventType: "algorithm.daily-plan-created",
        userId: USER,
        username: NAME,
        localDate: "2026-09-07",
        planId,
        timezone: "Asia/Shanghai",
        generatedAt: "2026-09-07T01:00:00.000Z",
        items: [{ topic: "two-sum", slot: "morning" }]
      }
    },
    requestId
  };
}

async function runAlgorithmTest(body) {
  await withD1(async (binding, rawDb) => {
    await applySchema(rawDb, MIGRATION_SQL);
    const sent = [];
    const makeIo = () => createInvocationIo({
      db: rawDb,
      queues: {
        RDS2_PROJECTION_QUEUE: { send: async (m) => { sent.push(m); } },
        RDS2_ARCHIVE_QUEUE: { send: async (m) => { sent.push(m); } }
      },
      fetchImpl: async () => new Response("{}", { status: 200 }),
      limit: PROJECTION_LIMIT
    });
    await body({ binding, rawDb, sent, makeIo });
  });
}

async function acceptAndProject(makeIo, rawDb, envelope, userId = USER) {
  const receipt = await acceptEvent({
    io: makeIo(), principal: { userId, username: NAME }, envelope, now: NOW
  });
  assert.equal(receipt.disposition, "accepted", JSON.stringify(receipt));
  const taskId = await rawDb.prepare(
    "SELECT task_id FROM rds2_tasks WHERE type = 'projection' AND state = 'pending' ORDER BY created_at DESC, task_id DESC LIMIT 1"
  ).first("task_id");
  await dispatchOne({ io: makeIo(), taskId, owner: "dispatch", now: NOW });
  return projectOne({ io: makeIo(), taskId, owner: "consumer", now: NOW, reducer: algorithmReducer });
}

test("asking for help is not negative mastery evidence", () => {
  assert.deepEqual(updateTopic(null, { outcome: "consulted" }),
    { attempts: 1, negative: 0, positive: 0, neutral: 1 });
});

test("negative and positive outcomes update their own counters", () => {
  assert.deepEqual(updateTopic(null, { outcome: "incorrect" }),
    { attempts: 1, negative: 1, positive: 0, neutral: 0 });
  assert.deepEqual(updateTopic(null, { outcome: "completed" }),
    { attempts: 1, negative: 0, positive: 1, neutral: 0 });
  const mixed = updateTopic(updateTopic(null, { outcome: "stuck" }), { outcome: "correct" });
  assert.deepEqual(mixed, { attempts: 2, negative: 1, positive: 1, neutral: 0 });
});

test("a late older result never overwrites a newer latest", () => {
  const newer = { observedAt: "2026-09-06T12:00:00.000Z", eventId: "b", outcome: "correct" };
  const older = { observedAt: "2026-09-06T10:00:00.000Z", eventId: "a", outcome: "incorrect" };
  assert.equal(latestWins(newer, older), newer);
  assert.equal(latestWins(null, older), older);
  const tieHigh = { observedAt: "2026-09-06T10:00:00.000Z", eventId: "c", outcome: "correct" };
  assert.equal(latestWins(older, tieHigh), tieHigh);
});

test("problemId reuses the source:title rule", () => {
  assert.equal(problemIdOf({ problem: { title: "Two Sum", source: "Hot100" } }), "Hot100:Two Sum");
  assert.equal(problemIdOf({ problem: { title: "Two Sum" } }), "Two Sum");
  assert.equal(problemIdOf({ problem: { title: "  " } }), null);
});

test("a learning event projects exactly the four bounded row kinds", async () => {
  await runAlgorithmTest(async ({ binding, rawDb, makeIo }) => {
    const result = await acceptAndProject(makeIo, rawDb, learningEvent());
    assert.equal(result.outcome, "completed", JSON.stringify(result));
    const rows = await rawDb.prepare(
      `SELECT row_kind, row_key, member_key, value_json FROM rds2_projection_rows
       WHERE user_id = ? AND generation = 0 ORDER BY row_kind, row_key`
    ).bind(USER).all();
    const kinds = rows.results.map((row) => row.row_kind).sort();
    assert.deepEqual(kinds, ["evidence", "problem", "topic", "topic_problem"],
      `(${binding}) a learning event writes exactly its four rows`);
    for (const row of rows.results) {
      assert.ok(ALGORITHM_ROW_KINDS.includes(row.row_kind), `(${binding}) kind ${row.row_kind} is contracted`);
    }
    const topic = JSON.parse(rows.results.find((row) => row.row_kind === "topic").value_json);
    assert.deepEqual(topic, {
      attempts: 1, negative: 0, positive: 0, neutral: 1,
      lastOutcome: "consulted", lastObservedAt: "2026-09-06T10:00:00.000Z",
      lastEventId: "44444444-4444-4444-8444-444444444444"
    });
    const problem = JSON.parse(rows.results.find((row) => row.row_kind === "problem").value_json);
    assert.equal(problem.latest.outcome, "consulted");
    const topicProblem = rows.results.find((row) => row.row_kind === "topic_problem");
    assert.equal(topicProblem.member_key, "two-sum");
    assert.equal(topicProblem.row_key, "Hot100:Two Sum");
    const head = await rawDb.prepare(
      "SELECT summary_json FROM rds2_projections WHERE user_id = ?"
    ).bind(USER).first("summary_json");
    const summary = JSON.parse(head);
    assert.deepEqual(Object.keys(summary).sort(), ["counts", "currentTopic", "headEventId", "identity"],
      `(${binding}) the summary keeps only identity, headEventId, currentTopic and counts`);
    assert.equal(summary.currentTopic, "two-sum");
    assert.equal(summary.counts.neutral, 1);
    assert.ok(!summary.evidence, `(${binding}) the summary never embeds an evidence array`);
  });
});

test("consulted outcomes never create weakness-like rows", async () => {
  await runAlgorithmTest(async ({ binding, rawDb, makeIo }) => {
    await acceptAndProject(makeIo, rawDb, learningEvent({ outcome: "consulted" }));
    const kinds = await rawDb.prepare(
      "SELECT DISTINCT row_kind FROM rds2_projection_rows WHERE user_id = ?"
    ).bind(USER).all();
    for (const row of kinds.results) {
      assert.ok(ALGORITHM_ROW_KINDS.includes(row.row_kind),
        `(${binding}) consulted produced the non-contracted kind ${row.row_kind}`);
    }
    assert.ok(!kinds.results.some((row) => String(row.row_kind).includes("weakness")),
      `(${binding}) consulted must not generate a weakness`);
  });
});

test("a late older event updates counters but not the topic's latest outcome", async () => {
  await runAlgorithmTest(async ({ binding, rawDb, makeIo }) => {
    await acceptAndProject(makeIo, rawDb, learningEvent({
      eventId: "44444444-4444-4444-8444-444444444446",
      eventKey: `${USER}:alg:two-sum:2026-09-06T14:00:00.000Z`,
      observedAt: "2026-09-06T14:00:00.000Z",
      outcome: "correct"
    }));
    await acceptAndProject(makeIo, rawDb, learningEvent({
      eventId: "44444444-4444-4444-8444-444444444447",
      eventKey: `${USER}:alg:two-sum:2026-09-06T08:00:00.000Z`,
      observedAt: "2026-09-06T08:00:00.000Z",
      outcome: "incorrect"
    }));
    const topic = JSON.parse(await rawDb.prepare(
      `SELECT value_json FROM rds2_projection_rows WHERE user_id = ? AND row_kind = 'topic' AND row_key = 'two-sum'`
    ).bind(USER).first("value_json"));
    assert.equal(topic.attempts, 2, `(${binding}) both events count`);
    assert.equal(topic.negative, 1);
    assert.equal(topic.positive, 1);
    assert.equal(topic.lastOutcome, "correct", `(${binding}) the late older result must not overwrite the latest`);
    assert.equal(topic.lastObservedAt, "2026-09-06T14:00:00.000Z");
  });
});

test("a daily plan stores its row without changing the learning counts", async () => {
  await runAlgorithmTest(async ({ binding, rawDb, makeIo }) => {
    await acceptAndProject(makeIo, rawDb, learningEvent());
    const before = JSON.parse(await rawDb.prepare(
      "SELECT summary_json FROM rds2_projections WHERE user_id = ?"
    ).bind(USER).first("summary_json"));
    const result = await acceptAndProject(makeIo, rawDb, dailyPlanEvent("req-plan-1", "plan-2026-09-07"));
    assert.equal(result.outcome, "completed");
    const planRow = await rawDb.prepare(
      `SELECT row_key, member_key FROM rds2_projection_rows WHERE row_kind = 'daily_plan'`
    ).first();
    assert.equal(planRow.row_key, "plan-2026-09-07");
    assert.equal(planRow.member_key, "2026-09-07");
    const after = JSON.parse(await rawDb.prepare(
      "SELECT summary_json FROM rds2_projections WHERE user_id = ?"
    ).bind(USER).first("summary_json"));
    assert.deepEqual(after.counts, before.counts, `(${binding}) a daily plan never adds learning counts`);
    assert.equal(after.headEventId, "55555555-5555-4555-8555-555555555555");
  });
});

test("planning is pure: identical inputs yield identical rows", () => {
  const event = {
    eventSeq: 7,
    eventId: "44444444-4444-4444-8444-444444444444",
    eventKey: "k-1",
    eventType: "algorithm.learning.completed",
    userId: USER,
    username: NAME,
    payload: { event: learningEvent().payload.event }
  };
  const scope = { userId: USER, namespace: "algorithm", projectionName: "learning" };
  const head = { revision: 0, lastEventSeq: 0, activeGeneration: 0, building: 0, summary: null };
  const first = algorithmReducer.plan({ scope, event, head, rows: {} });
  const second = algorithmReducer.plan({ scope, event, head, rows: {} });
  assert.deepEqual(first, second, "the reducer must be pure");
});

test("reading history stays constant while history grows", async () => {
  await runAlgorithmTest(async ({ binding, rawDb, makeIo }) => {
    const measured = [];
    for (const total of [100, 10000, ...(binding === "sqlite" ? [100000] : [])]) {
      const scaleUser = `33333333-0000-4000-8000-${String(total).padStart(12, "0")}`;
      await rawDb.prepare(
        `INSERT INTO rds2_projections (user_id, namespace, projection_name, revision, last_event_seq,
           active_generation, building, summary_json, updated_at)
         VALUES (?, 'algorithm', 'learning', 0, 0, 0, 0, NULL, ?)`
      ).bind(scaleUser, NOW).run();
      // Seed the history in multi-tuple INSERTs. D1 caps bound variables at
      // 100 per statement, so the user id is interpolated (a test-controlled
      // UUID) and only the row key stays bound; 90 tuples per statement.
      const rowsToSeed = total - 1;
      for (let offset = 0; offset < rowsToSeed; offset += 90) {
        const size = Math.min(90, rowsToSeed - offset);
        const values = Array.from({ length: size }, () =>
          `('${scaleUser}', 'algorithm', 'learning', 0, 'topic', ?, 'k', 'k', '{}', '${NOW}')`).join(",");
        const params = Array.from({ length: size }, (_, index) => `hist-${offset + index}`);
        await rawDb.prepare(
          `INSERT INTO rds2_projection_rows (user_id, namespace, projection_name, generation, row_kind, row_key,
             member_key, sort_key, value_json, updated_at) VALUES ${values}`
        ).bind(...params).run();
      }
      // A statement-level spy that accumulates rows_read for SELECTs. Uses
      // bind(...).all() — real D1 rejects inline values on all().
      const stats = { rows: 0 };
      const track = (sqlText, result) => {
        if (/^\s*(SELECT|WITH)/i.test(sqlText)) {
          stats.rows += Number(result?.meta?.rows_read ?? result?.results?.length ?? 0);
        }
        return result;
      };
      const measuredNative = {
        prepare: (sql) => {
          const stmt = rawDb.prepare(sql);
          const make = (bound) => {
            const native = bound && bound.length ? stmt.bind(...bound) : stmt;
            return {
              __sql: sql,
              __bound: bound,
              __native: native,
              bind: (...values) => make(values),
              first: async (...args) => {
                const all = track(sql, await native.all());
                const row = all.results[0] ?? null;
                if (row === null || args.length === 0) return row;
                return row[args[0]] ?? null;
              },
              all: async () => track(sql, await native.all()),
              run: async () => track(sql, await native.run())
            };
          };
          return make([]);
        },
        batch: async (statements) => {
          const results = await rawDb.batch(statements.map((statement) => statement.__native));
          statements.forEach((statement, index) => track(statement.__sql, results[index]));
          return results;
        }
      };
      const measuredIo = createInvocationIo({
        db: measuredNative,
        queues: {
          RDS2_PROJECTION_QUEUE: { send: async () => {} },
          RDS2_ARCHIVE_QUEUE: { send: async () => {} }
        },
        fetchImpl: async () => new Response("{}", { status: 200 }),
        limit: PROJECTION_LIMIT
      });
      await acceptEvent({
        io: makeIo(), principal: { userId: scaleUser, username: NAME }, now: NOW,
        envelope: learningEvent({
          userId: scaleUser,
          requestId: `req-scale-${total}`,
          eventId: `44444444-0000-4000-8000-${String(total).padStart(12, "0")}`
        })
      });
      const taskId = await rawDb.prepare(
        `SELECT task_id FROM rds2_tasks WHERE type = 'projection' AND state = 'pending'
           AND user_id = ? ORDER BY created_at DESC, task_id DESC LIMIT 1`
      ).bind(scaleUser).first("task_id");
      await dispatchOne({ io: makeIo(), taskId, owner: "dispatch", now: NOW });
      await projectOne({ io: measuredIo, taskId, owner: "consumer", now: NOW, reducer: algorithmReducer });
      measured.push({ total, rows: stats.rows });
    }
    const [small, medium, large] = measured;
    assert.equal(medium.rows, small.rows, `(${binding}) rows read must not grow from 100 to 10000`);
    if (large) {
      assert.equal(large.rows, small.rows, `(${binding}) rows read must not grow from 100 to 100000`);
    }
    assert.ok(small.rows <= 16, `(${binding}) a single new event reads a bounded number of rows, got ${small.rows}`);
  });
});

test("the paged rebuild fold matches the V1 oracle on a small fixture", async () => {
  await runAlgorithmTest(async ({ binding, rawDb, makeIo }) => {
    const fixtures = [
      { eventId: "60000000-0000-4000-8000-000000000001", eventKey: "k-1", topic: "two-sum", outcome: "incorrect", observedAt: "2026-09-06T02:00:00.000Z" },
      { eventId: "60000000-0000-4000-8000-000000000002", eventKey: "k-2", topic: "two-sum", outcome: "correct", observedAt: "2026-09-06T05:00:00.000Z" },
      { eventId: "60000000-0000-4000-8000-000000000003", eventKey: "k-3", topic: "three-sum", outcome: "consulted", observedAt: "2026-09-06T03:00:00.000Z" },
      { eventId: "60000000-0000-4000-8000-000000000004", eventKey: "k-4", topic: "two-sum", outcome: "partial", observedAt: "2026-09-06T04:00:00.000Z" },
      { eventId: "60000000-0000-4000-8000-000000000005", eventKey: "k-5", topic: "dp", outcome: "completed", observedAt: "2026-09-06T06:00:00.000Z" }
    ];
    for (const fixture of fixtures) {
      await acceptAndProject(makeIo, rawDb, learningEvent({
        ...fixture,
        requestId: `req-${fixture.eventId.slice(-4)}`
      }));
    }
    // Start a build from the CURRENT head revision and drain its pages.
    const currentHead = await rawDb.prepare(
      "SELECT revision FROM rds2_projections WHERE user_id = ?"
    ).bind(USER).first("revision");
    await ensureBuild({
      db: rawDb, scope: { userId: USER, namespace: "algorithm", projectionName: "learning" },
      baseRevision: Number(currentHead), now: NOW
    });
    let completed = false;
    for (let guard = 0; guard < 8 && !completed; guard += 1) {
      const nextTask = await rawDb.prepare(
        "SELECT task_id FROM rds2_tasks WHERE type = 'projection_build' AND state = 'pending' LIMIT 1"
      ).first("task_id");
      if (!nextTask) break;
      await dispatchOne({ io: makeIo(), taskId: nextTask, owner: "dispatch", now: NOW });
      const result = await continueBuild({
        io: makeIo(), taskId: nextTask, owner: "builder", now: NOW,
        reducer: algorithmReducer, pageSize: 2
      });
      completed = result.outcome === "completed";
    }
    assert.equal(completed, true, `(${binding}) the build activated`);
    const rows = await rawDb.prepare(
      `SELECT row_kind, row_key, value_json FROM rds2_projection_rows
       WHERE user_id = ? AND generation = 1`
    ).bind(USER).all();
    const topicRows = Object.fromEntries(rows.results
      .filter((row) => row.row_kind === "topic")
      .map((row) => [row.row_key, JSON.parse(row.value_json)]));
    const oracle = rebuildAlgorithmProfile(fixtures.map((fixture) => ({
      schemaVersion: "1.2",
      eventId: fixture.eventId,
      eventKey: fixture.eventKey,
      eventType: "algorithm.learning.completed",
      observedAt: fixture.observedAt,
      topic: fixture.topic,
      outcome: fixture.outcome,
      problem: { title: "Two Sum", source: "Hot100" }
    })));
    for (const [topic, mastery] of Object.entries(oracle.topicMastery)) {
      const row = topicRows[topic];
      assert.ok(row, `(${binding}) topic ${topic} must exist in the rebuilt generation`);
      assert.equal(row.attempts, mastery.attempts);
      assert.equal(row.negative, mastery.negative);
      assert.equal(row.positive, mastery.positive);
      assert.equal(row.neutral, mastery.neutral);
      assert.equal(row.lastOutcome, mastery.lastOutcome, `(${binding}) latest outcome matches the oracle for ${topic}`);
      assert.equal(row.lastObservedAt, mastery.lastObservedAt);
    }
  });
});
