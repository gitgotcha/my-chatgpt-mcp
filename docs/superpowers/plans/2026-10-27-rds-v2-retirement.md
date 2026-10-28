# RDS-V2 Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permanently retire the legacy `reliable-drive-sync`/RDS-V2 stack and make RDS-JBryon the only active persistence service, while preserving its data and unrelated in-progress work.

**Architecture:** First migrate active skill and runtime references to the RDS-JBryon `rds` MCP and verify those consumers. Then stop old writers and remove legacy local/runtime assets. Finally remove only the inventoried legacy Drive files, Worker/Cron, four queues, and shared D1, with before/after evidence and explicit keep-list checks for RDS-JBryon.

**Tech Stack:** JavaScript ES modules, Node.js test runner, Cloudflare Workers/D1/Queues and Wrangler, Codex MCP configuration, Python/Markdown skill contracts, Google Drive connector.

**Spec:** `D:/Document/deepseek-harness/default-workspace/rds-jbryon-delivery/rds-v2-retirement-design.md`

## Global Constraints

- Keep RDS-JBryon Worker, D1, queue, local MCP, configuration, Outbox, data, and canary tombstone/audit untouched.
- Delete only the 30 Drive file IDs referenced by legacy RDS-V2 archive-delivery rows; never delete the Drive root or unrelated files.
- Permanently discard legacy queue backlog, retry, and DLQ messages when deleting the four inventoried legacy queues; record that backlog is unknown if it cannot be measured.
- Preserve unrelated uncommitted project-learning/interview work and all Git history; do not commit, push, deploy RDS-JBryon, or rewrite history.
- Stop legacy writers before disabling the legacy Worker/Cron or deleting its shared D1 and queues.
- Before each destructive Cloudflare action, verify exact account, resource name, and resource ID against the RDS-JBryon keep list; no keep-list ID may appear in the deletion manifest.
- Do not retain a recoverable local copy of RDS-V2-specific uncommitted code or deleted user data; the audit manifest may contain resource IDs, paths, counts, and outcomes only.

## Execution status (2026-10-27)

| Workstream | Status | Evidence / remaining boundary |
|---|---|---|
| Legacy Cloudflare stack | Complete | `reliable-drive-sync`, shared D1 `64e7d63f-9275-45d3-be73-9e8cd4908ccd`, and all four inventoried RDS-V2 queues are absent. Current account inventory contains only the retained RDS-JBryon D1 and projection queue. |
| Legacy Drive archive | Complete | 30/30 exact inventory IDs were deleted and verified absent; protected `users` folder remains. The Drive connector did not expose an owner field, recorded in the manifest. |
| Legacy runtime source / MCP | Source files removed; local cleanup partial | Old Worker/MCP source files and registrations were removed, and old processes stopped. Empty directory shells and legacy SQLite files remain because filesystem deletion was blocked. Four user environment variables remain: the cleanup call hung and was interrupted, so removal was not verified. |
| Active Skill routing | Core routes updated; residual helper schemas remain | Active persistence guidance now routes through RDS-JBryon; profile creator and study planner contracts/tests were migrated. Offline mock/review JSON helpers still contain schema-1.2 event-shaped records and need a dedicated snapshot-record migration. |
| RDS-JBryon regression | In progress | Its test fixture was moved under `services/rds-jbryon/test/support/`; full `npm test` is being rerun after removing the old Worker tree. |
| Commit / push / RDS-JBryon deployment | None by this retirement turn | Existing RDS-JBryon deployment and resources were inspected, not modified. |

The retirement is **partial** until local legacy SQLite/config cleanup is completed outside the filesystem actions rejected by automatic review, and the remaining offline interview helper schemas are migrated or explicitly retired.

## Review Focus

- Shared legacy D1 also contains RDS-V2 tables: prove no active Worker binding/client depends on it before deletion; check the dependency inventory and post-delete account listing.
- Queue backlog is not exposed by the current info output: record backlog as unknown and discarded unless an authorized read-only count becomes available; never infer emptiness from task counts.
- Drive deletion can target unrelated data if IDs are not verified: test each of the 30 IDs against the archive-delivery inventory and owner metadata before deleting; verify only those IDs are absent afterward.
- Dirty checkouts contain unrelated work and untracked RDS-JBryon assets: compare exact paths before/after and verify every RDS-JBryon path/hash/state remains unchanged.
- Old MCP settings may come from more than one configuration source: discover the authoritative registration, remove only the legacy entry, then verify a fresh Codex process can see `rds-jbryon` and cannot invoke the retired server.

---

### Task 1: Repoint active skills to RDS-JBryon

