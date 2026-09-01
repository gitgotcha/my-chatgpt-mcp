# Local Outbox Architecture Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore local SQLite and cloud D1/QStash Outboxes for schema-1.2 `submit_event`, remove remote MCP/Tunnel code, update all affected Skills, and push both repositories.

**Architecture:** The local stdio MCP durably stages write envelopes in SQLite and acknowledges them only after the Worker persists a D1 job. QStash asynchronously invokes the current schema-1.2 Drive dispatcher; read-only event types use a separate authenticated query route.

**Tech Stack:** Node.js 22+, `node:sqlite`, Cloudflare Workers, D1, QStash, JavaScript `node:test`, Python `unittest`, PowerShell, Git.

**Spec:** `docs/superpowers/specs/2026-09-01-local-outbox-architecture-restoration-design.md`

## Global Constraints

- Preserve schema `1.2`, the canonical Drive layout, and existing Drive/D1 data.
- Expose exactly one local MCP tool: `submit_event`.
- No remote `/mcp/<token>`, Secure MCP Tunnel, OAuth connector, or direct Skill-to-Drive write.
- A write acknowledgement never claims immediate Drive completion.
- Production code follows red-green-refactor; every new behavior is first observed failing.

---

### Task 1: D1 schema-1.2 Outbox and authenticated ingress

**Files:**
- Create: `services/reliable-drive-sync-worker/migrations/0001_initial.sql`
- Create: `services/reliable-drive-sync-worker/migrations/0002_add_sync_event_schema_version.sql`
- Create: `services/reliable-drive-sync-worker/migrations/0003_interview_artifacts.sql`
- Create: `services/reliable-drive-sync-worker/migrations/0004_d1_artifact_content.sql`
- Create: `services/reliable-drive-sync-worker/migrations/0005_schema12_jobs.sql`
- Create: `services/reliable-drive-sync-worker/src/job-repository.js`
- Create: `services/reliable-drive-sync-worker/src/ingress.js`
- Create: `services/reliable-drive-sync-worker/test/job-repository.test.js`
- Create: `services/reliable-drive-sync-worker/test/ingress.test.js`

**Interfaces:**
- Consumes: `inspectEnvelope(args)` and `MCP_BEARER_TOKEN`.
- Produces: `D1JobRepository.createOrGet(envelope)`, `loadEnvelope(jobId)`, lease/state methods, and `createIngressHandler(...)` for `POST /v1/jobs`.

- [ ] **Step 1: Write failing repository and ingress tests**

  Cover literal outcomes: a valid envelope returns `202 {jobId,state}` after one insert; identical `requestId` reuses the job; conflicting JSON returns `409`; missing/wrong bearer returns `401/403`; malformed envelopes return `400`; existing historical tables are untouched.

- [ ] **Step 2: Run the focused tests and verify RED**

  Run: `node --test services/reliable-drive-sync-worker/test/job-repository.test.js services/reliable-drive-sync-worker/test/ingress.test.js`

  Expected: FAIL because the repository, routes, and `schema12_jobs` migration do not exist.

- [ ] **Step 3: Implement the minimal D1 repository and ingress**

  Store the complete canonical envelope JSON, a canonical hash, `request_id`, job state, leases, attempts, errors, and timestamps. Use `INSERT OR IGNORE` plus a readback/hash comparison. Return `202` only after readback.

- [ ] **Step 4: Run focused and Worker tests**

  Run: `npm run test:worker`

  Expected: all tests pass.

- [ ] **Step 5: Commit**

  `git commit -m "feat: restore schema 1.2 D1 job outbox"`

### Task 2: QStash dispatch, signed sync, failure callback, and Cron

**Files:**
- Create: `services/reliable-drive-sync-worker/src/qstash.js`
- Create: `services/reliable-drive-sync-worker/src/dispatcher.js`
- Create: `services/reliable-drive-sync-worker/src/sync.js`
- Create: `services/reliable-drive-sync-worker/src/reconciler.js`
- Create: `services/reliable-drive-sync-worker/test/dispatcher.test.js`
- Create: `services/reliable-drive-sync-worker/test/sync.test.js`
- Modify: `services/reliable-drive-sync-worker/src/index.js`
- Modify: `services/reliable-drive-sync-worker/wrangler.toml`

