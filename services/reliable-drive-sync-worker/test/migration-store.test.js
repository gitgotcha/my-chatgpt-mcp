import assert from "node:assert/strict";
import test from "node:test";
import { createMigrationStore } from "../src/migration-store.js";
import { createLegacyReader } from "../src/legacy-reader.js";
import { createStorageLayout } from "../src/storage-layout.js";
import { canonicalHash } from "../src/event-store.js";

const FOLDER = "application/vnd.google-apps.folder";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const LEGACY_ALGORITHM_ID = "11111111-1111-4111-8111-111111111111";
const LEGACY_INTERVIEW_ID = "22222222-2222-4222-8222-222222222222";
const USERNAME = "乔炳源";
const identity = { userId: USER_ID, username: USERNAME };

// The legacy event names are fixed so tests can create a conflicting target
// with exactly the same name.
const ALGORITHM_EVENT_1 = "event-00000001-0000-4000-8000-000000000000.json";
const ALGORITHM_EVENT_2 = "event-00000002-0000-4000-8000-000000000000.json";
const INTERVIEW_EVENT_1 = "event-00000001-0000-4000-8000-000000000000.json";

function fakeDrive() {
  const folders = new Map([["root", { id: "root", name: "root", parents: [], mimeType: FOLDER }]]);
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
      const folder = { id: `folder-${++number}`, name, parents: [parentId], mimeType: FOLDER };
      folders.set(folder.id, folder);
      return folder;
    },
    async listChildren(parentId, { name } = {}) { return children(parentId, name); },
    async listJson(parentId) { return [...files.values()].filter((file) => file.parents[0] === parentId); },
    async createJson(parentId, name, value) {
      const file = { id: `file-${++number}`, name, parents: [parentId], mimeType: "application/json", value: structuredClone(value) };
      files.set(file.id, file);
      createdJsonFiles.push(file);
      return structuredClone(file);
    },
    async readJson(id) { return structuredClone(files.get(id)); }
  };
}

async function seedLegacy(drive, { domain, userId, username, events, snapshots = [] }) {
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
  async function validSource(value) {
    const source = structuredClone(value);
    if (!source || typeof source !== "object" || Array.isArray(source)) return source;
    if (!Object.hasOwn(source, "userId")) source.userId = userId;
    if (!Object.hasOwn(source, "username")) source.username = username;
    if (!Object.hasOwn(source, "contentHash")) source.contentHash = await canonicalHash(source);
    return source;
  }
  for (const [name, value] of Object.entries(events)) {
    await drive.createJson(eventsFolder.id, name, await validSource(value));
  }
  for (const [index, value] of snapshots.entries()) {
    await drive.createJson(
      snapshotsFolder.id,
      `snapshot-2026-08-0${index + 1}T00-00-00-000Z-0000000${index + 1}-0000-4000-8000-000000000000.json`,
      await validSource(value)
    );
  }
  return { root, registry, eventsFolder, snapshotsFolder };
}

function setup() {
  const drive = fakeDrive();
  const layout = createStorageLayout({ drive });
  const legacyReader = createLegacyReader({ drive });
  const userStore = {
    async verify({ userId, displayName }) {
      return { status: "ok", identity: { userId, displayName } };
    }
  };
  return {
    drive,
    layout,
    legacyReader,
    store: createMigrationStore({ legacyReader, layout, drive, userStore })
  };
}

async function seedCanonicalUser(drive) {
  const base = await drive.ensureFolder("root", "my-chatGPT-skills");
  const users = await drive.ensureFolder(base.id, "users");
  return drive.ensureFolder(users.id, USER_ID);
}

/** Pre-create a canonical target that holds content different from the source. */
async function seedConflictingTarget(drive, name, value = { different: true }) {
  const userRoot = await seedCanonicalUser(drive);
  const algorithm = await drive.ensureFolder(userRoot.id, "algorithm");
  const events = await drive.ensureFolder(algorithm.id, "events");
  return drive.createJson(events.id, name, value);
}

const legacyEvent = (suffix) => ({
  schemaVersion: "1.2",
  eventId: `30000000-0000-4000-8000-0000000000${suffix}`,
  eventKey: `legacy:${suffix}`,
  eventType: "algorithm.learning.completed"
});

