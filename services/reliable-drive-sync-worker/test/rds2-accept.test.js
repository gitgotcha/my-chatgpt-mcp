import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withD1, applySchema } from "./support/rds2-d1.js";
import { createInvocationIo } from "../src/rds2/io/invocation-io.js";
import { acceptEvent, lookupIntent, projectionForEventType } from "../src/rds2/events/accept.js";
import { deriveTaskId } from "../src/rds2/events/repository.js";

const MIGRATION_SQL = readFileSync(fileURLToPath(
  new URL("../migrations/0006_rds2_v2_tables.sql", import.meta.url)
), "utf8");
const NOW = "2026-09-05T00:00:00.000Z";
const USER = "11111111-1111-4111-8111-111111111111";
const NAME = "乔炳源";
const EVENT_ID = "44444444-4444-4444-8444-444444444444";
const EVENT_KEY = `${USER}:algorithm-learning:two-sum:2026-09-05T10:00:00.000Z`;
const WRITE_LIMIT = 20;

function algorithmEnvelope(overrides = {}) {
  const event = {
    schemaVersion: "1.2",
    eventId: EVENT_ID,
    eventKey: EVENT_KEY,
    eventType: "algorithm.learning.completed",
    userId: USER,
    username: NAME,
    observedAt: "2026-09-05T10:00:00.000Z",
    source: "qa",
    topic: "two-sum",
    problem: { title: "Two Sum", source: "Hot100", url: "" },
    outcome: "consulted",
    evidence: "用户请求讲解两数之和。",
    tags: ["hash-map"],
    confidence: "medium",
    ...(overrides.event ?? {})
  };
  return {
    schemaVersion: "1.2",
    namespace: "algorithm",
    eventType: "algorithm.learning.completed",
    identity: { username: NAME, userId: USER },
    payload: { event },
    requestId: "req-1",
    ...(overrides.envelope ?? {})
  };
}

function answerScoredEnvelope({ requestId, eventId, localDate = "2026-09-05" }) {
  return {
    schemaVersion: "1.2",
    namespace: "resume-knowledge",
    eventType: "resume-knowledge.answer-scored",
    identity: { username: NAME, userId: USER },
    payload: {
      event: {
        schemaVersion: "1.2",
        eventId,
        eventKey: `${USER}:answer:${localDate}:redis-cache-penetration:${eventId}`,
        eventType: "resume-knowledge.answer-scored",
        userId: USER,
        username: NAME,
        questionKey: "redis-cache-penetration",
        localDate,
        resumeVersion: "resume-2026-09-01-a",
        scoredAt: `${localDate}T02:00:00.000Z`,
        scores: { correctness: 28, completeness: 17.5, structure: 14, resumeRelevance: 10.5 },
        total: 70,
        feedback: {
          strengths: ["说出了布隆过滤器"],
          issues: ["遗漏空值缓存"],
          issueCategories: ["关键点遗漏"],
          answerChain: ["定义", "核心机制", "关键流程"],
          referenceAnswer: "缓存穿透指查询不存在的数据……"
        }
      }
    },
    requestId
  };
}

// A statement that prepares fine on both bindings but always fails when it
// executes (task type CHECK), so injection happens mid-batch, not at prepare.
const FAILING_SQL = `INSERT INTO rds2_tasks
  (task_id, type, user_id, namespace, projection_name, event_seq, state, available_at, created_at, updated_at)
  VALUES ('fault-probe', 'bogus-type', 'u', 'n', 'p', 1, 'pending', '${NOW}', '${NOW}', '${NOW}')`;

function makeIo(db, { failAtIndex = -1, commitLength = 0 } = {}) {
  const state = { commitAttempts: 0, lengths: [] };
  const proxy = {
    prepare: (sql) => db.prepare(sql),
    batch: async (records) => {
      state.lengths.push(records.length);
      if (commitLength && records.length === commitLength) {
        state.commitAttempts += 1;
        if (failAtIndex >= 0) {
          const corrupted = [...records];
          corrupted[failAtIndex] = db.prepare(FAILING_SQL);
          return db.batch(corrupted);
        }
      }
      return db.batch(records);
    }
  };
  const io = createInvocationIo({
    db: proxy,
    queues: {},
    fetchImpl: async () => new Response("{}", { status: 200 }),
    limit: WRITE_LIMIT
  });
  return { io, state };
}