**Files:**
- Modify: `C:/Users/27846/my-chatgpt-skills/AGENTS.md`
- Modify: `C:/Users/27846/my-chatgpt-skills/README.md` and repository-wide active persistence tests
- Modify: active skill runtime contracts under `C:/Users/27846/my-chatgpt-skills/**/references/rds-v2-runtime.md` and the callers/tests that load them (identify exact set with `rg -l` before editing)
- Modify: active persistence references and tests under `software-project-learning/`, `conducting-java-backend-mock-interviews/`, `reviewing-java-backend-interviews/`, `algorithm-learning/`, `child-photography-editing/`, `adaptive-study-planning/`, `java-knowledge-based-on-resume-learn-skill/`, and profile-aware skill-creator directories
- Preserve: historical design/plan docs and unrelated current skill changes unless they are loaded as active runtime instructions

**Interfaces:**
- Consumes: RDS-JBryon single-user `rds` MCP contract; no account identity resolution, Drive API, or direct D1/HTTP calls from skills.
- Produces: active skill guidance routes snapshots and updates through the registered `rds` MCP, with the existing per-skill data semantics retained.

- [ ] **Step 1: Add/adjust contract tests first** — assert active guidance names the RDS-JBryon `rds` tool and does not instruct callers to use `reliable_drive_sync`, `submit_event`, `user.resolve`, or RDS-V2 capability handshakes.
- [ ] **Step 2: Run the focused tests and record expected failures** — run the relevant tests in each affected skill; expected failures identify each old contract assertion.
- [ ] **Step 3: Update active runtime guidance** — replace old protocol steps with RDS-JBryon tool invocation and its path-based folder/snapshot routing; keep skill-specific snapshot boundaries and review-only behavior intact.
- [ ] **Step 4: Run focused and whole-skill tests** — run each affected skill's test suite and the repository skill validators; all pass, no unrelated skill file is removed.
- [ ] **Step 5: Review references** — run `rg` over active skill entrypoints/references/tests and classify remaining RDS-V2 mentions as historical-only or remove them if runtime-loaded.

### Task 2: Retire legacy runtime source and package entrypoints

**Files:**
- Delete: `services/reliable-drive-sync-worker/`
- Delete: `tools/reliable-drive-sync-mcp/`
- Delete: duplicate legacy-only `services/reliable-drive-sync-worker/` and `tools/reliable-drive-sync-mcp/` under `C:/Users/27846/my-chatgpt-skills/` (after exact ownership/import inventory)
- Delete: `shared/rds2-protocol.mjs` and any other file proven exclusively owned by the legacy service
- Modify: `package.json` in both checkouts where present, to make tests/deploy scripts target `services/rds-jbryon/` and `tools/rds-jbryon-mcp/`; preserve `miniflare` if the new test suite requires it
- Modify: `README.md` to describe only the active RDS-JBryon service and commands
- Preserve: `services/rds-jbryon/`, `tools/rds-jbryon-mcp/`, ignored local settings, and unrelated uncommitted files

**Interfaces:**
- Consumes: Task 1's verified active consumer migration.
- Produces: checkout with no legacy Worker/MCP implementation or default test/deploy entrypoint; RDS-JBryon remains runnable and testable.

- [ ] **Step 1: Inventory exact legacy-owned paths** — compare `git status --short`, `rg` imports/package references, and the RDS-JBryon keep list; save only a path/hash inventory (no copies of deleted contents).
- [ ] **Step 2: Add package-script checks** — assert root `npm test` invokes RDS-JBryon suites and deployment script points only to its Worker config.
- [ ] **Step 3: Update package metadata and README** — remove legacy test/deploy scripts and legacy product instructions while preserving current RDS-JBryon content and unrelated README intent.
- [ ] **Step 4: Delete legacy-only source** — remove the two legacy directories and exclusively owned shared protocol files; do not delete ambiguous/shared files until imports prove they are legacy-only.
- [ ] **Step 5: Verify** — run root `npm test`, RDS-JBryon worker/MCP tests, and `rg` for imports of deleted modules; confirm no RDS-JBryon tracked or ignored file changed.

### Task 3: Stop and remove legacy local writers and state

**Files/resources:**
- Remove: Codex MCP registration for `reliable_drive_sync` from its discovered authoritative configuration source
- Remove: `C:/Users/27846/AppData/Local/ReliableDriveSync/outbox.sqlite` and matching `-wal`/`-shm` files after the writer is stopped
- Remove: `.rds2-canary-20260908/` and `.rds2-dry-run-t16/` from the runtime checkout
- Remove: only the legacy Outbox environment variable/config entries discovered during inventory
- Preserve: `rds-jbryon` MCP registration, RDS-JBryon Outbox/config, and all non-RDS2 local data

**Interfaces:**
- Consumes: Task 1 migration and Task 2 source/package cleanup.
- Produces: no old local retry loop, MCP registration, or RDS-V2 local cache remains.

- [ ] **Step 1: Discover and record exact configuration/state paths** — inspect MCP registration sources, environment variable names, old process ownership, and all matching local files; do not reveal secret values in the manifest.
- [ ] **Step 2: Stop old writer and retry processes** — stop only the legacy MCP/Outbox processes; verify no process still has the old Outbox open.
- [ ] **Step 3: Remove registration and local RDS2 state** — delete the exact legacy entry and old database/WAL/SHM/canary directories; preserve the new MCP and its files.
- [ ] **Step 4: Verify fresh-process behavior** — inspect/reload MCP configuration in a fresh Codex process; `rds-jbryon` is available and `reliable_drive_sync` is absent; verify old local paths are absent and new paths remain.

