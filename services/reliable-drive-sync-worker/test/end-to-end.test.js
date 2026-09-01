import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../src/index.js";
import { canonicalHash } from "../src/event-store.js";

const SESSION_EVENT_ID = "22222222-2222-4222-8222-222222222222";
const REVIEW_EVENT_ID = "33333333-3333-4333-8333-333333333333";
const SESSION_ID = "MOCK-20260814T000000Z-44444444-4444-4444-8444-444444444444";

function fakeDrive() {
  const folders = new Map([["root", { id: "root", name: "root", parents: [] }]]);
  const files = new Map();
  let sequence = 0;
  const childItems = (parentId, name) => [...folders.values(), ...files.values()]
    .filter((item) => item.parents?.length === 1 && item.parents[0] === parentId
      && (!name || item.name === name));
  const folder = (id, name, parentId) => ({
    id, name, parents: [parentId], mimeType: "application/vnd.google-apps.folder"
  });
  return {
    rootFolderId: "root",
    folders,
    files,
    filesByPrefix(prefix) {
      return [...files.values()].filter((file) => file.name.startsWith(prefix));
    },
    async findFolder(parentId, name) {
      return childItems(parentId, name).find((item) => item.mimeType === "application/vnd.google-apps.folder") ?? null;
    },
    async ensureFolder(parentId, name) {
      const existing = await this.findFolder(parentId, name);
      if (existing) return existing;
      const created = folder(`folder-${++sequence}`, name, parentId);
      folders.set(created.id, created);
      return created;
    },
    async listChildren(parentId, { name, foldersOnly } = {}) {
      return childItems(parentId, name)
        .filter((item) => !foldersOnly || item.mimeType === "application/vnd.google-apps.folder");
    },
    async listJson(parentId) {
      return childItems(parentId).filter((item) => item.mimeType === "application/json");
    },
    async createJson(parentId, name, value) {
      const created = {
        id: `file-${++sequence}`,
        name,
        parents: [parentId],
        mimeType: "application/json",
        value: structuredClone(value)
      };
      files.set(created.id, created);
      return structuredClone(created);
    },
    async readJson(id) {
      const file = files.get(id);
      return file ? structuredClone(file) : null;
    }
  };
}

function request(id, eventType, payload, namespace = "interview", identity) {
  return new Request("https://example.test/mcp", {
    method: "POST",
    headers: { authorization: "Bearer secret", "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "submit_event",
        arguments: {
          schemaVersion: "1.2",
          namespace,
          eventType,
          ...(identity ? { identity } : {}),
          payload,
          requestId: `99999999-9999-4999-8999-${String(id).padStart(12, "0")}`
        }
      }
    })
  });
}

async function call(drive, id, eventType, payload, { namespace, identity } = {}) {
  const response = await handleRequest(request(id, eventType, payload, namespace, identity), {
    MCP_BEARER_TOKEN: "secret",
    GOOGLE_DRIVE_FOLDER_ID: "root"
  }, { drive });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.error, undefined, JSON.stringify(body));
  return JSON.parse(body.result.content[0].text);
}

async function callExpectingError(drive, id, eventType, payload, { namespace, identity } = {}) {
  const response = await handleRequest(request(id, eventType, payload, namespace, identity), {
    MCP_BEARER_TOKEN: "secret",
    GOOGLE_DRIVE_FOLDER_ID: "root"
  }, { drive });
  const body = await response.json();
  assert.ok(body.error, `expected a protocol error, got ${JSON.stringify(body)}`);
  return body.error.message;
}

