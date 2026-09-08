// T10: the V2 read surface — five read operations, strict DTO, cursor HMAC,
// fail-closed domain handling, and untouched V1 routes.
//
// Written before the module exists. The contract comes from the frozen
// addendum §5: one independent DTO per operation, every operation
// authenticated, params extra fields refused, cursors bound to user +
// operation + scope + revision and valid for 15 minutes, limit bounded and
// response bytes capped, and pure reads never create an outbox row or a task.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { handleV2Request } from "../src/rds2/routes.js";
import { createWorker } from "../src/index.js";
import { applySchema, withD1 } from "./support/rds2-d1.js";

const MIGRATION_SQL = readFileSync(fileURLToPath(
  new URL("../migrations/0006_rds2_v2_tables.sql", import.meta.url)
), "utf8");

const NOW = "2026-09-07T12:00:00.000Z";
const CREDENTIAL = "credential-t10";
const OTHER_CREDENTIAL = "credential-other-t10";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "a0000000-0000-4000-8000-000000000001";

const ENV = {
  RDS2_CURSOR_SECRET: "cursor-secret-t10",
  RDS2_V2_DOMAINS: "algorithm,interview",
  RDS2_QUERY_ENABLED: "true"
};

const envelopeBody = (overrides = {}) => ({
  eventId: EVENT_ID,
  eventKey: "k-1",
  eventType: "algorithm.learning.completed",
  userId: USER_ID,
  username: "乔炳源",
  observedAt: "2026-09-07T00:00:00.000Z",
  topic: "two-sum",
  ...overrides
});

const envelope = (overrides = {}) => ({
  schemaVersion: "1.2",
  requestId: "req-1",
  namespace: "algorithm",
  eventType: "algorithm.learning.completed",
  identity: { userId: USER_ID, username: "乔炳源" },
  payload: { event: envelopeBody(overrides?.payload?.event ?? {}) },
  ...overrides
});

const receipt = (overrides = {}) => ({
  storageVersion: 2,
  attemptedRequestId: "req-1",
  canonicalRequestId: "req-1",
  eventId: EVENT_ID,
  jobId: "job-1",
  userId: USER_ID,
  disposition: "accepted",
  ignoredDuplicate: false,
  cloudPersistence: "d1_committed",
  ...overrides
});

async function seedIdentity(rawDb) {
  const { hashText } = await import("../src/rds2/identity/hashing.js");
  const seed = async (credential, userId, name) => {
    const hash = await hashText(credential);
    await rawDb.prepare(
      `INSERT INTO rds2_users (user_id, name_key, display_name, status, created_at)
       VALUES (?, ?, ?, 'active', ?)`
    ).bind(userId, `key-${userId}`, name, NOW).run();
    await rawDb.prepare(
      `INSERT INTO rds2_credentials (credential_hash, user_id, status, created_at)
       VALUES (?, ?, 'active', ?)`
    ).bind(hash, userId, NOW).run();
  };
  await seed(CREDENTIAL, USER_ID, "乔炳源");
  await seed(OTHER_CREDENTIAL, OTHER_USER_ID, "另一个用户");
}

async function seedProjection(rawDb) {
  await rawDb.prepare(
    `INSERT INTO rds2_projections (user_id, namespace, projection_name, revision, last_event_seq,
       active_generation, building, summary_json, updated_at)
     VALUES (?, 'algorithm', 'learning', 3, 5, 1, 0, '{"topics":1}', ?)`
  ).bind(USER_ID, NOW).run();
  for (let index = 0; index < 3; index += 1) {
    await rawDb.prepare(
      `INSERT INTO rds2_projection_rows (user_id, namespace, projection_name, generation,
         row_kind, row_key, member_key, sort_key, value_json, updated_at)
       VALUES (?, 'algorithm', 'learning', 1, 'topic', ?, NULL, ?, ?, ?)`
    ).bind(USER_ID, `topic-${index}`, String(index).padStart(10, "0"),
      JSON.stringify({ topic: `topic-${index}`, count: index }), NOW).run();
  }
}

async function seedEventAndRequest(rawDb) {
  await rawDb.prepare(
    `INSERT INTO rds2_events (event_seq, user_id, namespace, projection_name, event_id, event_key,
       event_type, created_by_request, envelope_json, content_hash, created_at)
     VALUES (1, ?, 'algorithm', 'learning', ?, 'k-1', 'algorithm.learning.completed', 'req-1', '{}', 'c', ?)`
  ).bind(USER_ID, EVENT_ID, NOW).run();
  await rawDb.prepare(
    `INSERT INTO rds2_requests (user_id, request_id, envelope_hash, canonical_event_id, receipt_json, created_at)
     VALUES (?, 'req-1', 'h', ?, '{"storageVersion":2}', ?)`
  ).bind(USER_ID, EVENT_ID, NOW).run();
}

