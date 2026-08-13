# Interview Skills MCP Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move mock-interview and interview-review persistence and reads behind reliable-drive-sync MCP, including immutable binary artifacts and candidate context.

**Architecture:** Keep `SyncEvent` unchanged for small, append-only business facts. Add an `ArtifactSubmission` protocol with immutable metadata and bytes, a local artifact Outbox, D1/R2-backed artifact jobs, and signed QStash synchronization to Drive. The interview Skills become MCP-only clients and use candidate summary/context tools instead of direct Drive operations.

**Tech Stack:** TypeScript, Vitest, better-sqlite3, Cloudflare Workers/D1/R2, QStash, Google Drive v3 REST, Markdown Skills.

## Global Constraints

- `sourceSkill` for the new interview flow is exactly `interview`; `userId` is exactly the stable `candidateId`.
- `candidateId`, `sessionId`, and `sourceSkill` must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`.
- `artifactKey` is immutable and retries must reuse it; same key with changed checksum or metadata returns a conflict.
- Artifact bytes are decoded Base64 of at most 10 MiB and must match a submitted SHA-256 value.
- Only JSON, Markdown, and DOCX MIME types are accepted; Drive paths are server-generated.
- Existing Drive candidate data stays read-only and new Skills must not directly call Drive connectors.
- No actual credential values may enter code, tests, skill files, or Git history.

---

### Task 1: Define and test immutable artifact protocol

**Files:**
- Create: `packages/protocol/src/artifact.ts`
- Modify: `packages/protocol/package.json`
- Modify: `packages/protocol/tests/artifact.test.ts`

**Interfaces:**
- Produces `ArtifactSubmission`, `parseArtifactSubmission(input)`, `artifactObjectKey(submission)` and `sha256Hex(bytes)`.
- Consumes no Worker or MCP implementation.

- [ ] **Step 1: Write failing protocol tests**

Test a valid JSON artifact with `candidateId: "candidate-001"`, `sourceSkill: "interview"`, `sessionId: "MOCK-001"`, checksum of decoded bytes and valid Base64. Test rejection of a 10 MiB + 1 byte payload, wrong checksum, `../unsafe` candidate, unsupported MIME type, and a filename containing `/`.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @reliable-drive-sync/protocol test -- artifact.test.ts`

Expected: FAIL because `artifact.ts` and its parser do not exist.

- [ ] **Step 3: Implement the protocol**

Create a parser that validates exact required fields, path-safe components, allowed MIME/file-name pairs, Base64 decoding, byte limit and SHA-256. Export the module through the package export map. Derive `artifactObjectKey` as `interview/<candidateId>/<sessionId>/<sha256>-<fileName>`.

- [ ] **Step 4: Verify GREEN and commit**

Run: `pnpm --filter @reliable-drive-sync/protocol test -- artifact.test.ts`

Run: `git add packages/protocol; git commit -m "feat: define immutable artifact protocol"`

### Task 2: Add local artifact Outbox and MCP tools

**Files:**
- Modify: `packages/mcp-server/src/outbox.ts`
- Create: `packages/mcp-server/src/artifact-service.ts`
- Modify: `packages/mcp-server/src/fetch-ingress.ts`
- Modify: `packages/mcp-server/src/index.ts`
- Create: `packages/mcp-server/tests/artifact-service.test.ts`
- Modify: `packages/mcp-server/tests/fetch-ingress.test.ts`

**Interfaces:**
- Consumes `ArtifactSubmission` from Task 1.
- Produces MCP tools `submit_artifact`, `list_candidates`, `get_candidate_context`, `read_artifact`.

- [ ] **Step 1: Write failing artifact Outbox tests**