test("name registration, session, review, and snapshot share one resolved userId", async () => {
  const drive = fakeDrive();
  const name = "验收用户";

  const registered = await call(drive, 1, "system.user-registered", { displayName: name }, { namespace: "system" });
  assert.equal(registered.status, "ok");
  const identity = registered.identity;
  assert.equal(identity.username, name);
  assert.match(identity.userId, /^[0-9a-f-]{36}$/i);

  // Re-submitting the same name must resolve to the same user.
  const reresolved = await call(drive, 7, "system.user-registered", { displayName: ` ${name} ` }, { namespace: "system" });
  assert.equal(reresolved.identity.userId, identity.userId);

  const sessionEvent = {
    schemaVersion: "1.2",
    eventId: SESSION_EVENT_ID,
    eventKey: `${identity.userId}:interview:session:${SESSION_ID}:v1`,
    eventType: "interview.session.completed",
    userId: identity.userId,
    username: identity.username,
    sessionId: SESSION_ID,
    interviewType: "mock",
    domain: "java-backend",
    startedAt: "2026-08-14T00:00:00.000Z",
    completedAt: "2026-08-14T00:30:00.000Z",
    status: "review_pending",
    resumeContext: { used: false, source: "current_conversation", claims: [] },
    questions: []
  };
  const session = await call(drive, 2, "interview.session.completed", { event: sessionEvent }, { identity: { username: name } });
  assert.equal(session.status, "ok");
  assert.equal(session.identity.userId, identity.userId);

  const listed = await call(drive, 4, "interview.session.list", {}, { identity: { username: name } });
  assert.equal(listed.data.sessions.length, 1);
  assert.equal(listed.data.sessions[0].sessionId, SESSION_ID);

  const loaded = await call(drive, 5, "interview.session.load", { sessionId: SESSION_ID }, { identity: { username: name } });
  assert.equal(loaded.data.session.eventId, SESSION_EVENT_ID);

  const reviewEvent = {
    schemaVersion: "1.2",
    eventId: REVIEW_EVENT_ID,
    eventKey: `${identity.userId}:interview:review:${SESSION_ID}:v1`,
    eventType: "interview.review.completed",
    userId: identity.userId,
    username: identity.username,
    sessionId: SESSION_ID,
    reviewVersion: 1,
    interviewType: "mock",
    domain: "java-backend",
    sourceSessionEventId: loaded.data.session.eventId,
    sourceType: "mock",
    evidenceType: "full_transcript",
    evidenceConfidence: "high",
    questionReviews: [],
    profileChanges: [{
      kind: "weakness",
      weaknessId: "W-001",
      domain: "java-backend",
      outcome: "failed",
      evidenceRefs: [SESSION_EVENT_ID],
      variantId: "initial"
    }],
    recommendations: ["复测并发基础"],
    applyProfileChanges: true,
    completedAt: "2026-08-14T01:00:00.000Z"
  };
  const reviewed = await call(drive, 6, "interview.review.completed", { event: reviewEvent }, { identity: { username: name } });
  assert.equal(reviewed.status, "ok", JSON.stringify(reviewed));
  assert.equal(drive.filesByPrefix("snapshot-").length, 1);

  // The same resolved user must be reused by another domain.
  const algorithmEvent = {
    schemaVersion: "1.2",
    eventId: "44444444-4444-4444-8444-444444444444",
    eventKey: `${identity.userId}:algorithm-learning:two-sum:2026-08-14T10:00:00.000Z`,
    eventType: "algorithm.learning.completed",
    userId: identity.userId,
    username: identity.username,
    observedAt: "2026-08-14T10:00:00.000Z",
    source: "qa",
    topic: "two-sum",
    problem: { title: "Two Sum", source: "Hot100", url: "" },
    outcome: "consulted",
    evidence: "用户请求讲解两数之和。",
    tags: ["hash-map"],
    confidence: "medium"
  };
  const algorithm = await call(drive, 8, "algorithm.learning.completed", { event: algorithmEvent }, {
    namespace: "algorithm",
    identity: { username: name }
  });
  assert.equal(algorithm.status, "ok");
  assert.equal(algorithm.identity.userId, identity.userId);
  assert.equal(algorithm.data.profile.headEventId, algorithmEvent.eventId);

  // Every write lives below the single plugin root; no namespace-scoped
  // registry or users folder may exist any more.
  const namespaceScoped = [...drive.folders.values()]
    .filter((folder) => folder.parents?.length === 1 && folder.parents[0] === "root"
      && ["algorithm", "interview"].includes(folder.name));
  assert.deepEqual(namespaceScoped, []);
  assert.equal(drive.folders.get(drive.folders.get(
    drive.files.get([...drive.files.values()].find((file) => file.name === "identity.json").id).parents[0]
  ).parents[0]).name, "users");
});