async function seededHarness() {
  const harness = setup();
  await seedCanonicalUser(harness.drive);
  await seedLegacy(harness.drive, {
    domain: "algorithm",
    userId: LEGACY_ALGORITHM_ID,
    username: USERNAME,
    events: {
      [ALGORITHM_EVENT_1]: legacyEvent("01"),
      [ALGORITHM_EVENT_2]: legacyEvent("02")
    },
    snapshots: [{ schemaVersion: "1.2", headEventId: "30000000-0000-4000-8000-000000000001" }]
  });
  await seedLegacy(harness.drive, {
    domain: "interview",
    userId: LEGACY_INTERVIEW_ID,
    username: USERNAME,
    events: { [INTERVIEW_EVENT_1]: legacyEvent("03") }
  });
  // Everything created from here on is written by the code under test.
  return { ...harness, baseline: harness.drive.createdJsonFiles.length };
}

const createdSince = (drive, baseline, prefix) => drive.createdJsonFiles.slice(baseline)
  .filter((file) => !prefix || file.name.startsWith(prefix));

const LEGACY_ROOTS = ["algorithm", "interview"];

/** True when the folder is the legacy namespace root or lives below one. */
function underLegacyRoot(drive, folderId) {
  let current = drive.folders.get(folderId) ?? null;
  while (current) {
    if (LEGACY_ROOTS.includes(current.name) && (current.parents ?? [])[0] === drive.rootFolderId) return true;
    current = current.parents?.length ? drive.folders.get(current.parents[0]) ?? null : null;
  }
  return false;
}

// Only the legacy objects matter here: the copies the migration creates below
// the canonical root are the point of the run, not a mutation of the source.
const objectsIn = (drive) => [...drive.files.values()]
  .filter((file) => underLegacyRoot(drive, file.parents[0]))
  .filter((file) => file.name.startsWith("event-") || file.name.startsWith("snapshot-"))
  .map((file) => ({ id: file.id, name: file.name, parent: file.parents[0], value: structuredClone(file.value) }))
  .sort((left, right) => left.id.localeCompare(right.id));

// ------------------------------------------------------------------- dry-run

test("a dry run reports source, target and content hashes without writing", async () => {
  const { drive, store, baseline } = await seededHarness();
  const plan = await store.plan(identity, { displayName: USERNAME, domains: ["algorithm", "interview"] });

  assert.equal(plan.status, "ok");
  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.summary.total, 4);
  assert.equal(plan.summary.copy, 4);
  assert.equal(plan.summary.skip, 0);
  assert.equal(plan.summary.conflict, 0);

  for (const item of plan.items) {
    assert.match(item.source, /^root\/(algorithm|interview)\/users\//);
    assert.match(item.target, new RegExp(`^my-chatGPT-skills/users/${USER_ID}/(algorithm|interview)/`));
    assert.match(item.contentHash, /^[0-9a-f]{64}$/);
    assert.equal(item.action, "copy");
  }

  // A dry run creates nothing at all.
  assert.deepEqual(createdSince(drive, baseline), []);
});

test("a dry run matches legacy registrations by the normalised name", async () => {
  const { store } = await seededHarness();
  const plan = await store.plan(identity, { displayName: `  ${USERNAME}  `, domains: ["algorithm"] });
  assert.equal(plan.summary.total, 3);

  const other = await store.plan(identity, { displayName: "另一个人", domains: ["algorithm"] });
  assert.equal(other.summary.total, 0);
});

test("a dry run marks identical targets as skipped", async () => {
  const { drive, store, baseline } = await seededHarness();
  const plan = await store.plan(identity, { displayName: USERNAME, domains: ["algorithm"] });
  await store.execute(identity, {
    migrationId: "99999999-9999-4999-8999-000000000001",
    approvedPlanHash: plan.planHash,
    displayName: USERNAME,
    domains: ["algorithm"]
  });

  const rescanned = await store.plan(identity, { displayName: USERNAME, domains: ["algorithm"] });
  assert.equal(rescanned.summary.copy, 0);
  assert.equal(rescanned.summary.skip, 3);
  assert.equal(rescanned.summary.conflict, 0);
  assert.equal(createdSince(drive, baseline, "event-").length, 2);
});

test("a dry run reports a conflict instead of overwriting a different target", async () => {
  const { drive, store } = await seededHarness();
  await seedConflictingTarget(drive, ALGORITHM_EVENT_1);

  const plan = await store.plan(identity, { displayName: USERNAME, domains: ["algorithm"] });
  assert.equal(plan.summary.conflict, 1);
  assert.equal(plan.summary.copy, 2);
  const conflict = plan.items.find((item) => item.action === "conflict");
  assert.equal(conflict.sourceName, ALGORITHM_EVENT_1);
  assert.match(conflict.contentHash, /^[0-9a-f]{64}$/);
});

// -------------------------------------------------------------------- execute

