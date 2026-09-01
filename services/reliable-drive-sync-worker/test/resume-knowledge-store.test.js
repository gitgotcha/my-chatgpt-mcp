import assert from "node:assert/strict";
import test from "node:test";
import { createResumeKnowledgeStore } from "../src/resume-knowledge-store.js";
import { createEventStore } from "../src/event-store.js";
import { createStorageLayout } from "../src/storage-layout.js";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const USERNAME = "张三";
const identity = { userId: USER_ID, username: USERNAME };
const RESUME_VERSION = "resume-2026-08-29-a";
const FINGERPRINT = "sha256-abc123";

function fakeDrive(options = {}) {
  const folders = new Map([["root", { id: "root", name: "root", parents: [] }]]);
  const files = new Map();
  const createdJsonFiles = [];
  let number = 0;
  const children = (parentId, name) => [...folders.values()]
    .filter((folder) => folder.parents[0] === parentId && (!name || folder.name === name));
  return {
    rootFolderId: "root",
    folders,
    files,
    createdJsonFiles,
    async findFolder(parentId, name) { return children(parentId, name)[0] ?? null; },
    async ensureFolder(parentId, name) {
      const found = children(parentId, name)[0];
      if (found) return found;
      const folder = { id: `folder-${++number}`, name, parents: [parentId] };
      folders.set(folder.id, folder);
      return folder;
    },
    async listJson(parentId) { return [...files.values()].filter((file) => file.parents[0] === parentId); },
    async createJson(parentId, name, value) {
      if (options.state?.failFor?.(name)) throw new Error("drive write unavailable");
      const file = { id: `file-${++number}`, name, parents: [parentId], mimeType: "application/json", value: structuredClone(value) };
      files.set(file.id, file);
      createdJsonFiles.push(file);
      return structuredClone(file);
    },
    async readJson(id) { return structuredClone(files.get(id)); }
  };
}

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

// The real event store is used on purpose: the once-per-day idempotency and the
// "event exists but projection missing" retry both depend on its real
// event-key deduplication and read-back verification.
function setup(options = {}) {
  const drive = fakeDrive(options.driveOptions);
  const layout = createStorageLayout({ drive });
  const userStore = {
    async verify({ userId, displayName }) {
      return { status: "ok", identity: { userId, displayName } };
    }
  };
  const eventStore = createEventStore({ domain: "resume-knowledge", userStore, layout, drive });
  return {
    drive,
    layout,
    eventStore,
    store: createResumeKnowledgeStore({ eventStore, layout, drive, ...options.storeOptions })
  };
}

const claimDecision = (overrides = {}) => ({
  schemaVersion: "1.2",
  eventId: "50000000-0000-4000-8000-000000000001",
  eventKey: `${USER_ID}:claim:claim-mq:confirmed`,
  eventType: "resume-knowledge.claim-confirmed",
  userId: USER_ID,
  username: USERNAME,
  resumeVersion: RESUME_VERSION,
  claimId: "claim-mq",
  decidedAt: "2026-08-29T03:00:00.000Z",
  ...overrides
});

const resumeIngested = (overrides = {}) => ({
  schemaVersion: "1.2",
  eventId: "40000000-0000-4000-8000-000000000001",
  eventKey: `${USER_ID}:resume:${RESUME_VERSION}`,
  eventType: "resume-knowledge.resume-ingested",
  userId: USER_ID,
  username: USERNAME,
  resumeVersion: RESUME_VERSION,
  fingerprint: FINGERPRINT,
  activatedAt: "2026-08-29T00:00:00.000Z",
  claims: [
    { claimId: "claim-redis", evidence: "explicit" },
    { claimId: "claim-mysql", evidence: "explicit" },
    { claimId: "claim-mq", evidence: "strong-inference" }
  ],
  claimRelations: [{ parentClaimId: "claim-redis", childClaimId: "claim-mysql" }],
  techTags: ["Redis", "MySQL"],
  evidenceLocations: [{ claimId: "claim-redis", location: "项目经历 · 订单缓存" }],
  ...overrides
});