function ancestryOf(drive, file) {
  const names = [file.name];
  let parentId = file.parents[0];
  while (parentId && parentId !== "root") {
    const parent = drive.folders.get(parentId) ?? drive.files.get(parentId);
    if (!parent) break;
    names.unshift(parent.name);
    parentId = parent.parents?.[0];
  }
  return names;
}

const RESUME_VERSION = "resume-2026-08-30-a";
const RESUME_FINGERPRINT = "sha256-def456";
const QUESTION_KEY = "redis-cache-penetration";

function bankQuestion(overrides = {}) {
  return {
    questionKey: QUESTION_KEY,
    knowledgePointId: "redis",
    evidence: "explicit",
    type: "principle",
    prompt: "什么是缓存穿透？如何解决？",
    answerChain: ["定义", "核心机制", "关键流程"],
    scoringPoints: ["布隆过滤器", "空值缓存"],
    referenceAnswer: "缓存穿透指查询不存在的数据……",
    resumeEvidenceRefs: ["claim-redis"],
    conditional: false,
    confirmed: false,
    masteryScore: null,
    lastScoredLocalDate: null,
    ...overrides
  };
}

function answerScored({ userId, username, localDate, total, id }) {
  const ratio = total / 100;
  return {
    schemaVersion: "1.2",
    eventId: id,
    eventKey: `${userId}:answer:${localDate}:${QUESTION_KEY}:${id}`,
    eventType: "resume-knowledge.answer-scored",
    userId,
    username,
    questionKey: QUESTION_KEY,
    localDate,
    resumeVersion: RESUME_VERSION,
    scoredAt: `${localDate}T02:00:00.000Z`,
    scores: {
      correctness: 40 * ratio,
      completeness: 25 * ratio,
      structure: 20 * ratio,
      resumeRelevance: 15 * ratio
    },
    total,
    feedback: {
      strengths: ["说出了布隆过滤器"],
      issues: ["遗漏空值缓存"],
      issueCategories: ["关键点遗漏"],
      answerChain: ["定义", "核心机制", "关键流程"],
      referenceAnswer: "缓存穿透指查询不存在的数据……"
    }
  };
}