test("execute copies only missing objects and verifies their content hash", async () => {
  const { drive, store, baseline } = await seededHarness();
  const plan = await store.plan(identity, { displayName: USERNAME, domains: ["algorithm", "interview"] });
  const result = await store.execute(identity, {
    migrationId: "99999999-9999-4999-8999-000000000002",
    approvedPlanHash: plan.planHash,
    displayName: USERNAME,
    domains: ["algorithm", "interview"]
  });

  assert.equal(result.status, "ok");
  assert.equal(result.summary.copied, 4);
  assert.equal(result.summary.skip, 0);

  const copied = createdSince(drive, baseline).filter((file) => file.name.startsWith("event-") || file.name.startsWith("snapshot-"));
  assert.equal(copied.length, 4);
  assert.deepEqual(copied.map((file) => file.name).sort(), plan.items.map((item) => item.sourceName).sort());
});

test("execute never modifies, moves or deletes the legacy objects", async () => {
  const { drive, store } = await seededHarness();
  const before = objectsIn(drive);
  assert.equal(before.length, 4);

  const plan = await store.plan(identity, { displayName: USERNAME, domains: ["algorithm", "interview"] });
  await store.execute(identity, {
    migrationId: "99999999-9999-4999-8999-000000000003",
    approvedPlanHash: plan.planHash,
    displayName: USERNAME,
    domains: ["algorithm", "interview"]
  });

  assert.deepEqual(objectsIn(drive), before);
});

test("execute stops when a target key already holds different content", async () => {
  const { drive, store } = await seededHarness();
  await seedConflictingTarget(drive, ALGORITHM_EVENT_1);
  const baseline = drive.createdJsonFiles.length;

  const plan = await store.plan(identity, { displayName: USERNAME, domains: ["algorithm"] });
  assert.equal(plan.summary.conflict, 1);

  await assert.rejects(() => store.execute(identity, {
    migrationId: "99999999-9999-4999-8999-000000000004",
    approvedPlanHash: plan.planHash,
    displayName: USERNAME,
    domains: ["algorithm"]
  }), /migration_conflict/);

  // Stopping happens before any copy is written.
  assert.deepEqual(createdSince(drive, baseline), []);
});

test("execute refuses an approved hash that no longer matches the scan", async () => {
  const { drive, store } = await seededHarness();
  const plan = await store.plan(identity, { displayName: USERNAME, domains: ["algorithm"] });

  // The legacy data changes after the dry run, so the stale approval is void.
  const legacyEvents = [...drive.folders.values()]
    .find((folder) => folder.name === "events" && [...drive.files.values()].some((file) => file.parents[0] === folder.id));
  await drive.createJson(legacyEvents.id, "event-00000099-0000-4000-8000-000000000000.json", legacyEvent("99"));

  await assert.rejects(() => store.execute(identity, {
    migrationId: "99999999-9999-4999-8999-000000000005",
    approvedPlanHash: plan.planHash,
    displayName: USERNAME,
    domains: ["algorithm"]
  }), /migration_plan_stale/);
});

test("execute requires an approved plan hash", async () => {
  const { store } = await seededHarness();
  await assert.rejects(() => store.execute(identity, {
    migrationId: "99999999-9999-4999-8999-000000000006",
    displayName: USERNAME,
    domains: ["algorithm"]
  }), /migration_plan_required/);
});

test("execute is idempotent and produces an auditable receipt", async () => {
  const { drive, store, baseline } = await seededHarness();
  const plan = await store.plan(identity, { displayName: USERNAME, domains: ["algorithm"] });
  const migrationId = "99999999-9999-4999-8999-000000000007";
  const first = await store.execute(identity, {
    migrationId,
    approvedPlanHash: plan.planHash,
    displayName: USERNAME,
    domains: ["algorithm"]
  });

  assert.equal(first.status, "ok");
  assert.equal(first.receipt.migrationId, migrationId);
  assert.equal(first.receipt.planHash, plan.planHash);
  assert.equal(first.receipt.displayName, USERNAME);
  assert.equal(first.receipt.items.length, 3);
  for (const item of first.receipt.items) {
    assert.ok(item.source && item.target && item.contentHash && item.action);
  }
  assert.equal(first.receiptFile.name, `migration-${migrationId}-receipt.json`);

  // Re-running with the same approved hash copies nothing new.
  const second = await store.execute(identity, {
    migrationId,
    approvedPlanHash: plan.planHash,
    displayName: USERNAME,
    domains: ["algorithm"]
  });
  assert.equal(second.summary.copied, 0);
  assert.equal(second.summary.skip, 3);
  assert.equal(createdSince(drive, baseline, "event-").length, 2);
});