Test that `submit_artifact` inserts an artifact record before calling transport, returns `cloud_accepted` only for HTTP 202, preserves a rejected/timeout artifact as pending, and reconstructs `sending` as pending on a new Outbox instance. Test GET clients add the same Bearer header and parse expected JSON.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @reliable-drive-sync/mcp-server test -- artifact-service.test.ts fetch-ingress.test.ts`

Expected: FAIL because no artifact Outbox or interview read tools exist.

- [ ] **Step 3: Implement local reliable interfaces**

Add `local_outbox_artifacts` keyed by `artifact_key`, with metadata JSON, content bytes/Base64, state, attempts and cloud job ID. Add a 2-second abortable POST to `/v1/artifacts`; add authenticated GET clients for `/v1/candidates`, `/v1/candidates/<candidateId>/context`, and `/v1/artifacts/<artifactKey>`. Register zod schemas and handlers in MCP index. All tool results use `cloud_accepted`/`pending` semantics and no tool claims final Drive success.

- [ ] **Step 4: Verify GREEN and commit**

Run: `pnpm --filter @reliable-drive-sync/mcp-server test`

Run: `git add packages/mcp-server; git commit -m "feat: add reliable interview artifact MCP tools"`

### Task 3: Persist artifact jobs, candidates, and ingress routes in Worker

**Files:**
- Create: `packages/workers/migrations/0003_add_interview_artifacts.sql`
- Modify: `packages/workers/src/db.ts`
- Modify: `packages/workers/src/ingress.ts`
- Create: `packages/workers/tests/artifact-ingress.test.ts`
- Modify: `packages/workers/tests/db.test.ts`

**Interfaces:**
- Consumes `ArtifactSubmission` from Task 1 and MCP HTTP routes from Task 2.
- Produces `ArtifactRepository`, candidate summaries/context projections, and authenticated `/v1/artifacts`, `/v1/candidates`, `/v1/candidates/:id/context`, `/v1/artifacts/:key` routes.

- [ ] **Step 1: Write failing D1 and ingress tests**

Test two concurrent POSTs of identical artifact return the same job without duplicate records. Test reused key with altered checksum returns HTTP 409. Test unauthenticated and malformed artifacts return 401/400 with no D1 mutation. Test `list_candidates` only returns summary fields, and unknown candidate context returns 404.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @reliable-drive-sync/workers test -- artifact-ingress.test.ts db.test.ts`

Expected: FAIL because migration, repository and routes do not exist.

- [ ] **Step 3: Implement D1 schema and handlers**

Add `artifact_jobs` with unique `artifact_key`, checksum, MIME, metadata JSON, R2 key, Drive file ID, dependencies, state, error, lease and timestamps. Add `interview_candidates` with stable candidate ID, summary fields, active resume, domains and profile JSON projection. Route only safe reads through authenticated ingress. Project `interview.candidate_registered` and `interview.resume_registered` at event acceptance; reject context reads for candidates that are not in the new projection with `candidate_not_migrated`.

- [ ] **Step 4: Verify GREEN and commit**

Run: `pnpm --filter @reliable-drive-sync/workers test -- artifact-ingress.test.ts db.test.ts`

Run: `git add packages/workers/migrations packages/workers/src/db.ts packages/workers/src/ingress.ts packages/workers/tests; git commit -m "feat: accept interview artifacts and candidate context"`

### Task 4: Add R2 staging and Drive artifact synchronization

**Files:**
- Modify: `packages/workers/src/index.ts`
- Modify: `packages/workers/src/dispatcher.ts`
- Modify: `packages/workers/src/qstash.ts`
- Modify: `packages/workers/src/sync.ts`
- Modify: `packages/workers/src/drive-adapter.ts`
- Create: `packages/workers/src/artifact-sync.ts`
- Modify: `packages/workers/wrangler.toml`
- Modify: `packages/workers/tests/dispatcher.test.ts`
- Modify: `packages/workers/tests/sync.test.ts`
- Create: `packages/workers/tests/artifact-sync.test.ts`

**Interfaces:**
- Consumes `ArtifactRepository`, R2 binding `ARTIFACTS`, and `DRIVE_ARTIFACTS_PARENT_ID`.
- Produces signed QStash artifact envelopes and immutable Drive files under `artifacts/interview/<candidateId>/<sessionId>/`.

- [ ] **Step 1: Write failing sync tests**