test("resume ingestion, question bank, daily plan and scoring share one canonical root", async () => {
  const drive = fakeDrive();
  const name = "简历用户";

  const registered = await call(drive, 11, "system.user-registered", { displayName: name }, { namespace: "system" });
  assert.equal(registered.status, "ok");
  const identity = registered.identity;

  const ingested = await call(drive, 12, "resume-knowledge.resume-ingested", {
    event: {
      schemaVersion: "1.2",
      eventId: "a0000000-0000-4000-8000-000000000001",
      eventKey: `${identity.userId}:resume:${RESUME_VERSION}`,
      eventType: "resume-knowledge.resume-ingested",
      userId: identity.userId,
      username: identity.username,
      resumeVersion: RESUME_VERSION,
      fingerprint: RESUME_FINGERPRINT,
      activatedAt: "2026-08-30T00:00:00.000Z",
      claims: [{ claimId: "claim-redis", evidence: "explicit" }],
      claimRelations: [],
      techTags: ["Redis"],
      evidenceLocations: [{ claimId: "claim-redis", location: "项目经历 · 订单缓存" }]
    }
  }, { namespace: "resume-knowledge", identity: { username: name } });
  assert.equal(ingested.status, "ok", JSON.stringify(ingested));

  const banked = await call(drive, 13, "resume-knowledge.question-bank-created", {
    event: {
      schemaVersion: "1.2",
      eventId: "a0000000-0000-4000-8000-000000000002",
      eventKey: `${identity.userId}:question-bank:${RESUME_VERSION}`,
      eventType: "resume-knowledge.question-bank-created",
      userId: identity.userId,
      username: identity.username,
      resumeVersion: RESUME_VERSION,
      generatedAt: "2026-08-30T01:00:00.000Z",
      questions: [bankQuestion()]
    }
  }, { namespace: "resume-knowledge", identity: { username: name } });
  assert.equal(banked.status, "ok", JSON.stringify(banked));

  const planned = await call(drive, 14, "resume-knowledge.daily-plan-created", {
    event: {
      schemaVersion: "1.2",
      eventId: "a0000000-0000-4000-8000-000000000003",
      eventKey: `${identity.userId}:daily-plan:2026-08-30`,
      eventType: "resume-knowledge.daily-plan-created",
      userId: identity.userId,
      username: identity.username,
      resumeVersion: RESUME_VERSION,
      localDate: "2026-08-30",
      planId: "plan-2026-08-30",
      timezone: "Asia/Shanghai",
      generatedAt: "2026-08-30T01:00:00.000Z",
      items: [{
        questionKey: QUESTION_KEY,
        slot: "untested-explicit",
        knowledgePointId: "redis",
        evidence: "explicit",
        type: "principle",
        prompt: "什么是缓存穿透？如何解决？"
      }]
    }
  }, { namespace: "resume-knowledge", identity: { username: name } });
  assert.equal(planned.status, "ok", JSON.stringify(planned));

  // The day's plan is immutable: asking again returns the stored plan.
  const replanned = await call(drive, 15, "resume-knowledge.daily-plan-created", {
    event: {
      schemaVersion: "1.2",
      eventId: "a0000000-0000-4000-8000-00000000000a",
      eventKey: `${identity.userId}:daily-plan:2026-08-30:retry`,
      eventType: "resume-knowledge.daily-plan-created",
      userId: identity.userId,
      username: identity.username,
      resumeVersion: RESUME_VERSION,
      localDate: "2026-08-30",
      planId: "plan-2026-08-30",
      timezone: "Asia/Shanghai",
      generatedAt: "2026-08-30T01:30:00.000Z",
      items: []
    }
  }, { namespace: "resume-knowledge", identity: { username: name } });
  assert.equal(replanned.data.plan.generatedAt, "2026-08-30T01:00:00.000Z");
  assert.equal(drive.filesByPrefix("daily-plan-").length, 1);

  const first = await call(drive, 16, "resume-knowledge.answer-scored", {
    event: answerScored({
      userId: identity.userId,
      username: identity.username,
      localDate: "2026-08-30",
      total: 70,
      id: "a0000000-0000-4000-8000-000000000004"
    })
  }, { namespace: "resume-knowledge", identity: { username: name } });
  assert.equal(first.status, "ok", JSON.stringify(first));
  assert.equal(first.data.profile.questionMastery[QUESTION_KEY].masteryScore, 70);

  // A second attempt on the same local date is answered but never persisted.
  const repeat = await call(drive, 17, "resume-knowledge.answer-scored", {
    event: answerScored({
      userId: identity.userId,
      username: identity.username,
      localDate: "2026-08-30",
      total: 90,
      id: "a0000000-0000-4000-8000-000000000005"
    })
  }, { namespace: "resume-knowledge", identity: { username: name } });
  assert.equal(repeat.status, "already_scored_today");
  assert.equal(repeat.data.scoredTotal, 70);
  assert.equal(drive.filesByPrefix("snapshot-").length, 1);

  // The next local date scores the same question again and blends the mastery.
  const nextDay = await call(drive, 18, "resume-knowledge.answer-scored", {
    event: answerScored({
      userId: identity.userId,
      username: identity.username,
      localDate: "2026-08-31",
      total: 80,
      id: "a0000000-0000-4000-8000-000000000006"
    })
  }, { namespace: "resume-knowledge", identity: { username: name } });
  assert.equal(nextDay.status, "ok", JSON.stringify(nextDay));
  assert.equal(nextDay.data.profile.questionMastery[QUESTION_KEY].masteryScore, 76);
  assert.equal(drive.filesByPrefix("snapshot-").length, 2);

  // Every projection landed below the single canonical user root.
  const expected = new Map([
    [`resume-${RESUME_VERSION}-${RESUME_FINGERPRINT}.json`, ["sources", "resume", "snapshots"]],
    ["question-bank-", ["question-bank", "snapshots"]],
    ["event-", ["events"]],
    ["daily-plan-", ["plans", "daily"]],
    ["snapshot-", ["profile", "snapshots"]]
  ]);
  const createdFiles = [...drive.files.values()];
  for (const [prefix, segments] of expected) {
    const matches = createdFiles.filter((file) => file.name.startsWith(prefix));
    assert.ok(matches.length > 0, `no materialised file for ${prefix}`);
    for (const file of matches) {
      assert.deepEqual(ancestryOf(drive, file), [
        "my-chatGPT-skills", "users", identity.userId, "resume-knowledge", ...segments, file.name
      ]);
    }
  }

  const namespaceScoped = [...drive.folders.values()]
    .filter((folder) => folder.parents?.length === 1 && folder.parents[0] === "root");
  assert.deepEqual(namespaceScoped.map((folder) => folder.name), ["my-chatGPT-skills"]);
});