test("an unregistered identity and unknown domains are refused", async () => {
  const { store } = await seededHarness();
  await assert.rejects(
    () => store.plan(identity, { displayName: USERNAME, domains: ["resume-knowledge"] }),
    /invalid_migration_domains/
  );
  await assert.rejects(
    () => store.plan(identity, { displayName: "  ", domains: ["algorithm"] }),
    /invalid_display_name/
  );
  await assert.rejects(
    () => store.plan({ userId: "not-a-uuid", username: USERNAME }, { displayName: USERNAME, domains: ["algorithm"] }),
    /identity_mismatch/
  );
});

test("legacy source identity accepts normalised usernames and rejects mismatches before writes", async () => {
  const { drive, store, baseline } = await seededHarness();
  const source = [...drive.files.values()].find((file) => file.name === ALGORITHM_EVENT_1);
  source.value.username = `  ${USERNAME}  `;
  source.value.contentHash = await canonicalHash(source.value);
  const accepted = await store.plan(identity, { displayName: USERNAME, domains: ["algorithm"] });
  assert.equal(accepted.summary.conflict, 0);

  source.value.userId = LEGACY_INTERVIEW_ID;
  source.value.contentHash = await canonicalHash(source.value);
  const rejected = await store.plan(identity, { displayName: USERNAME, domains: ["algorithm"] });
  assert.equal(rejected.summary.conflict, 1);
  await assert.rejects(() => store.execute(identity, {
    migrationId: "99999999-9999-4999-8999-000000000008",
    approvedPlanHash: rejected.planHash,
    displayName: USERNAME,
    domains: ["algorithm"]
  }), /migration_conflict/);
  assert.deepEqual(createdSince(drive, baseline), []);
});

test("legacy sources with missing hashes, incorrect hashes, or non-objects fail closed", async () => {
  for (const [label, mutate] of [
    ["missing", (value) => { delete value.contentHash; }],
    ["incorrect", (value) => { value.contentHash = "bad"; }],
    ["non-object", () => "broken source"]
  ]) {
    const { drive, store, baseline } = await seededHarness();
    const source = [...drive.files.values()].find((file) => file.name === ALGORITHM_EVENT_1);
    const candidate = structuredClone(source.value);
    const changed = mutate(candidate);
    source.value = changed === undefined ? candidate : changed;
    const plan = await store.plan(identity, { displayName: USERNAME, domains: ["algorithm"] });
    assert.equal(plan.summary.conflict, 1, label);
    await assert.rejects(() => store.execute(identity, {
      migrationId: "99999999-9999-4999-8999-000000000009",
      approvedPlanHash: plan.planHash,
      displayName: USERNAME,
      domains: ["algorithm"]
    }), /migration_conflict/, label);
    assert.deepEqual(createdSince(drive, baseline), [], label);
  }
});

test("duplicate legacy registrations and source target keys fail before any copy", async () => {
  const registrationHarness = await seededHarness();
  const algorithmRegistry = [...registrationHarness.drive.folders.values()]
    .find((folder) => folder.name === "user-registry"
      && registrationHarness.drive.folders.get(folder.parents[0])?.name === "algorithm");
  await registrationHarness.drive.createJson(
    algorithmRegistry.id,
    `registration-${LEGACY_ALGORITHM_ID}.json`,
    { schemaVersion: "1.2", status: "active", userId: LEGACY_ALGORITHM_ID, username: USERNAME }
  );
  await assert.rejects(
    () => registrationHarness.store.plan(identity, { displayName: USERNAME, domains: ["algorithm"] }),
    /legacy_registration_conflict/
  );

  const { drive, store } = await seededHarness();
  const source = [...drive.files.values()].find((file) => file.name === ALGORITHM_EVENT_1);
  const duplicate = structuredClone(source.value);
  duplicate.eventKey = "legacy:duplicate";
  duplicate.contentHash = await canonicalHash(duplicate);
  await drive.createJson(source.parents[0], ALGORITHM_EVENT_1, duplicate);
  const baseline = drive.createdJsonFiles.length;
  const plan = await store.plan(identity, { displayName: USERNAME, domains: ["algorithm"] });
  assert.equal(plan.summary.conflict, 2);
  await assert.rejects(() => store.execute(identity, {
    migrationId: "99999999-9999-4999-8999-000000000010",
    approvedPlanHash: plan.planHash,
    displayName: USERNAME,
    domains: ["algorithm"]
  }), /migration_conflict/);
  assert.deepEqual(createdSince(drive, baseline), []);
});