**Interfaces:**
- Consumes: Task 1 lease/state repository and existing `dispatchSubmitEvent(env, envelope, deps)`.
- Produces: `/v1/sync`, `/v1/qstash/failure`, signed retry behavior, and scheduled reconciliation.

- [ ] **Step 1: Write failing dispatch and sync tests**

  Prove QStash publish records `broker_queued`; failed publish stays recoverable; invalid signatures never load a job; `ok` and `already_scored_today` become `synced`; retryable statuses return `503`; permanent protocol conflicts become `needs_attention`; duplicate signed delivery of `synced` returns `204`.

- [ ] **Step 2: Run focused tests and verify RED**

  Run: `node --test services/reliable-drive-sync-worker/test/dispatcher.test.js services/reliable-drive-sync-worker/test/sync.test.js`

  Expected: FAIL because the QStash pipeline is absent.

- [ ] **Step 3: Implement minimal dispatch and sync state machine**

  Port the previously verified HMAC verification and lease fences, adapted to full schema-1.2 envelopes and the current Drive dispatcher. Restore the existing D1 binding and five-minute/hourly/six-hourly Cron entries without exposing secrets.

- [ ] **Step 4: Run the Worker suite**

  Run: `npm run test:worker`

  Expected: all tests pass.

- [ ] **Step 5: Commit**

  `git commit -m "feat: restore qstash delivery pipeline"`

### Task 3: Read-only identity and query routes

**Files:**
- Modify: `services/reliable-drive-sync-worker/src/user-store.js`
- Modify: `services/reliable-drive-sync-worker/src/submit-event.js`
- Modify: `services/reliable-drive-sync-worker/src/ingress.js`
- Modify: `services/reliable-drive-sync-worker/test/user-store.test.js`
- Modify: `services/reliable-drive-sync-worker/test/ingress.test.js`

**Interfaces:**
- Produces: `userStore.findByDisplayName(displayName)`, `GET /v1/identity`, and allow-listed `POST /v1/query`.

- [ ] **Step 1: Write failing read-only route tests**

  Prove lookup returns an existing identity without creating folders; unknown names return `404`; duplicates return conflict; query allows session list/load and migration dry-run; every write event and migration execute is rejected by `/v1/query`.

- [ ] **Step 2: Run focused tests and verify RED**

  Run: `node --test services/reliable-drive-sync-worker/test/user-store.test.js services/reliable-drive-sync-worker/test/ingress.test.js`

- [ ] **Step 3: Implement read-only lookup/query boundaries**

  Reuse current Drive/user-store validation. Add session list/load to the read-only identity set so a query can never create a user as a side effect.

- [ ] **Step 4: Run the Worker suite and commit**

  Run: `npm run test:worker`

  Commit: `git commit -m "feat: add read-only identity and query routes"`

### Task 4: Local SQLite Outbox and stdio MCP

**Files:**
- Create: `tools/reliable-drive-sync-mcp/local-outbox.mjs`
- Create: `tools/reliable-drive-sync-mcp/delivery-service.mjs`
- Create: `tools/reliable-drive-sync-mcp/test/local-outbox.test.mjs`
- Create: `tools/reliable-drive-sync-mcp/test/delivery-service.test.mjs`
- Modify: `tools/reliable-drive-sync-mcp/stdio-bridge.mjs`
- Modify: `tools/reliable-drive-sync-mcp/test/stdio-bridge.test.mjs`
- Modify: `tools/reliable-drive-sync-mcp/start.cmd`

**Interfaces:**
- Produces: SQLite enqueue/readback/conflict detection, identity cache, `/v1/jobs` transport, synchronous `/v1/query`, periodic flush, and queue-semantic MCP results.

- [ ] **Step 1: Write failing SQLite durability tests**

  Use a temporary real SQLite file. Prove enqueue survives close/reopen; identical `requestId` is idempotent; conflicting JSON is rejected; `sending` recovers to `pending`; rows are deleted only for `202` plus a non-empty `jobId`; older rows flush first.

- [ ] **Step 2: Run focused tests and verify RED**

  Run: `node --test tools/reliable-drive-sync-mcp/test/local-outbox.test.mjs tools/reliable-drive-sync-mcp/test/delivery-service.test.mjs`

- [ ] **Step 3: Implement minimal Outbox and delivery service**

  Use `node:sqlite` and `RELIABLE_DRIVE_SYNC_OUTBOX_PATH`, defaulting below the current user's application data directory. Resolve identity from cache/Worker before binding nested schema-1.2 event fields. Never invent a new ID on transport failure.