async function runAcceptTest(body) {
  await withD1(async (binding, rawDb) => {
    await applySchema(rawDb, MIGRATION_SQL);
    const queueMessages = [];
    const fetchCalls = [];
    const io = createInvocationIo({
      db: rawDb,
      queues: { PROJECTION: { send: async (message) => queueMessages.push(message) } },
      fetchImpl: async (...args) => { fetchCalls.push(args); return new Response("{}", { status: 200 }); },
      limit: WRITE_LIMIT
    });
    const principal = { userId: USER, username: NAME };
    await body({ binding, rawDb, io, principal, queueMessages, fetchCalls });
  });
}

async function counts(db) {
  const one = async (sql) => Number(await db.prepare(sql).first("n"));
  return {
    events: await one("SELECT COUNT(*) AS n FROM rds2_events"),
    requests: await one("SELECT COUNT(*) AS n FROM rds2_requests"),
    projections: await one("SELECT COUNT(*) AS n FROM rds2_projections"),
    tasks: await one("SELECT COUNT(*) AS n FROM rds2_tasks"),
    deliveries: await one("SELECT COUNT(*) AS n FROM rds2_archive_deliveries"),
    rows: await one("SELECT COUNT(*) AS n FROM rds2_projection_rows"),
    guards: await one("SELECT COUNT(*) AS n FROM rds2_commit_guards")
  };
}

test("one legal write atomically records event, request, projection seed and both tasks", async () => {
  await runAcceptTest(async ({ binding, rawDb, io, principal, envelope: _e, queueMessages, fetchCalls }) => {
    const envelope = algorithmEnvelope();
    const receipt = await acceptEvent({ io, principal, envelope, now: NOW });
    assert.equal(receipt.storageVersion, 2);
    assert.equal(receipt.disposition, "accepted");
    assert.equal(receipt.ignoredDuplicate, false);
    assert.equal(receipt.cloudPersistence, "d1_committed");
    assert.equal(receipt.userId, USER);
    assert.equal(receipt.attemptedRequestId, "req-1");
    assert.equal(receipt.canonicalRequestId, "req-1");
    assert.equal(receipt.eventId, EVENT_ID);

    const state = await counts(rawDb);
    assert.deepEqual(state, {
      events: 1, requests: 1, projections: 1, tasks: 2, deliveries: 1, rows: 0, guards: 0
    });

    const projectionTaskId = await deriveTaskId(
      { userId: USER, namespace: "algorithm", projectionName: projectionForEventType(envelope.eventType, envelope.payload) },
      EVENT_ID, "projection"
    );
    assert.equal(receipt.jobId, projectionTaskId, "jobId is the deterministic projection taskId");
    const taskRow = await rawDb.prepare(
      "SELECT type, event_seq, state, lease_epoch FROM rds2_tasks WHERE task_id = ?"
    ).bind(projectionTaskId).first();
    assert.equal(taskRow.type, "projection");
    assert.equal(taskRow.state, "pending");
    assert.equal(taskRow.lease_epoch, 0);
    const eventSeq = await rawDb.prepare(
      "SELECT event_seq FROM rds2_events WHERE user_id = ? AND event_id = ?"
    ).bind(USER, EVENT_ID).first("event_seq");
    assert.equal(Number(taskRow.event_seq), Number(eventSeq), "task references the event via INSERT...SELECT");

    const archiveTask = await rawDb.prepare(
      "SELECT artifact_id, type FROM rds2_tasks WHERE type = 'archive_event'"
    ).first();
    assert.equal(archiveTask.type, "archive_event");
    const delivery = await rawDb.prepare(
      "SELECT artifact_id, object_type, content_hash, drive_file_id, delivered_at FROM rds2_archive_deliveries"
    ).first();
    assert.equal(archiveTask.artifact_id, delivery.artifact_id);
    assert.equal(delivery.object_type, "event");
    assert.equal(delivery.drive_file_id, null);
    assert.equal(delivery.delivered_at, null);
    assert.equal(delivery.content_hash.length, 64);

    const head = await rawDb.prepare(
      "SELECT revision, last_event_seq, building, summary_json FROM rds2_projections"
    ).first();
    assert.equal(head.revision, 0);
    assert.equal(head.last_event_seq, 0);
    assert.equal(head.building, 0);
    assert.equal(head.summary_json, null);

    const frozen = await rawDb.prepare("SELECT envelope_json, created_by_request FROM rds2_events").first();
    assert.equal(frozen.created_by_request, "req-1");
    assert.ok(frozen.envelope_json.includes('"req-1"'));

    assert.deepEqual(queueMessages, [], "accept must never send Queue messages");
    assert.deepEqual(fetchCalls, [], "accept must never perform HTTP calls");
    assert.equal(io.budget.snapshot().used, 2, `(${binding}) pre-check batch + commit batch`);
  });
});