// ----------------------------------------------------------- legacy migration

const LEGACY_ALGORITHM_USER = "11111111-1111-4111-8111-111111111111";
const LEGACY_INTERVIEW_USER = "22222222-2222-4222-8222-222222222222";

async function seedLegacyNamespace(drive, { domain, userId, username, events, snapshots = [] }) {
  const root = await drive.ensureFolder("root", domain);
  const registry = await drive.ensureFolder(root.id, "user-registry");
  const users = await drive.ensureFolder(root.id, "users");
  const user = await drive.ensureFolder(users.id, userId);
  const eventsFolder = await drive.ensureFolder(user.id, "events");
  const profile = await drive.ensureFolder(user.id, "profile");
  const snapshotsFolder = await drive.ensureFolder(profile.id, "snapshots");

  await drive.createJson(registry.id, `registration-${userId}.json`, {
    schemaVersion: "1.2",
    status: "active",
    userId,
    username,
    createdAt: "2026-08-01T00:00:00.000Z"
  });
  for (const eventId of events) {
    const event = {
      schemaVersion: "1.2",
      eventId,
      eventKey: `legacy:${eventId}`,
      eventType: "algorithm.learning.completed",
      userId,
      username,
      topic: "legacy-topic"
    };
    event.contentHash = await canonicalHash(event);
    await drive.createJson(eventsFolder.id, `event-${eventId}.json`, event);
  }
  for (const [index, snapshot] of snapshots.entries()) {
    const snapshotValue = {
      schemaVersion: "1.2",
      headEventId: snapshot,
      userId,
      username
    };
    snapshotValue.contentHash = await canonicalHash(snapshotValue);
    await drive.createJson(
      snapshotsFolder.id,
      `snapshot-2026-08-0${index + 1}T00-00-00-000Z-${snapshot}.json`,
      snapshotValue
    );
  }
}

const legacyFiles = (drive) => [...drive.files.values()]
  .filter((file) => ["algorithm", "interview"].includes(ancestryOf(drive, file)[0]))
  .map((file) => ({ id: file.id, name: file.name, parent: file.parents[0], value: JSON.stringify(file.value) }))
  .sort((left, right) => left.id.localeCompare(right.id));