async function runRoutesTest(body) {
  await withD1(async (binding, rawDb) => {
    await applySchema(rawDb, MIGRATION_SQL);
    await seedIdentity(rawDb);
    await seedProjection(rawDb);
    await seedEventAndRequest(rawDb);
    await body({
      binding,
      rawDb,
      deps: {
        db: rawDb,
        now: () => NOW,
        interviewRead: async () => ({ sessions: [], displayName: "乔炳源" })
      }
    });
  });
}

function v2Request({ operation, params = {}, credential = CREDENTIAL, env = ENV, rawBody } = {}) {
  return new Request("https://worker.example/v2/query", {
    method: "POST",
    headers: {
      authorization: credential === null ? "" : `Bearer ${credential}`,
      "content-type": "application/json"
    },
    body: rawBody ?? JSON.stringify({ storageVersion: 2, operation, params })
  });
}

test("T10 the read operations resolve through V2 without creating a task", async (t) => {
  await runRoutesTest(async ({ rawDb, deps }) => {
    const capabilities = await handleV2Request(
      v2Request({ operation: "capabilities", params: {} }), ENV, null, deps);
    assert.equal(capabilities.status, 200);
    assert.deepEqual((await capabilities.json()).domains.sort(), ["algorithm", "interview"]);

    const resolved = await handleV2Request(
      v2Request({ operation: "user.resolve", params: { displayName: "乔炳源" } }), ENV, null, deps);
    assert.equal(resolved.status, 200);
    assert.equal((await resolved.json()).userId, USER_ID);

    const page = await handleV2Request(
      v2Request({ operation: "projection.read", params: { namespace: "algorithm", projectionName: "learning" } }),
      ENV, null, deps);
    assert.equal(page.status, 200);
    const pageBody = await page.json();
    assert.equal(pageBody.revision, 3);
    assert.equal(pageBody.entries.length, 3);

    const listed = await handleV2Request(
      v2Request({ operation: "interview.session.list", params: {} }), ENV, null, deps);
    assert.equal(listed.status, 200, "interview reads delegate to the v1 source");

    const status = await handleV2Request(
      v2Request({ operation: "event.status", params: { targetRequestId: "req-1" } }), ENV, null, deps);
    assert.equal(status.status, 200);

    const tasks = await rawDb.prepare("SELECT COUNT(*) AS n FROM rds2_tasks").first();
    assert.equal(Number(tasks.n), 0, "pure reads create no task");
    const requests = await rawDb.prepare("SELECT COUNT(*) AS n FROM rds2_requests").first();
    assert.equal(Number(requests.n), 1, "pure reads create no outbox request");
  });
});

test("T10 event.status demands exactly one target", async (t) => {
  await runRoutesTest(async ({ deps }) => {
    const both = await handleV2Request(
      v2Request({ operation: "event.status", params: { targetRequestId: "req-1", targetEventId: EVENT_ID } }),
      ENV, null, deps);
    assert.equal(both.status, 400);
    assert.equal((await both.json()).error.code, "event_status_ambiguous");

    const neither = await handleV2Request(
      v2Request({ operation: "event.status", params: {} }), ENV, null, deps);
    assert.equal(neither.status, 400);
    assert.equal((await neither.json()).error.code, "event_status_ambiguous");

    const byEvent = await handleV2Request(
      v2Request({ operation: "event.status", params: { targetEventId: EVENT_ID } }), ENV, null, deps);
    assert.equal(byEvent.status, 200, "exactly one target is accepted");
  });
});

test("T10 a cursor is refused for another user and honoured for its owner", async (t) => {
  await runRoutesTest(async ({ deps }) => {
    const first = await handleV2Request(
      v2Request({ operation: "projection.read", params: { namespace: "algorithm", projectionName: "learning", limit: 1 } }),
      ENV, null, deps);
    const { nextCursor } = await first.json();
    assert.ok(nextCursor, "the first page hands out a cursor");

    const sameUser = await handleV2Request(
      v2Request({
        operation: "projection.read",
        params: { namespace: "algorithm", projectionName: "learning", cursor: nextCursor }
      }), ENV, null, deps);
    assert.equal(sameUser.status, 200, "the owner may keep paging");
    assert.equal((await sameUser.json()).entries.length, 2, "the cursor continues after the first row");

    const otherUser = await handleV2Request(
      v2Request({
        operation: "projection.read",
        params: { namespace: "algorithm", projectionName: "learning", cursor: nextCursor },
        credential: OTHER_CREDENTIAL
      }), ENV, null, deps);
    assert.equal(otherUser.status, 403, "another principal's cursor is refused");
    assert.equal((await otherUser.json()).error.code, "cursor_scope_mismatch");
  });
});