test("retrying the same requestId after a lost response returns the original receipt", async () => {
  await runAcceptTest(async ({ binding, rawDb, io, principal }) => {
    const envelope = algorithmEnvelope();
    const first = await acceptEvent({ io, principal, envelope, now: NOW });
    const before = await counts(rawDb);
    const second = await acceptEvent({ io, principal, envelope, now: "2026-09-05T00:01:00.000Z" });
    assert.deepEqual(second, first, "the replay must return the identical frozen receipt");
    assert.deepEqual(await counts(rawDb), before, `(${binding}) a replay must not add rows`);
  });
});

test("an event alias adds only a request row and returns already_recorded", async () => {
  await runAcceptTest(async ({ binding, rawDb, io, principal }) => {
    await acceptEvent({ io, principal, envelope: algorithmEnvelope(), now: NOW });
    const alias = await acceptEvent({
      io, principal, now: NOW,
      envelope: algorithmEnvelope({ envelope: { requestId: "req-alias-1" } })
    });
    assert.equal(alias.disposition, "already_recorded");
    assert.equal(alias.ignoredDuplicate, false);
    assert.equal(alias.attemptedRequestId, "req-alias-1");
    assert.equal(alias.canonicalRequestId, "req-1");
    assert.equal(alias.eventId, EVENT_ID);
    const state = await counts(rawDb);
    assert.equal(state.events, 1, `(${binding}) an alias must not create a second event`);
    assert.equal(state.requests, 2, "the alias request row is recorded");
    assert.equal(state.tasks, 2, "no additional tasks are created");
    const aliasRow = await rawDb.prepare(
      "SELECT canonical_event_id FROM rds2_requests WHERE request_id = ?"
    ).bind("req-alias-1").first("canonical_event_id");
    assert.equal(aliasRow, EVENT_ID);
  });
});

test("conflicting submissions return stable 409 codes", async () => {
  await runAcceptTest(async ({ binding, rawDb, io, principal }) => {
    const envelope = algorithmEnvelope();
    await acceptEvent({ io, principal, envelope, now: NOW });

    await assert.rejects(
      () => acceptEvent({
        io, principal, now: NOW,
        envelope: algorithmEnvelope({
          envelope: { requestId: "req-1" },
          event: { outcome: "completed" }
        })
      }),
      (error) => error.code === "request_id_conflict" && error.status === 409,
      `${binding}: same requestId with different envelope must conflict`
    );
    await assert.rejects(
      () => acceptEvent({
        io, principal, now: NOW,
        envelope: algorithmEnvelope({
          envelope: { requestId: "req-4" },
          event: { eventId: EVENT_ID, topic: "two-sum-changed" }
        })
      }),
      (error) => error.code === "event_id_conflict",
      `${binding}: same eventId with different content must conflict`
    );
    await assert.rejects(
      () => acceptEvent({
        io, principal, now: NOW,
        envelope: algorithmEnvelope({
          envelope: { requestId: "req-5" },
          event: { eventId: "44444444-4444-4444-8444-444444444446", eventKey: EVENT_KEY }
        })
      }),
      (error) => error.code === "event_key_conflict",
      `${binding}: same eventKey with different content must conflict`
    );

    // Create a second event, then submit its requestId carrying the first
    // event's content: request -> e2 while eventId/eventKey -> e1.
    await acceptEvent({
      io, principal, now: NOW,
      envelope: algorithmEnvelope({
        envelope: { requestId: "req-2" },
        event: {
          eventId: "44444444-4444-4444-8444-444444444445",
          eventKey: `${USER}:algorithm-learning:three-sum:2026-09-05T10:00:00.000Z`,
          topic: "three-sum"
        }
      })
    });
    await assert.rejects(
      () => acceptEvent({
        io, principal, now: NOW,
        envelope: algorithmEnvelope({
          envelope: { requestId: "req-2" },
          event: { eventId: EVENT_ID, eventKey: EVENT_KEY }
        })
      }),
      (error) => error.code === "identity_of_intent_conflict",
      `${binding}: requestId bound to one event but eventId to another must conflict as identity_of_intent_conflict`
    );
    const state = await counts(rawDb);
    assert.equal(state.events, 2, "no conflicting submission may create additional rows");
  });
});

