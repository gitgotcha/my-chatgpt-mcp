# RDS-JBryon Remaining Acceptance Work Plan

> **For agentic workers:** Execute this plan inline, task by task. Each task uses test-first verification.

**Goal:** Close locally reproducible RDS-JBryon defects and strengthen local acceptance for the remaining J cases without claiming cloud, device, or model behavior that was not exercised.

**Architecture:** Preserve the approved RDS-JBryon design and the current SQLite Outbox / D1 worker split. Freeze creation targets to stable parent IDs, persist deletion discovery as resumable pages, and use integration tests across the actual Outbox, service, store, and offline cache boundaries.

**Tech Stack:** Node.js ESM, node:test, node:sqlite, Miniflare D1.

**Spec:** `docs/superpowers/specs/2026-10-26-rds-jbryon-design.md`

## Global Constraints

- Single owner: 乔炳源; no account or user-resolution layer.
- User-facing routes remain readable paths; internal IDs are generated and resolved by the system.
- Frozen request identity never changes during retries.
- Deletion stays gated until all manifest pages and body cleanup are complete.
- Dependencies advance only after `applied` or `applied_noop`.
- Do not deploy, install into client configuration, clear old resources, or modify unrelated RDS V2 files.
- Record online, multi-device, and real-model checks as not run unless actually exercised.

## Review Focus

- A stale path cannot redirect a frozen create to a same-name replacement parent; test delete/recreate between enqueue and accept.
- A root domain can be created on a fresh Outbox while unresolved nested parents remain blocked; test a database without `offline_nodes`.
- Large deletion discovery cannot truncate or exceed a single serialized cursor; test page interruption and resume.
- Local cleanup must be atomic and idempotent when a manifest page races with pending/sending requests; test duplicate apply and page revision mismatch.
- Separate Outbox processes cannot transmit the same request concurrently; test two SQLite connections sharing one database file.

---

### Task 1: Stable creation parent and first-domain bootstrap

**Files:** `services/rds-jbryon/src/store.js`, `services/rds-jbryon/test/store.test.js`, `tools/rds-jbryon-mcp/outbox.mjs`, `tools/rds-jbryon-mcp/test/offline-cache.test.js`, delivery report and case results.

- [x] Add regression tests for frozen `parentId` across delete/recreate, parent rename/move with stable ID, and root-domain creation with an empty Outbox.
- [x] Run the focused tests; the prior O04/O05 failures are covered by three fresh boundary probes.
- [x] Make the server treat frozen `parentId` plus `name` as authoritative, preventing path-based redirection.
- [x] Allow root-domain creation before offline route-cache lookup; nested creation without a unique active parent remains blocked.
- [x] Run the full local suite (96/96) and all 43 accumulated independent probes.

### Task 2: Request status, dependency, and operator retry closure

**Files:** `services/rds-jbryon/src/contracts.js`, `services/rds-jbryon/src/store.js`, `services/rds-jbryon/src/routes.js`, `tools/rds-jbryon-mcp/service.mjs`, corresponding tests.

- [x] Add integration tests for persisted dependency state and dependent requests after conflicts.
- [x] Exercise the full local-status/effect display matrix, including `requiredRequestId` and stale/waiting labels.
- [x] Exercise `needs_attention` through HTTP and MCP administrator retry; verify duplicate retry rejection and later completion.
- [x] Preserve precise error categories and ensure dependency waits do not consume failure attempts.
- [x] Run focused tests and the full local suite (96/96).

### Task 3: Deletion discovery and offline reconciliation

**Files:** `services/rds-jbryon/migrations/0001_rds_jbryon.sql`, `services/rds-jbryon/src/store.js`, `services/rds-jbryon/src/routes.js`, `tools/rds-jbryon-mcp/offline-cache.mjs`, tests.

- [x] Add tests proving manifest traversal returns bounded, resumable pages over a 1,001-node tree.
- [x] Persist a frozen subtree offset/revision cursor; reject stale or request-mismatched continuation tokens.
- [x] Verify deletion completion and enumeration completion are reported separately while cleanup is pending.
- [x] Test reconciliation of an authoritative deletion manifest against two independent local caches; repeated application remains idempotent.
- [x] Keep real multi-device hosting and automatic movement-history derivation outside local-pass claims.

### Task 4: Move identity, frozen dependencies, and multi-process Outbox

**Files:** `services/rds-jbryon/src/store.js`, `tools/rds-jbryon-mcp/outbox.mjs`, `tools/rds-jbryon-mcp/service.mjs`, tests.

- [x] Add end-to-end tests showing frozen path requests stay attached to the same node after move and fail safely after deletion.
- [x] Verify frozen dependency IDs survive and replan only through replacement requests.
- [x] Use two independent SQLite processes sharing one file to verify only one can claim a request.
- [x] Run targeted tests and the lease/replacement probe set.

### Task 5: Concurrent local benchmark and truthful acceptance ledger

**Files:** `tools/rds-jbryon-mcp/bench/local-load.mjs`, `tools/rds-jbryon-mcp/test/load.test.js`, delivery `case-results.json`, `delivery-report.md`, hashes.

- [x] Extend the local benchmark to parallel accept batches across unrelated directories and capture request throughput, conflicts, isolation, projection latency, and network calls (one local projector; crash recovery not measured).
- [x] Verify project isolation under concurrent accepts; other-project progress remains covered by the dependency/target integration tests.
- [x] Update statuses only from fresh local evidence; live deployment, destructive cutover, client installation, and model/runtime behaviors remain partial or not run as documented.
- [x] Recalculate delivery hashes after all files stabilize (round10 manifest, evidence, source and Skill artifacts).

### Task 6: Make the Queue handoff authoritative and prepare a safe deployment template

**Files:** `services/rds-jbryon/src/{store,queue,worker}.js`, migration comments, Worker/Queue tests, Wrangler template and deployment runbook.

- [x] Add a failing integration test proving that Cron dispatch does not project a successfully queued task itself.
- [x] Verify Queue-send failure releases only the matching handoff epoch and allows immediate retry.
- [x] Verify overdue queued handoffs can be resent while duplicate messages remain harmless.
- [x] Provide a non-auto-loaded Wrangler JSONC template with dedicated-resource placeholders and a deployment runbook; do not create resources, authenticate, or deploy.
- [x] Run the full RDS-JBryon suite (98/98) and the deployment-template contract test (2/2).
- [x] Recalculate delivery hashes after round11 report and evidence updates.