const bankQuestion = (overrides = {}) => ({
  questionKey: "redis-cache-penetration",
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
});

const questionBankCreated = (overrides = {}) => ({
  schemaVersion: "1.2",
  eventId: "60000000-0000-4000-8000-000000000001",
  eventKey: `${USER_ID}:question-bank:${RESUME_VERSION}`,
  eventType: "resume-knowledge.question-bank-created",
  userId: USER_ID,
  username: USERNAME,
  resumeVersion: RESUME_VERSION,
  generatedAt: "2026-08-29T01:00:00.000Z",
  questions: [
    bankQuestion(),
    bankQuestion({
      questionKey: "mysql-index-b-plus-tree",
      knowledgePointId: "mysql",
      prompt: "为什么 MySQL 使用 B+ 树索引？",
      resumeEvidenceRefs: ["claim-mysql"]
    })
  ],
  ...overrides
});

const dailyPlanCreated = (overrides = {}) => ({
  schemaVersion: "1.2",
  eventId: "70000000-0000-4000-8000-000000000001",
  eventKey: `${USER_ID}:daily-plan:2026-08-30`,
  eventType: "resume-knowledge.daily-plan-created",
  userId: USER_ID,
  username: USERNAME,
  resumeVersion: RESUME_VERSION,
  localDate: "2026-08-30",
  planId: "plan-2026-08-30",
  timezone: "Asia/Shanghai",
  generatedAt: "2026-08-30T01:00:00.000Z",
  items: [{
    questionKey: "redis-cache-penetration",
    slot: "untested-explicit",
    knowledgePointId: "redis",
    evidence: "explicit",
    type: "principle",
    prompt: "什么是缓存穿透？如何解决？"
  }],
  ...overrides
});

const answerScored = ({ localDate, questionKey, total, id }) => {
  const ratio = total / 100;
  return {
    schemaVersion: "1.2",
    eventId: id,
    // Unique per event: the once-per-day rule is enforced on
    // userId + localDate + questionKey, not on the event key itself.
    eventKey: `${USER_ID}:answer:${localDate}:${questionKey}:${id}`,
    eventType: "resume-knowledge.answer-scored",
    userId: USER_ID,
    username: USERNAME,
    questionKey,
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
};

const FIRST_SCORE_ID = "80000000-0000-4000-8000-000000000001";
const SECOND_SCORE_ID = "80000000-0000-4000-8000-000000000002";

async function setupWithBank(options = {}) {
  const harness = setup(options);
  await harness.store.ingestResume(identity, resumeIngested());
  await harness.store.saveQuestionBank(identity, questionBankCreated());
  return harness;
}

// ---------------------------------------------------------------------------
// Materialised paths
// ---------------------------------------------------------------------------

test("a resume snapshot is written below sources/resume/snapshots", async () => {
  const { drive, store } = setup();
  const result = await store.ingestResume(identity, resumeIngested());
  assert.equal(result.status, "ok");

  const snapshots = drive.createdJsonFiles.filter((file) => file.name.startsWith("resume-"));
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].name, `resume-${RESUME_VERSION}-${FINGERPRINT}.json`);
  assert.deepEqual(ancestryOf(drive, snapshots[0]), [
    "my-chatGPT-skills", "users", USER_ID, "resume-knowledge",
    "sources", "resume", "snapshots", snapshots[0].name
  ]);
  assert.equal(result.data.resumeSnapshot.fingerprint, FINGERPRINT);
  assert.equal(result.data.resumeSnapshot.techTags.length, 2);
});

test("re-ingesting the same resume version and fingerprint reuses the snapshot", async () => {
  const { drive, store } = setup();
  const first = await store.ingestResume(identity, resumeIngested());
  const second = await store.ingestResume(identity, resumeIngested());
  assert.equal(second.status, "ok");
  assert.equal(second.data.projectionReceipt.reused, true);
  assert.equal(second.data.projectionReceipt.fileId, first.data.projectionReceipt.fileId);
  assert.equal(drive.createdJsonFiles.filter((file) => file.name.startsWith("resume-")).length, 1);
});