- [ ] **Step 4: Replace pass-through bridge behavior under failing tests**

  Writes return literal `cloud_accepted` or `pending` results; reads call `/v1/query`; initialization still works without configuration; only `submit_event` is listed.

- [ ] **Step 5: Run bridge and full MCP suites, then commit**

  Run: `npm run test:bridge && npm test`

  Commit: `git commit -m "feat: restore local sqlite outbox mcp"`

### Task 5: Remove remote MCP/Tunnel and restore local-client setup

**Files:**
- Delete: `services/reliable-drive-sync-worker/setup-chatgpt-work.ps1`
- Delete: `services/reliable-drive-sync-worker/test/chatgpt-work-setup.test.js`
- Delete: `tools/reliable-drive-sync-mcp/setup-chatgpt-work-tunnel.ps1`
- Delete: `tools/reliable-drive-sync-mcp/test/tunnel-setup.test.mjs`
- Modify: `README.md`
- Modify: `services/reliable-drive-sync-worker/README.md`
- Modify: `tools/reliable-drive-sync-mcp/README.md`
- Create: `tools/reliable-drive-sync-mcp/setup-local-clients.ps1`
- Create: `tools/reliable-drive-sync-mcp/test/local-client-setup.test.mjs`

**Interfaces:**
- Produces: one secret-safe setup for ChatGPT desktop/Codex shared config plus one WorkBuddy command, all pointing at `start.cmd`.

- [ ] **Step 1: Write the failing executable setup test**

  Run the PowerShell script in dry-run mode and assert it produces a local STDIO command/config without printing the secret or mentioning Tunnel/remote MCP.

- [ ] **Step 2: Verify RED, implement setup, and remove obsolete routes/scripts**

  Run: `node --test tools/reliable-drive-sync-mcp/test/local-client-setup.test.mjs`

- [ ] **Step 3: Run full tests and commit**

  Run: `npm test`

  Commit: `git commit -m "refactor: remove remote mcp connector setup"`

### Task 6: Mirror runtime and update affected Skills

**Files:**
- Mirror: `services/reliable-drive-sync-worker/**`
- Mirror: `tools/reliable-drive-sync-mcp/**`
- Modify: `AGENTS.md`
- Modify: active files under the four affected Skill directories
- Modify: affected Python scripts and contract tests
- Modify: `tests/test_repository_storage_contract.py`

**Interfaces:**
- Consumes: write results `cloud_accepted`/`pending`; query results `status:"ok"`.
- Produces: accurate Skill language and local-output persistence statuses.

- [ ] **Step 1: Write failing Skill contract tests**

  Require all four Skills to distinguish SQLite, D1, and Drive; forbid active claims that queue acceptance contains a Drive receipt/file ID; require only `submit_event`; verify non-persistence Skills remain untouched.

- [ ] **Step 2: Run affected tests and verify RED**

  Run each Skill's `python3 -m unittest discover -s tests -v` from its own directory plus the repository storage contract.

- [ ] **Step 3: Update active Skill files/references/scripts and mirror runtime**

  Preserve schema 1.2 field shapes, learning/interview behavior, local report rules, and canonical paths. Change only acknowledgement and retry semantics plus status validation.

- [ ] **Step 4: Run all mirrored runtime and Skill tests, then commit**

  Commit: `git commit -m "fix: align skills with outbox delivery semantics"`

### Task 7: Final verification, review, merge, and push

**Files:** all changed files in both repositories.

- [ ] **Step 1: Run fresh full verification**

  Run root MCP tests, mirrored Worker/MCP tests, all Python Skill suites from correct working directories, repository contract tests, and source scans for forbidden active Tunnel/remote-MCP wording.

- [ ] **Step 2: Review the complete diffs against the spec**

  Check data preservation, request idempotency, secret handling, routing, local client coverage, and absence of untracked files.

- [ ] **Step 3: Merge each feature branch into local `main` by fast-forward**

  Verify `main` has no unrelated changes before merge.

- [ ] **Step 4: Push both `main` branches to GitHub and verify remote SHAs**

  Push `gitgotcha/my-chatgpt-mcp` and `gitgotcha/my-chatgpt-skills`; compare local and remote `main` SHAs.