test("legacy migration runs through submit_event as an approved dry-run then execute", async () => {
  const drive = fakeDrive();
  const name = "迁移用户";

  const registered = await call(drive, 30, "system.user-registered", { displayName: name }, { namespace: "system" });
  const identity = registered.identity;

  await seedLegacyNamespace(drive, {
    domain: "algorithm",
    userId: LEGACY_ALGORITHM_USER,
    username: name,
    events: ["b0000000-0000-4000-8000-000000000001", "b0000000-0000-4000-8000-000000000002"],
    snapshots: ["b0000000-0000-4000-8000-000000000001"]
  });
  await seedLegacyNamespace(drive, {
    domain: "interview",
    userId: LEGACY_INTERVIEW_USER,
    username: name,
    events: ["b0000000-0000-4000-8000-000000000003"]
  });

  const legacyBefore = legacyFiles(drive);
  const filesBefore = drive.files.size;

  // A dry run reports everything and writes nothing at all.
  const dryRun = await call(drive, 31, "system.legacy-migration-requested", {
    displayName: name,
    mode: "dry-run",
    domains: ["algorithm", "interview"]
  }, { namespace: "system", identity: { userId: identity.userId, username: name } });

  assert.equal(dryRun.mode, "dry-run");
  assert.equal(dryRun.summary.total, 4);
  assert.equal(dryRun.summary.copy, 4);
  assert.equal(dryRun.summary.conflict, 0);
  assert.equal(drive.files.size, filesBefore);

  // execute without an approved plan hash is refused at the protocol boundary.
  assert.equal(await callExpectingError(drive, 32, "system.legacy-migration-requested", {
    displayName: name,
    mode: "execute",
    migrationId: "99999999-9999-4999-8999-000000000001"
  }, { namespace: "system", identity: { userId: identity.userId, username: name } }), "invalid_payload");

  // A stale approval is refused instead of copying blind.
  assert.equal(await callExpectingError(drive, 33, "system.legacy-migration-requested", {
    displayName: name,
    mode: "execute",
    migrationId: "99999999-9999-4999-8999-000000000001",
    approvedPlanHash: "stale-hash",
    domains: ["algorithm"]
  }, { namespace: "system", identity: { userId: identity.userId, username: name } }), "migration_plan_stale");

  const executed = await call(drive, 34, "system.legacy-migration-requested", {
    displayName: name,
    mode: "execute",
    migrationId: "99999999-9999-4999-8999-000000000001",
    approvedPlanHash: dryRun.planHash,
    domains: ["algorithm", "interview"]
  }, { namespace: "system", identity: { userId: identity.userId, username: name } });

  assert.equal(executed.mode, "execute");
  assert.equal(executed.summary.copied, 4);
  assert.equal(executed.receipt.migrationId, "99999999-9999-4999-8999-000000000001");
  assert.equal(executed.receipt.userId, identity.userId);
  assert.equal(executed.receiptFile.name, "migration-99999999-9999-4999-8999-000000000001-receipt.json");

  // The legacy objects are byte-for-byte untouched and none of them moved.
  assert.deepEqual(legacyFiles(drive), legacyBefore);

  // Every copy landed under the single canonical user root, next to the receipt.
  const copied = [...drive.files.values()]
    .filter((file) => file.name.startsWith("event-") || file.name.startsWith("snapshot-"))
    .filter((file) => ancestryOf(drive, file)[0] === "my-chatGPT-skills");
  assert.equal(copied.length, 4);
  for (const file of copied) {
    const ancestry = ancestryOf(drive, file);
    assert.deepEqual(ancestry.slice(0, 3), ["my-chatGPT-skills", "users", identity.userId]);
    const domain = ancestry[3];
    assert.ok(["algorithm", "interview"].includes(domain), ancestry.join("/"));
    const segments = ancestry.slice(4, -1);
    assert.deepEqual(segments.slice(0, 1), file.name.startsWith("event-") ? ["events"] : ["profile"]);
  }

  const receipt = [...drive.files.values()].find((file) => file.name.startsWith("migration-"));
  assert.deepEqual(ancestryOf(drive, receipt), [
    "my-chatGPT-skills", "users", identity.userId, receipt.name
  ]);

  // Replaying the same approved migration copies nothing new.
  const replayed = await call(drive, 35, "system.legacy-migration-requested", {
    displayName: name,
    mode: "execute",
    migrationId: "99999999-9999-4999-8999-000000000001",
    approvedPlanHash: dryRun.planHash,
    domains: ["algorithm", "interview"]
  }, { namespace: "system", identity: { userId: identity.userId, username: name } });
  assert.equal(replayed.summary.copied, 0);
  assert.equal(replayed.summary.skip, 4);

  // The migration never creates a namespace-scoped registry or users folder.
  const namespaceScoped = [...drive.folders.values()]
    .filter((folder) => folder.parents?.length === 1 && folder.parents[0] === "root")
    .map((folder) => folder.name);
  assert.ok(namespaceScoped.includes("my-chatGPT-skills"));
  assert.deepEqual(namespaceScoped.filter((entry) => entry !== "my-chatGPT-skills"), ["algorithm", "interview"]);
  for (const domain of ["algorithm", "interview"]) {
    const legacyRoot = [...drive.folders.values()]
      .find((folder) => folder.name === domain && folder.parents[0] === "root");
    const children = [...drive.folders.values()]
      .filter((folder) => folder.parents[0] === legacyRoot.id)
      .map((folder) => folder.name)
      .sort();
    assert.deepEqual(children, ["user-registry", "users"]);
  }
});