test("a conflicting payload for an existing resume snapshot is refused", async () => {
  const { store } = setup();
  await store.ingestResume(identity, resumeIngested());
  // A distinct event that reuses the same version and fingerprint would have to
  // overwrite a snapshot whose content differs, so the write stops.
  const conflicting = resumeIngested({
    eventId: "40000000-0000-4000-8000-000000000002",
    eventKey: `${USER_ID}:resume:${RESUME_VERSION}:retry`,
    techTags: ["Redis"]
  });
  await assert.rejects(() => store.ingestResume(identity, conflicting), /projection_conflict/);
});

test("a question bank is written below question-bank/snapshots", async () => {
  const { drive, store } = setup();
  const result = await store.saveQuestionBank(identity, questionBankCreated());
  assert.equal(result.status, "ok");

  const banks = drive.createdJsonFiles.filter((file) => file.name.startsWith("question-bank-"));
  assert.equal(banks.length, 1);
  assert.equal(banks[0].name, `question-bank-${RESUME_VERSION}-${questionBankCreated().eventId}.json`);
  assert.deepEqual(ancestryOf(drive, banks[0]), [
    "my-chatGPT-skills", "users", USER_ID, "resume-knowledge",
    "question-bank", "snapshots", banks[0].name
  ]);
});

test("a claim decision only appends an event and materialises no projection", async () => {
  const { drive, store } = setup();
  const result = await store.recordClaimDecision(identity, claimDecision());
  assert.equal(result.status, "ok");
  assert.equal(result.data.decision, "confirmed");
  assert.equal(result.data.claimId, "claim-mq");
  assert.deepEqual(drive.createdJsonFiles.filter((file) => !file.name.startsWith("event-")), []);
});

test("a rejected claim decision is recorded as rejected", async () => {
  const { store } = setup();
  const result = await store.recordClaimDecision(identity, claimDecision({
    eventType: "resume-knowledge.claim-rejected",
    eventKey: `${USER_ID}:claim:claim-mq:rejected`
  }));
  assert.equal(result.data.decision, "rejected");
});

// ---------------------------------------------------------------------------
// Daily plans
// ---------------------------------------------------------------------------

test("a daily plan is written below plans/daily and reused unchanged", async () => {
  const { drive, store } = await setupWithBank();
  const created = await store.getOrCreateDailyPlan(identity, dailyPlanCreated());
  assert.equal(created.status, "ok");
  assert.equal(created.data.projectionReceipt.reused, false);

  const plans = drive.createdJsonFiles.filter((file) => file.name.startsWith("daily-plan-"));
  assert.equal(plans.length, 1);
  assert.equal(plans[0].name, "daily-plan-2026-08-30-plan-2026-08-30.json");
  assert.deepEqual(ancestryOf(drive, plans[0]), [
    "my-chatGPT-skills", "users", USER_ID, "resume-knowledge",
    "plans", "daily", plans[0].name
  ]);

  // A different planId on a date that already has a plan must not create a
  // second immutable plan: the day's plan is fixed once created.
  const reused = await store.getOrCreateDailyPlan(identity, dailyPlanCreated({ planId: "plan-other" }));
  assert.equal(reused.status, "ok");
  assert.equal(reused.data.projectionReceipt.reused, true);
  assert.equal(reused.data.plan.planId, "plan-2026-08-30");
  assert.equal(drive.createdJsonFiles.filter((file) => file.name.startsWith("daily-plan-")).length, 1);
});

test("a daily plan without a question bank returns resume_required", async () => {
  const { drive, store } = setup();
  const result = await store.getOrCreateDailyPlan(identity, dailyPlanCreated());
  assert.equal(result.status, "resume_required");
  assert.deepEqual(drive.createdJsonFiles.filter((file) => file.name.startsWith("daily-plan-")), []);
});