test("same-day scoring duplicates return the first result as an ignored duplicate", async () => {
  await runAcceptTest(async ({ binding, rawDb, io, principal }) => {
    const first = await acceptEvent({
      io, principal, now: NOW,
      envelope: answerScoredEnvelope({ requestId: "score-1", eventId: "a0000000-0000-4000-8000-000000000004" })
    });
    assert.equal(first.disposition, "accepted");
    const second = await acceptEvent({
      io, principal, now: NOW,
      envelope: answerScoredEnvelope({ requestId: "score-2", eventId: "a0000000-0000-4000-8000-000000000005" })
    });
    assert.equal(second.disposition, "already_recorded");
    assert.equal(second.ignoredDuplicate, true, "a same-day duplicate is an ignored duplicate");
    assert.equal(second.eventId, first.eventId);
    assert.equal(second.jobId, first.jobId);
    assert.equal(second.canonicalRequestId, "score-1");
    assert.equal(second.attemptedRequestId, "score-2");
    const state = await counts(rawDb);
    assert.equal(state.events, 1, `(${binding}) only the first score of the day is stored`);
    assert.equal(state.requests, 2);

    const nextDay = await acceptEvent({
      io, principal, now: NOW,
      envelope: answerScoredEnvelope({
        requestId: "score-3",
        eventId: "a0000000-0000-4000-8000-000000000006",
        localDate: "2026-09-06"
      })
    });
    assert.equal(nextDay.disposition, "accepted", "the next local date is a new first score");
  });
});

test("each injected statement failure rolls back to zero partial rows", async () => {
  await runAcceptTest(async ({ binding, rawDb, envelope: _e, principal }) => {
    const envelope = algorithmEnvelope();
    const measured = makeIo(rawDb);
    await acceptEvent({ io: measured.io, principal, envelope, now: NOW });
    const commitLength = Math.max(...measured.state.lengths);
    assert.ok(commitLength >= 5, `(${binding}) commit batch should carry all inserts`);
    const base = await counts(rawDb);

    for (let index = 0; index < commitLength; index += 1) {
      const variant = algorithmEnvelope({
        envelope: { requestId: `fault-${index}` },
        event: {
          eventId: `55555555-0000-4000-8000-${String(index).padStart(12, "0")}`,
          eventKey: `fault-key-${index}`
        }
      });
      const faulted = makeIo(rawDb, { failAtIndex: index, commitLength });
      await assert.rejects(
        () => acceptEvent({ io: faulted.io, principal, envelope: variant, now: NOW }),
        undefined,
        `(${binding}) failing commit statement ${index} must abort the whole batch`
      );
      assert.equal(faulted.state.commitAttempts, 1, `(${binding}) exactly one commit attempt for statement ${index}`);
      assert.deepEqual(await counts(rawDb), base, `(${binding}) statement ${index} failure must leave zero partial rows`);
    }
  });
});

