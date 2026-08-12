# Drive Skill/User Directories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Place new Drive event and snapshot files under deterministic `sourceSkill/userId` subdirectories.

**Architecture:** Extend the Drive capability boundary with typed folder metadata and an idempotent folder resolver. `DriveDestinationAdapter` resolves independent event and snapshot Skill/user paths before running its immutable-write and read-back workflow. Legacy root-level files are untouched and excluded from new per-Skill/user snapshots.

**Tech Stack:** TypeScript, Vitest, Cloudflare Worker, Google Drive v3 REST multipart upload.

## Global Constraints

- Only new Drive files use subdirectories; existing Drive content is never moved, changed, or deleted.
- A path component is valid only when it matches `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`.
- `sourceSkill` and `userId` determine both event and snapshot paths.
- Every behavior change starts with a focused failing Vitest test.

---

### Task 1: Add folder-aware Drive boundary and hierarchy behavior

**Files:**
- Modify: `packages/workers/tests/drive-adapter.test.ts`
- Modify: `packages/workers/src/drive-adapter.ts`

**Interfaces:**
- Produces: `DriveFile` including `mimeType`; `DriveCapability.ensureFolder(parentId: string, name: string): Promise<DriveFile>`.
- Consumes: existing `DriveDestinationAdapter.sync(event): Promise<SyncOutcome>`.

- [ ] **Step 1: Write the failing hierarchy tests**

Add a memory-drive test using `sourceSkill: "algorithm-learning"` and `userId: "qiaobingyuan"`. Assert the event JSON belongs to `events/algorithm-learning/qiaobingyuan` and the snapshot JSON belongs to `snapshots/algorithm-learning/qiaobingyuan`. Assert a repeated sync reuses the same four folders rather than creating duplicates.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @reliable-drive-sync/workers test -- drive-adapter.test.ts`

Expected: FAIL because the current adapter writes JSON directly into `events` and `snapshots`.

- [ ] **Step 3: Write the minimal implementation**

Add a folder MIME constant, `isValidPathComponent`, and a private `resolveUserDirectory(parentId, sourceSkill, userId)` in the destination adapter. Make `sync` validate components before Drive I/O, resolve separate event and snapshot folders, and use those IDs for all JSON operations. Add `ensureFolder` to the test memory drive and to the production capability.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm --filter @reliable-drive-sync/workers test -- drive-adapter.test.ts`

Expected: PASS, including existing event/snapshot read-back tests.

- [ ] **Step 5: Commit the behavior**

Run: `git add packages/workers/src/drive-adapter.ts packages/workers/tests/drive-adapter.test.ts; git commit -m "feat: organize Drive files by skill and user"`

### Task 2: Add isolation, input safety, and Google folder-operation coverage

**Files:**
- Modify: `packages/workers/tests/drive-adapter.test.ts`
- Modify: `packages/workers/src/drive-adapter.ts`

**Interfaces:**
- Consumes: the folder resolver and `ensureFolder` from Task 1.
- Produces: production-safe folder lookup and deterministic duplicate-folder reuse.

- [ ] **Step 1: Write failing safety tests**

Add a test that syncs same-user events from `algorithm-learning` and `interview`, then proves each snapshot only contains its own event key. Add a test with `sourceSkill: "../unsafe"` that expects `invalid_drive_identity` and zero Drive calls. Add a mocked Google test that expects a folder multipart upload to use `application/vnd.google-apps.folder` and folder lookup to recognize the folder MIME type.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @reliable-drive-sync/workers test -- drive-adapter.test.ts`

Expected: FAIL because current snapshots read one root and the Google list filters to JSON files.

- [ ] **Step 3: Write the minimal implementation**

Preserve file MIME metadata in Google listings. Make `ensureFolder` choose an immediate child with matching name and folder MIME type, selecting the lexicographically lowest id if duplicates exist. Otherwise create a Google folder through multipart metadata. Keep JSON `create` for JSON files only.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm --filter @reliable-drive-sync/workers test -- drive-adapter.test.ts`

Expected: PASS for all focused tests.

- [ ] **Step 5: Commit the safety coverage**

Run: `git add packages/workers/src/drive-adapter.ts packages/workers/tests/drive-adapter.test.ts; git commit -m "test: cover Drive hierarchy isolation"`

### Task 3: Document, deploy, and smoke test

**Files:**
- Modify: `docs/portable-codex-mcp-setup.md`

**Interfaces:**
- Consumes: existing `DRIVE_EVENTS_PARENT_ID` and `DRIVE_SNAPSHOTS_PARENT_ID` Worker configuration.
- Produces: deployed hierarchy behavior and updated portable documentation.

- [ ] **Step 1: Document the new layout**

State that all newly written Drive records are under `<parent>/<sourceSkill>/<userId>/`, while new-device MCP setup and local Outbox behavior are unchanged.

- [ ] **Step 2: Run full verification**

Run: `pnpm test; pnpm typecheck; pnpm build; pnpm verify:build; git diff --check`

Expected: every command exits 0.

- [ ] **Step 3: Deploy and verify a new cloud event**

Run `pnpm exec wrangler deploy` from `packages/workers`. Submit a new `deployment_verification` event. Query remote D1 and require `state = 'synced'`; list both Drive parents and require the new Skill/user hierarchy, event JSON, and snapshot JSON.

- [ ] **Step 4: Commit documentation**

Run: `git add docs/portable-codex-mcp-setup.md; git commit -m "docs: explain Drive skill user hierarchy"`
