# D1 Interview Artifact Staging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the un-deployed R2 interview-artifact staging layer with D1 BLOB staging while preserving asynchronous QStash-to-Drive delivery.

**Architecture:** Artifact ingress validates one-MiB immutable submissions and persists metadata plus raw bytes in D1 before scheduling QStash. The sync handler reads bytes from D1, writes the final Drive file, marks the job synced, and clears the staging bytes without reopening delivery.

**Tech Stack:** TypeScript, Cloudflare Workers, D1/SQLite, QStash, Google Drive REST API, Vitest, pnpm.

## Global Constraints

- Do not create or bind an R2 bucket.
- The decoded artifact size is at most 1,048,576 bytes.
- Existing event jobs, notices, QStash signatures, and Drive event/snapshot hierarchy remain compatible.
- D1 staging content is private, deleted after durable Drive success, and never returned by an unauthenticated endpoint.

---

### Task 1: Make the artifact protocol enforce D1’s size boundary

**Files:**
- Modify: `packages/protocol/src/artifact.ts`
- Modify: `packages/protocol/tests/artifact.test.ts`

**Interfaces:** `parseArtifactSubmission(input): Promise<ArtifactSubmission>` rejects decoded content over `1_048_576` bytes.

- [ ] Write a failing boundary test: `await expect(parseArtifactSubmission(withBytes(1_048_577))).rejects.toThrow("1 MiB")`.
- [ ] Run `pnpm exec vitest run packages/protocol/tests/artifact.test.ts` and confirm the red result.
- [ ] Set `const MAX_ARTIFACT_BYTES = 1024 * 1024` and use the same error before and after decoding.
- [ ] Run `pnpm exec vitest run packages/protocol/tests/artifact.test.ts && pnpm typecheck`.
- [ ] Commit with `fix: cap staged artifacts at one MiB`.

### Task 2: Persist and consume artifact bytes in D1

**Files:**
- Create: `packages/workers/migrations/0004_d1_artifact_content.sql`
- Modify: `packages/workers/src/artifact-jobs.ts`
- Create: `packages/workers/tests/artifact-jobs.test.ts`

**Interfaces:** `createOrGet(artifact)`, `loadContent(jobId): Promise<Uint8Array | null>`, and `markSyncedAndClearContent(jobId, owner): Promise<boolean>`.

- [ ] Add red tests covering insert, exact duplicate, checksum conflict, load, and clear-after-sync.
- [ ] Run `pnpm exec vitest run packages/workers/tests/artifact-jobs.test.ts` and confirm it fails before the implementation.
- [ ] Add `artifact_contents(artifact_key PRIMARY KEY, content BLOB, byte_length, created_at)` and lease-guarded content deletion after Drive success.
- [ ] Run the focused test and `pnpm typecheck`.
- [ ] Commit with `feat: stage interview artifacts in D1`.

### Task 3: Remove R2 from ingress and artifact sync

**Files:**
- Modify: `packages/workers/src/ingress.ts`
- Modify: `packages/workers/src/artifact-flow.ts`
- Modify: `packages/workers/src/index.ts`
- Modify: `packages/workers/tests/ingress.test.ts`
- Create: `packages/workers/tests/artifact-flow.test.ts`

**Interfaces:** `/v1/artifacts` returns 202 only after D1 content persistence; signed artifact sync reads D1 content and clears it only after a Drive success.

- [ ] Write red ingress/sync tests for persistence, 204 Drive success cleanup, retryable Drive failure retention, and permanent missing content.
- [ ] Run `pnpm exec vitest run packages/workers/tests/ingress.test.ts packages/workers/tests/artifact-flow.test.ts` and confirm red.
- [ ] Replace R2 interfaces with repository methods while retaining QStash state and signed envelope rules.
- [ ] Run the focused suites and `pnpm typecheck`.
- [ ] Commit with `refactor: sync artifacts from D1 staging`.

### Task 4: Remove R2 configuration, deploy, and verify

**Files:**
- Modify: `packages/workers/wrangler.toml`
- Modify: `.env.example`
- Modify: `docs/deployment-windows.md`

- [ ] Add a configuration test that `wrangler.toml` contains neither `r2_buckets` nor `ARTIFACTS`.
- [ ] Remove the R2 binding and document that no new Cloudflare resource or secret is required.
- [ ] Run `pnpm test && pnpm typecheck && pnpm build && pnpm verify:build && git diff --check`.
- [ ] Run `npx wrangler d1 migrations apply reliable-drive-sync --remote && npx wrangler deploy`.
- [ ] Submit a sub-1 MiB artifact through the real path and verify its Drive file.
- [ ] Commit with `chore: deploy D1 artifact staging` and run `git push origin HEAD:main`.