// ---------------------------------------------------------------------------
// Scoring, idempotency and projections
// ---------------------------------------------------------------------------

test("the first score of a question appends an event and materialises a snapshot", async () => {
  const { drive, store } = await setupWithBank();
  const result = await store.scoreAnswer(identity, answerScored({
    localDate: "2026-08-30", questionKey: "redis-cache-penetration", total: 70, id: FIRST_SCORE_ID
  }));

  assert.equal(result.status, "ok");
  assert.equal(result.data.projectionReceipt.reused, false);

  const snapshots = drive.createdJsonFiles.filter((file) => file.name.startsWith("snapshot-"));
  assert.equal(snapshots.length, 1);
  assert.deepEqual(ancestryOf(drive, snapshots[0]), [
    "my-chatGPT-skills", "users", USER_ID, "resume-knowledge",
    "profile", "snapshots", snapshots[0].name
  ]);

  const profile = result.data.profile;
  assert.equal(profile.headEventId, FIRST_SCORE_ID);
  assert.equal(profile.resumeVersion, RESUME_VERSION);
  // First score becomes mastery directly.
  assert.equal(profile.questionMastery["redis-cache-penetration"].masteryScore, 70);
  assert.match(snapshots[0].name, new RegExp(`-${FIRST_SCORE_ID}\\.json$`));
});

test("a second score on the same local date returns already_scored_today", async () => {
  const { drive, store } = await setupWithBank();
  const event = answerScored({
    localDate: "2026-08-30", questionKey: "redis-cache-penetration", total: 70, id: FIRST_SCORE_ID
  });
  await store.scoreAnswer(identity, event);

  const repeat = await store.scoreAnswer(identity, answerScored({
    localDate: "2026-08-30", questionKey: "redis-cache-penetration", total: 90, id: SECOND_SCORE_ID
  }));

  assert.equal(repeat.status, "already_scored_today");
  assert.equal(repeat.data.localDate, "2026-08-30");
  assert.equal(repeat.data.scoredTotal, 70);
  // No second event and no second snapshot.
  assert.equal(drive.createdJsonFiles.filter((file) => file.name.startsWith("event-")).length, 3);
  assert.equal(drive.createdJsonFiles.filter((file) => file.name.startsWith("snapshot-")).length, 1);
});

test("the same question on the next local date is scored again and blends mastery", async () => {
  const { drive, store } = await setupWithBank();
  await store.scoreAnswer(identity, answerScored({
    localDate: "2026-08-30", questionKey: "redis-cache-penetration", total: 70, id: FIRST_SCORE_ID
  }));
  const nextDay = await store.scoreAnswer(identity, answerScored({
    localDate: "2026-08-31", questionKey: "redis-cache-penetration", total: 80, id: SECOND_SCORE_ID
  }));

  assert.equal(nextDay.status, "ok");
  // 0.6 * 80 + 0.4 * 70
  assert.equal(nextDay.data.profile.questionMastery["redis-cache-penetration"].masteryScore, 76);
  assert.equal(nextDay.data.profile.questionMastery["redis-cache-penetration"].attempts, 2);
  assert.equal(drive.createdJsonFiles.filter((file) => file.name.startsWith("snapshot-")).length, 2);
});

test("a failed projection returns profile_cache_pending without duplicating the event", async () => {
  const state = { failFor: (name) => name.startsWith("snapshot-") };
  const { drive, store } = await setupWithBank({ driveOptions: { state } });
  const result = await store.scoreAnswer(identity, answerScored({
    localDate: "2026-08-30", questionKey: "redis-cache-penetration", total: 70, id: FIRST_SCORE_ID
  }));

  assert.equal(result.status, "profile_cache_pending");
  assert.equal(result.data.profileRebuildRequired, true);
  assert.equal(drive.createdJsonFiles.filter((file) => file.name.startsWith("snapshot-")).length, 0);
  assert.equal(drive.createdJsonFiles.filter((file) => file.name.startsWith("event-")).length, 3);
});