Test a valid artifact is staged under deterministic R2 key, dispatched with an artifact envelope, uploaded to the expected Drive directory and read back with same bytes/checksum. Test unsynced dependency returns retryable without upload, duplicate delivery avoids a second Drive file, missing artifact parent binding stays retryable, and duplicate key/content mismatch stays permanent/409.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @reliable-drive-sync/workers test -- artifact-sync.test.ts sync.test.ts dispatcher.test.ts`

Expected: FAIL because dispatcher and sync only understand event jobs and Drive has no binary artifact path.

- [ ] **Step 3: Implement the smallest shared dispatch path**

Extend QStash envelope with discriminant `kind: "event" | "artifact"`; keep event behavior unchanged. Stage accepted bytes to `env.ARTIFACTS.put(r2Key, bytes, { httpMetadata: { contentType } })`, verify same-key retries by checksum, then dispatch artifact jobs. Add Drive folder resolver for `artifacts/interview/<candidateId>/<sessionId>` and binary create/read methods. The sync handler claims the correct job type, checks dependencies, uploads and readback-validates artifact bytes, then marks it synced. Preserve signed raw-body verification and safe retry/non-retry outcomes.

- [ ] **Step 4: Verify GREEN and commit**

Run: `pnpm --filter @reliable-drive-sync/workers test`

Run: `git add packages/workers; git commit -m "feat: synchronize interview artifacts through R2"`

### Task 5: Convert the interview Skills to MCP-only flows

**Files:**
- Modify: `C:/Users/27846/.codex/skills/conducting-java-backend-mock-interviews/SKILL.md`
- Modify: `C:/Users/27846/.codex/skills/conducting-java-backend-mock-interviews/references/candidate-profile-integration.md`
- Modify: `C:/Users/27846/.codex/skills/reviewing-java-backend-interviews/SKILL.md`
- Modify: `C:/Users/27846/.codex/skills/reviewing-java-backend-interviews/references/google-drive-runtime.md`
- Create: `C:/Users/27846/.codex/skills/conducting-java-backend-mock-interviews/references/reliable-sync-runtime.md`
- Create: `C:/Users/27846/.codex/skills/reviewing-java-backend-interviews/references/reliable-sync-runtime.md`

**Interfaces:**
- Consumes the MCP tools from Task 2.
- Produces exact Skill instructions that prohibit direct Drive connectors for ordinary interview data.

- [ ] **Step 1: Write a failing contract assertion**

Add a text-level validation script/test that requires both Skill files to mention `reliable_drive_sync.submit_artifact`, `list_candidates`, `get_candidate_context`, and the exact `cloud_accepted`/`pending` wording; it must reject direct-write language for sessions, reviews, profiles or reports.

- [ ] **Step 2: Verify RED**

Run the contract assertion. Expected: FAIL because the current Skills require direct Google Drive persistence.

- [ ] **Step 3: Rewrite runtime instructions**

Replace all normal Drive read/write instructions with candidate-summary/context/asset MCP calls. Preserve CandidateIndex first, explicit second confirmation, domain locking, immutable raw evidence, mock/real review policies and report rendering. State that candidate detail retrieval is unavailable for `candidate_not_migrated`, and never fall back to direct Drive. Direct Drive is not used for regular interview artifacts or profile updates.

- [ ] **Step 4: Verify GREEN and record change**

Run the contract assertion and inspect the changed Skill text. Commit only the repository-contained test/documentation; report the exact external Skill paths modified because those installed Skills are not part of the Git repository.

### Task 6: Provision, deploy, and run end-to-end smoke check

**Files:**
- Modify: `docs/deployment-windows.md`
- Modify: `docs/system-design-for-skill-integration.md`
- Create: `docs/operations/interview-artifact-smoke-check.md`

**Interfaces:**
- Consumes R2 bucket `reliable-drive-sync-artifacts`, `DRIVE_ARTIFACTS_PARENT_ID`, existing Drive OAuth, D1 and QStash secrets.
- Produces deployed MCP endpoints and documented operational checks.

- [ ] **Step 1: Update deployment documentation**

Document creation/binding of the R2 bucket, creation of an artifacts parent Drive folder, setting `DRIVE_ARTIFACTS_PARENT_ID`, applying migration `0003`, and the fact that existing local clients need only a rebuild/restart.

- [ ] **Step 2: Run full verification**

Run: `pnpm test; pnpm typecheck; pnpm build; pnpm verify:build; git diff --check`

Expected: every command exits 0.

- [ ] **Step 3: Provision and deploy**

Create the R2 bucket only if absent, bind it in `wrangler.toml`, apply D1 migrations remotely, set the non-secret Drive artifact parent ID, deploy the Worker, rebuild local MCP and restart its session hook target.

- [ ] **Step 4: Smoke test**

Submit a fictional `TEST-candidate-001` JSON session, Markdown transcript and DOCX report plus `interview.mock_session_created`. Require D1 `synced` for all keys, Drive artifacts in the specified session folder and event/snapshot in the interview candidate directories. Repeat the same artifact key and verify no duplicate Drive file.

- [ ] **Step 5: Commit and push**

Run: `git add docs packages; git commit -m "docs: document interview MCP deployment"; git push origin HEAD:main`