test("the post-UNIQUE race recheck resolves with the same codes as a pre-check", async () => {
  await runAcceptTest(async ({ binding, rawDb, envelope: _e, principal }) => {
    const baseEnvelope = algorithmEnvelope();
    const cleanIo = () => createInvocationIo({
      db: rawDb, queues: {}, fetchImpl: async () => new Response("{}", { status: 200 }), limit: WRITE_LIMIT
    });

    // Race 1: a concurrent winner submits the identical request before our
    // commit batch runs; the recheck must return the winner's frozen receipt.
    const raceWinner = { receipt: null };
    const racingIo = createInvocationIo({
      db: {
        prepare: (sql) => rawDb.prepare(sql),
        batch: async (records) => {
          if (records.length === 6) {
            raceWinner.receipt = await acceptEvent({
              io: cleanIo(), principal, envelope: baseEnvelope, now: NOW
            });
          }
          return rawDb.batch(records);
        }
      },
      queues: {},
      fetchImpl: async () => new Response("{}", { status: 200 }),
      limit: WRITE_LIMIT
    });
    const raced = await acceptEvent({ io: racingIo, principal, envelope: baseEnvelope, now: NOW });
    assert.ok(raceWinner.receipt);
    assert.deepEqual(raced, raceWinner.receipt, `(${binding}) the race loser must replay the winner's receipt`);

    // Race 2: the concurrent winner used a different requestId with the same
    // event content, so the loser must become an alias with a stable code.
    const aliasContent = {
      eventId: "66666666-0000-4000-8000-000000000002",
      eventKey: "race-alias-key"
    };
    const racingIo2 = createInvocationIo({
      db: {
        prepare: (sql) => rawDb.prepare(sql),
        batch: async (records) => {
          if (records.length === 6) {
            await acceptEvent({
              io: cleanIo(), principal, now: NOW,
              envelope: algorithmEnvelope({ envelope: { requestId: "req-winner-2" }, event: aliasContent })
            });
          }
          return rawDb.batch(records);
        }
      },
      queues: {},
      fetchImpl: async () => new Response("{}", { status: 200 }),
      limit: WRITE_LIMIT
    });
    const racedAlias = await acceptEvent({
      io: racingIo2, principal, now: NOW,
      envelope: algorithmEnvelope({ envelope: { requestId: "req-race-alias" }, event: aliasContent })
    });
    assert.equal(racedAlias.disposition, "already_recorded");
    assert.equal(racedAlias.attemptedRequestId, "req-race-alias");
    assert.equal(racedAlias.canonicalRequestId, "req-winner-2");

    // A direct pre-check sees the same conflict code the recheck produces:
    // resubmit the winner's eventId with different content.
    const preCheckIo = cleanIo();
    let preCheckCode = null;
    try {
      await acceptEvent({
        io: preCheckIo, principal, now: NOW,
        envelope: algorithmEnvelope({
          envelope: { requestId: "req-precheck-conflict" },
          event: { eventId: "66666666-0000-4000-8000-000000000002", eventKey: "race-alias-key", topic: "conflicting-topic" }
        })
      });
    } catch (error) {
      preCheckCode = error.code;
    }
    assert.equal(preCheckCode, "event_id_conflict");

    // Race 3: the concurrent winner wrote the loser's eventId with different
    // content; the loser must surface exactly the pre-check conflict code.
    const loserEvent = {
      eventId: "66666666-0000-4000-8000-000000000003",
      eventKey: "race-conflict-key"
    };
    const racingIo3 = createInvocationIo({
      db: {
        prepare: (sql) => rawDb.prepare(sql),
        batch: async (records) => {
          if (records.length === 6) {
            await acceptEvent({
              io: cleanIo(), principal, now: NOW,
              envelope: algorithmEnvelope({
                envelope: { requestId: "req-winner-3" },
                event: { ...loserEvent, topic: "winner-topic" }
              })
            });
          }
          return rawDb.batch(records);
        }
      },
      queues: {},
      fetchImpl: async () => new Response("{}", { status: 200 }),
      limit: WRITE_LIMIT
    });
    await assert.rejects(
      () => acceptEvent({
        io: racingIo3, principal, now: NOW,
        envelope: algorithmEnvelope({
          envelope: { requestId: "req-loser-3" },
          event: { ...loserEvent, topic: "loser-topic" }
        })
      }),
      (error) => {
        assert.equal(error.code, preCheckCode, `(${binding}) the post-UNIQUE recheck must return the same code`);
        return true;
      }
    );
  });
});

test("oversized envelopes are rejected before any D1 call", async () => {
  await runAcceptTest(async ({ binding, rawDb, envelope: _e, principal }) => {
    const io = createInvocationIo({
      db: rawDb, queues: {}, fetchImpl: async () => { throw new Error("unused"); }, limit: WRITE_LIMIT
    });
    const bigEnvelope = algorithmEnvelope({
      event: { evidence: "x".repeat(256 * 1024 + 1) }
    });
    await assert.rejects(
      () => acceptEvent({ io, principal, envelope: bigEnvelope, now: NOW }),
      (error) => error.code === "payload_too_large"
    );
    assert.equal(io.budget.snapshot().used, 0, `(${binding}) the rejection must consume zero I/O`);
    assert.deepEqual(await counts(rawDb), {
      events: 0, requests: 0, projections: 0, tasks: 0, deliveries: 0, rows: 0, guards: 0
    });
  });
});