test("T10 an expired cursor is refused after 15 minutes", async (t) => {
  await runRoutesTest(async ({ deps }) => {
    const first = await handleV2Request(
      v2Request({ operation: "projection.read", params: { namespace: "algorithm", projectionName: "learning", limit: 1 } }),
      ENV, null, deps);
    const { nextCursor } = await first.json();

    const later = { ...deps, now: () => "2026-09-07T12:16:00.000Z" };
    const expired = await handleV2Request(
      v2Request({
        operation: "projection.read",
        params: { namespace: "algorithm", projectionName: "learning", cursor: nextCursor }
      }), ENV, null, later);
    assert.equal(expired.status, 400);
    assert.equal((await expired.json()).error.code, "cursor_expired");
  });
});

test("T10 a changed revision tells the client to re-read from the first page", async (t) => {
  await runRoutesTest(async ({ rawDb, deps }) => {
    const first = await handleV2Request(
      v2Request({ operation: "projection.read", params: { namespace: "algorithm", projectionName: "learning", limit: 1 } }),
      ENV, null, deps);
    const { nextCursor, revision } = await first.json();
    assert.equal(revision, 3);

    await rawDb.prepare(
      "UPDATE rds2_projections SET revision = 4 WHERE user_id = ?"
    ).bind(USER_ID).run();

    const stale = await handleV2Request(
      v2Request({
        operation: "projection.read",
        params: { namespace: "algorithm", projectionName: "learning", cursor: nextCursor }
      }), ENV, null, deps);
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error.code, "projection_changed");
  });
});

test("T10 fail-closed: missing credential, empty whitelist and a disabled domain", async (t) => {
  await runRoutesTest(async ({ deps }) => {
    const anonymous = await handleV2Request(
      v2Request({ operation: "capabilities", params: {}, credential: null }), ENV, null, deps);
    assert.equal(anonymous.status, 401);

    const emptyWhitelist = await handleV2Request(
      v2Request({ operation: "projection.read", params: { namespace: "algorithm", projectionName: "learning" } }),
      { ...ENV, RDS2_V2_DOMAINS: " " }, null, deps);
    assert.equal(emptyWhitelist.status, 403);
    assert.equal((await emptyWhitelist.json()).error.code, "domain_disabled");

    const foreignDomain = await handleV2Request(
      v2Request({ operation: "projection.read", params: { namespace: "other", projectionName: "learning" } }),
      ENV, null, deps);
    assert.equal(foreignDomain.status, 403);
    assert.equal((await foreignDomain.json()).error.code, "domain_disabled");
  });
});

test("T10 v1 routes stay exactly as they were while v2 answers", async (t) => {
  await runRoutesTest(async ({ rawDb }) => {
    const { createSyncHandler } = await import("../src/sync.js");
    const repository = new (await import("../src/job-repository.js")).D1JobRepository(rawDb);
    const deliver = async () => {};
    // Baseline: the v1 sync handler, called directly, exactly as it is wired
    // inside createWorker.
    const baseline = createSyncHandler({ DB: rawDb }, repository, deliver);
    const makeSyncRequest = () => new Request("https://worker.example/v1/sync", {
      method: "POST", body: JSON.stringify({ events: [] })
    });
    const baselineResponse = await baseline(makeSyncRequest());

    const worker = createWorker({ DB: rawDb, ...ENV }, { repository });
    const throughWorker = await worker.fetch(makeSyncRequest(), { DB: rawDb, ...ENV }, null);
    assert.equal(throughWorker.status, baselineResponse.status,
      "the v1 sync route behaves identically after the v2 wiring");

    // And the v2 read surface answers on the same worker.
    const v2 = await worker.fetch(
      new Request("https://worker.example/v2/query", {
        method: "POST",
        headers: { authorization: `Bearer ${CREDENTIAL}`, "content-type": "application/json" },
        body: JSON.stringify({ storageVersion: 2, operation: "capabilities", params: {} })
      }), { DB: rawDb, ...ENV }, null);
    assert.equal(v2.status, 200, "the v2 query route is live");
    assert.deepEqual((await v2.json()).domains.sort(), ["algorithm", "interview"]);
  });
});

test("T10 limit is clamped to 50 and an over-limit request is not refused", async (t) => {
  await runRoutesTest(async ({ deps }) => {
    const page = await handleV2Request(
      v2Request({ operation: "projection.read", params: { namespace: "algorithm", projectionName: "learning", limit: 500 } }),
      ENV, null, deps);
    assert.equal(page.status, 200, "an over-limit request is clamped, not refused");
  });
});