test("retrying with the same event key after a failed projection backfills only the snapshot", async () => {
  const state = { failFor: (name) => name.startsWith("snapshot-") };
  const { drive, store } = await setupWithBank({ driveOptions: { state } });
  const event = answerScored({
    localDate: "2026-08-30", questionKey: "redis-cache-penetration", total: 70, id: FIRST_SCORE_ID
  });
  await store.scoreAnswer(identity, event);
  assert.equal(drive.createdJsonFiles.filter((file) => file.name.startsWith("snapshot-")).length, 0);
  assert.equal(drive.createdJsonFiles.filter((file) => file.name.startsWith("event-")).length, 3);

  // The same idempotency key is replayed once the drive recovers: the events
  // were already durable, so only the missing projection is backfilled.
  state.failFor = () => false;
  const retried = await store.scoreAnswer(identity, event);

  assert.equal(retried.status, "ok");
  assert.equal(retried.data.projectionReceipt.reused, false);
  assert.equal(drive.createdJsonFiles.filter((file) => file.name.startsWith("event-")).length, 3);
  assert.equal(drive.createdJsonFiles.filter((file) => file.name.startsWith("snapshot-")).length, 1);
});

test("backfilling an existing snapshot reuses it instead of creating a second one", async () => {
  const { store } = await setupWithBank();
  const event = answerScored({
    localDate: "2026-08-30", questionKey: "redis-cache-penetration", total: 70, id: FIRST_SCORE_ID
  });
  const first = await store.scoreAnswer(identity, event);
  const second = await store.scoreAnswer(identity, event);
  assert.equal(second.status, "ok");
  assert.equal(second.data.projectionReceipt.reused, true);
  assert.equal(second.data.projectionReceipt.fileId, first.data.projectionReceipt.fileId);
});

test("scoring without a question bank returns resume_required", async () => {
  const { drive, store } = setup();
  const result = await store.scoreAnswer(identity, answerScored({
    localDate: "2026-08-30", questionKey: "redis-cache-penetration", total: 70, id: FIRST_SCORE_ID
  }));
  assert.equal(result.status, "resume_required");
  assert.deepEqual(drive.createdJsonFiles.filter((file) => file.name.startsWith("snapshot-")), []);
});

test("every materialised file lives below the canonical plugin root", async () => {
  const { drive, store } = await setupWithBank();
  await store.recordClaimDecision(identity, claimDecision());
  await store.getOrCreateDailyPlan(identity, dailyPlanCreated());
  await store.scoreAnswer(identity, answerScored({
    localDate: "2026-08-30", questionKey: "redis-cache-penetration", total: 70, id: FIRST_SCORE_ID
  }));

  const expected = new Map([
    [`resume-${RESUME_VERSION}-${FINGERPRINT}.json`, ["sources", "resume", "snapshots"]],
    ["question-bank-", ["question-bank", "snapshots"]],
    ["event-", ["events"]],
    ["daily-plan-", ["plans", "daily"]],
    ["snapshot-", ["profile", "snapshots"]]
  ]);

  for (const [prefix, segments] of expected) {
    const matches = drive.createdJsonFiles.filter((file) => file.name.startsWith(prefix));
    assert.ok(matches.length > 0, `no materialised file for ${prefix}`);
    for (const file of matches) {
      assert.deepEqual(ancestryOf(drive, file), [
        "my-chatGPT-skills", "users", USER_ID, "resume-knowledge", ...segments, file.name
      ]);
    }
  }

  // No namespace-scoped directory may be created next to the plugin root.
  const namespaceScoped = [...drive.folders.values()]
    .filter((folder) => folder.parents[0] === "root");
  assert.deepEqual(namespaceScoped.map((folder) => folder.name), ["my-chatGPT-skills"]);
});