test("non-write submissions are rejected by the accept entry", async () => {
  await runAcceptTest(async ({ binding, rawDb, principal }) => {
    const io = createInvocationIo({
      db: rawDb, queues: {}, fetchImpl: async () => { throw new Error("unused"); }, limit: WRITE_LIMIT
    });
    await assert.rejects(
      () => acceptEvent({
        io, principal, now: NOW,
        envelope: { schemaVersion: "1.2", namespace: "system", eventType: "system.capabilities.read", payload: {}, requestId: "r-read" }
      }),
      (error) => error.code === "read_only_event"
    );
    await assert.rejects(
      () => acceptEvent({
        io, principal, now: NOW,
        envelope: {
          schemaVersion: "1.2", namespace: "system", eventType: "system.legacy-migration-requested",
          payload: { displayName: NAME, mode: "dry-run" }, requestId: "r-mig"
        }
      }),
      (error) => error.code === "migration_disabled"
    );
    await assert.rejects(
      () => acceptEvent({
        io, principal, now: NOW,
        envelope: {
          schemaVersion: "1.2", namespace: "system", eventType: "system.user-registered",
          payload: { displayName: NAME }, requestId: "r-admin"
        }
      }),
      (error) => error.code === "unsupported_write_type"
    );
    assert.equal(binding, binding);
  });
});

test("lookupIntent exposes the four idempotency rows and one head is seeded per scope", async () => {
  await runAcceptTest(async ({ binding, rawDb, envelope: _e, principal }) => {
    const envelope = algorithmEnvelope();
    const io = createInvocationIo({
      db: rawDb, queues: {}, fetchImpl: async () => new Response("{}", { status: 200 }), limit: WRITE_LIMIT
    });
    const before = await lookupIntent({ db: io.db, principal, envelope });
    assert.equal(before.request, null);
    assert.equal(before.eventById, null);
    assert.equal(before.eventByKey, null);
    assert.equal(before.businessKey, null, "algorithm events have no business key");

    await acceptEvent({ io, principal, envelope, now: NOW });
    const after = await lookupIntent({ db: io.db, principal, envelope });
    assert.equal(after.request.requestId, "req-1");
    assert.equal(after.request.canonicalEventId, EVENT_ID);
    assert.equal(after.eventById.eventId, EVENT_ID);
    assert.equal(after.eventByKey.eventId, EVENT_ID);

    const secondEvent = algorithmEnvelope({
      envelope: { requestId: "req-2" },
      event: { eventId: "44444444-4444-4444-8444-444444444445", eventKey: "k-2" }
    });
    await acceptEvent({ io, principal, envelope: secondEvent, now: NOW });
    const heads = await rawDb.prepare("SELECT COUNT(*) AS n FROM rds2_projections").first("n");
    assert.equal(heads, 1, `(${binding}) the scope head is seeded once`);
    const head = await rawDb.prepare("SELECT revision FROM rds2_projections").first("revision");
    assert.equal(head, 0, "the head stays at revision 0 until the projection commits");
  });
});

// ---------------------------------------------------------------------------
// R1 regression: an alias/firstResult request-row race must go through the
// unified lookupIntent/decideIntent recheck. A concurrent writer that binds
// the same requestId to a different event (or different content) must never
// make the loser return a foreign success receipt.
// ---------------------------------------------------------------------------

function raceProxyIo(rawDb, { onLengthOne } = {}) {
  return createInvocationIo({
    db: {
      prepare: (sql) => rawDb.prepare(sql),
      batch: async (records) => {
        if (records.length === 1 && onLengthOne) {
          await onLengthOne();
        }
        return rawDb.batch(records);
      }
    },
    queues: {},
    fetchImpl: async () => new Response("{}", { status: 200 }),
    limit: WRITE_LIMIT
  });
}