### Task 4: Remove the 30 inventoried legacy Drive archive files

**Resources:**
- Delete: exactly the distinct `drive_file_id` values referenced by the 30 delivered legacy `rds2_archive_deliveries` rows in D1 `64e7d63f-9275-45d3-be73-9e8cd4908ccd`
- Preserve: Drive root, nonmatching files, and all RDS-JBryon artifacts
- Evidence: create a deletion manifest containing file IDs, ownership check, deletion result, and post-delete absence only; no content or recoverable copies

**Interfaces:**
- Consumes: read-only legacy D1 inventory and authenticated Drive delete capability.
- Produces: only the 30 verified legacy archive files are absent.

- [ ] **Step 1: Re-query the 30-row ID list read-only** — verify distinct count is 30, delivered count is 30, pending count is 0, and record the root ID separately as a protected ID.
- [ ] **Step 2: Verify each target** — fetch metadata for every file ID and confirm its identity/ownership corresponds to the legacy archive inventory; abort any ID that is missing, mismatched, or the root.
- [ ] **Step 3: Delete exact targets** — delete each verified file ID individually; record per-ID outcome without downloading or retaining file contents.
- [ ] **Step 4: Verify postconditions** — confirm all 30 target IDs are absent and representative unrelated/root items remain accessible; if the Drive connector cannot prove ownership/deletion, stop before deleting D1 and report the exact blocker.

### Task 5: Disable and delete Cloudflare legacy Worker, queues, and shared D1

**Resources:**
- Delete: Worker `reliable-drive-sync` and its Cron trigger
- Delete: queues `rds2-projection` (`303b16f61815477d8edd1a73a37d4d63`), `rds2-projection-dlq` (`6f9d2cbf5b54400bb1c4e367ec07d400`), `rds2-archive` (`98b7f911a3dd4364a768cd54a28b3f47`), `rds2-archive-dlq` (`21b49663545c4bcd937fafa3a4c2bc22`)
- Delete: shared D1 `reliable-drive-sync` (`64e7d63f-9275-45d3-be73-9e8cd4908ccd`) after worker/queue dependency checks
- Preserve: all RDS-JBryon resource IDs and resources (must be listed as explicit keep IDs at execution time)

**Interfaces:**
- Consumes: stopped old writers, deleted old Drive archive files, authorized Cloudflare account inventory.
- Produces: no old Worker/Cron, four old queues, or shared legacy D1; RDS-JBryon resource inventory unchanged.

- [ ] **Step 1: Preflight exact account and dependency graph** — list account, Workers, D1 bindings, queues, Cron triggers, and RDS-JBryon keep IDs; verify no other active Worker/client uses the shared DB or old queues. If account inventory/auth is insufficient, pause before any remote deletion.
- [ ] **Step 2: Stop Worker and Cron** — disable the legacy Worker/Cron; confirm the RDS-JBryon Worker continues serving its existing read-only health check.
- [ ] **Step 3: Recheck queue state and delete exact old queues** — query backlog if supported; otherwise explicitly record unknown backlog discarded; delete only the four IDs above and verify each is absent.
- [ ] **Step 4: Delete exact shared D1** — recheck zero old writers/bindings and exact ID/account, then delete; verify the named database is absent.
- [ ] **Step 5: Delete legacy Worker deployment/config** — remove the old Worker and Cron after queue/database checks; verify no old service binding remains and RDS-JBryon deployment is unchanged.

### Task 6: Final retirement audit

**Files:**
- Create: `docs/superpowers/plans/2026-10-27-rds-v2-retirement-manifest.json` (IDs, paths, counts, checks, and outcomes only; no secrets or recoverable user data)
- Modify: this plan's checkboxes with actual completion evidence

**Interfaces:**
- Consumes: completed Tasks 1–5 and the approved retirement design.
- Produces: auditable retired-state inventory and proof that RDS-JBryon plus unrelated dirty work remain intact.

- [ ] **Step 1: Run final source scans and tests** — no active RDS-V2 runtime references or old imports; root/RDS-JBryon tests and affected skill suites pass.
- [ ] **Step 2: Recheck resource state** — old resources and 30 exact Drive IDs are absent; RDS-JBryon IDs match the preflight keep list and its authenticated read succeeds.
- [ ] **Step 3: Recheck workspace preservation** — compare dirty/untracked paths and RDS-JBryon hashes/state to the preflight inventory; unrelated work remains; no commit, push, or history rewrite occurred.
- [ ] **Step 4: Record final manifest and limits** — state any unavailable proof as partial/not verified; never convert an inaccessible listing into a successful deletion claim.