async function seedForeignRequestRow(rawDb, { requestId, eventId, envelopeHash, receipt }) {
  await rawDb.batch([
    rawDb.prepare(
      "INSERT INTO rds2_requests (user_id, request_id, envelope_hash, canonical_event_id, receipt_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(USER, requestId, envelopeHash, eventId, JSON.stringify(receipt), NOW)
  ]);
}

function cleanIoFor(rawDb) {
  return createInvocationIo({ db: rawDb, queues: {}, fetchImpl: async () => new Response("{}", { status: 200 }), limit: WRITE_LIMIT });
}

test("R1 alias race binding the requestId to another event conflicts instead of replaying", async () => {
  await runAcceptTest(async ({ binding, rawDb, principal }) => {
    await acceptEvent({ io: cleanIoFor(rawDb), principal, now: NOW, envelope: algorithmEnvelope() });
    const winnerEnvelope = algorithmEnvelope({
      envelope: { requestId: "req-x" },
      event: { eventId: "66666666-0000-4000-8000-00000000000b", eventKey: "r1-winner-key" }
    });
    const loserEnvelope = algorithmEnvelope({ envelope: { requestId: "req-x" } });
    const racingIo = raceProxyIo(rawDb, {
      onLengthOne: async () => {
        await acceptEvent({ io: cleanIoFor(rawDb), principal, now: NOW, envelope: winnerEnvelope });
      }
    });
    await assert.rejects(
      () => acceptEvent({ io: racingIo, principal, envelope: loserEnvelope, now: NOW }),
      (error) => {
        assert.equal(error.status, 409, `(${binding}) the race must surface a stable 409`);
        assert.ok(
          ["identity_of_intent_conflict", "request_id_conflict"].includes(error.code),
          `(${binding}) unexpected conflict code ${error.code}`
        );
        return true;
      },
      `(${binding}) the loser must not receive a success receipt for another event`
    );
    const state = await counts(rawDb);
    assert.equal(state.events, 2, `(${binding}) only the winner's own event may exist`);
    assert.equal(state.requests, 2, `(${binding}) one row per recorded request`);
    const bound = await rawDb.prepare(
      "SELECT canonical_event_id FROM rds2_requests WHERE request_id = 'req-x'"
    ).first("canonical_event_id");
    assert.equal(bound, "66666666-0000-4000-8000-00000000000b", `(${binding}) the winner's binding is untouched`);
  });
});

test("R1 alias race with the identical request replays the consistent receipt", async () => {
  await runAcceptTest(async ({ binding, rawDb, principal }) => {
    await acceptEvent({ io: cleanIoFor(rawDb), principal, now: NOW, envelope: algorithmEnvelope() });
    const aliasEnvelope = algorithmEnvelope({ envelope: { requestId: "req-x" } });
    const winnerReceipt = { receipt: null };
    const racingIo = raceProxyIo(rawDb, {
      onLengthOne: async () => {
        winnerReceipt.receipt = await acceptEvent({ io: cleanIoFor(rawDb), principal, now: NOW, envelope: aliasEnvelope });
      }
    });
    const loserReceipt = await acceptEvent({ io: racingIo, principal, envelope: aliasEnvelope, now: NOW });
    assert.deepEqual(loserReceipt, winnerReceipt.receipt, `(${binding}) the loser must replay the identical consistent receipt`);
    assert.equal(loserReceipt.eventId, EVENT_ID);
    const state = await counts(rawDb);
    assert.equal(state.events, 1, `(${binding}) no extra event may appear`);
    assert.equal(state.requests, 2, `(${binding}) exactly one request row for req-x`);
  });
});

test("R1 alias race with same event but different content conflicts as request_id_conflict", async () => {
  await runAcceptTest(async ({ binding, rawDb, principal }) => {
    await acceptEvent({ io: cleanIoFor(rawDb), principal, now: NOW, envelope: algorithmEnvelope() });
    await seedForeignRequestRow(rawDb, {
      requestId: "req-x",
      eventId: EVENT_ID,
      envelopeHash: "h-from-another-content",
      receipt: { storageVersion: 2, attemptedRequestId: "req-x", canonicalRequestId: "req-1", eventId: EVENT_ID, jobId: "j", userId: USER, disposition: "already_recorded", ignoredDuplicate: false, cloudPersistence: "d1_committed" }
    });
    const racingIo = raceProxyIo(rawDb);
    await assert.rejects(
      () => acceptEvent({
        io: racingIo, principal, now: NOW,
        envelope: algorithmEnvelope({ envelope: { requestId: "req-x" } })
      }),
      (error) => error.code === "request_id_conflict" && error.status === 409,
      `(${binding}) a same-event different-envelope row must conflict`
    );
  });
});

test("R1 firstResult race binding the requestId to another event conflicts", async () => {
  await runAcceptTest(async ({ binding, rawDb, principal }) => {
    await acceptEvent({
      io: cleanIoFor(rawDb), principal, now: NOW,
      envelope: answerScoredEnvelope({ requestId: "score-1", eventId: "a0000000-0000-4000-8000-000000000004" })
    });
    const loserEnvelope = answerScoredEnvelope({ requestId: "score-x", eventId: "a0000000-0000-4000-8000-000000000005" });
    const winnerEnvelope = algorithmEnvelope({
      envelope: { requestId: "score-x" },
      event: { eventId: "66666666-0000-4000-8000-00000000000c", eventKey: "r1-score-race-key" }
    });
    const racingIo = raceProxyIo(rawDb, {
      onLengthOne: async () => {
        await acceptEvent({ io: cleanIoFor(rawDb), principal, now: NOW, envelope: winnerEnvelope });
      }
    });
    await assert.rejects(
      () => acceptEvent({ io: racingIo, principal, envelope: loserEnvelope, now: NOW }),
      (error) => {
        assert.equal(error.status, 409, `(${binding}) the race must surface a stable 409`);
        assert.ok(
          ["identity_of_intent_conflict", "request_id_conflict"].includes(error.code),
          `(${binding}) unexpected conflict code ${error.code}`
        );
        return true;
      }
    );
    const state = await counts(rawDb);
    assert.equal(state.events, 2, `(${binding}) only the first score and the winner's own event exist`);
  });
});

test("R1 firstResult race with the identical request replays the consistent receipt", async () => {
  await runAcceptTest(async ({ binding, rawDb, principal }) => {
    await acceptEvent({
      io: cleanIoFor(rawDb), principal, now: NOW,
      envelope: answerScoredEnvelope({ requestId: "score-1", eventId: "a0000000-0000-4000-8000-000000000004" })
    });
    const dupEnvelope = answerScoredEnvelope({ requestId: "score-x", eventId: "a0000000-0000-4000-8000-000000000005" });
    const winnerReceipt = { receipt: null };
    const racingIo = raceProxyIo(rawDb, {
      onLengthOne: async () => {
        winnerReceipt.receipt = await acceptEvent({ io: cleanIoFor(rawDb), principal, now: NOW, envelope: dupEnvelope });
      }
    });
    const loserReceipt = await acceptEvent({ io: racingIo, principal, envelope: dupEnvelope, now: NOW });
    assert.deepEqual(loserReceipt, winnerReceipt.receipt, `(${binding}) identical duplicate race must replay one receipt`);
    assert.equal(loserReceipt.ignoredDuplicate, true);
    const state = await counts(rawDb);
    assert.equal(state.events, 1, `(${binding}) still only the first score event`);
    assert.equal(state.requests, 2);
  });
});

test("R1 firstResult race with different content under the same requestId conflicts", async () => {
  await runAcceptTest(async ({ binding, rawDb, principal }) => {
    await acceptEvent({
      io: cleanIoFor(rawDb), principal, now: NOW,
      envelope: answerScoredEnvelope({ requestId: "score-1", eventId: "a0000000-0000-4000-8000-000000000004" })
    });
    await seedForeignRequestRow(rawDb, {
      requestId: "score-x",
      eventId: "a0000000-0000-4000-8000-000000000004",
      envelopeHash: "h-from-another-content",
      receipt: { storageVersion: 2, attemptedRequestId: "score-x", canonicalRequestId: "score-1", eventId: "a0000000-0000-4000-8000-000000000004", jobId: "j", userId: USER, disposition: "already_recorded", ignoredDuplicate: true, cloudPersistence: "d1_committed" }
    });
    const racingIo = raceProxyIo(rawDb);
    await assert.rejects(
      () => acceptEvent({
        io: racingIo, principal, now: NOW,
        envelope: answerScoredEnvelope({ requestId: "score-x", eventId: "a0000000-0000-4000-8000-000000000005" })
      }),
      (error) => error.code === "request_id_conflict" && error.status === 409,
      `(${binding}) a same-event different-envelope row must conflict on the firstResult path too`
    );
  });
});
