# Algorithm Skill MCP Ingress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route algorithm-learning events through the local MCP outbox and verify the existing Cloudflare D1, QStash, Worker, and Drive pipeline end-to-end.

**Architecture:** The Skill creates factual learning events with `submit_event`; the MCP process stores them in local SQLite and attempts `/v1/jobs`. Cloudflare persists each accepted job in D1, QStash invokes `/v1/sync`, and the Worker writes immutable Drive artifacts.

**Tech Stack:** Codex Skills, Model Context Protocol stdio server, Node.js 22+, SQLite/better-sqlite3, Cloudflare Workers/D1, Upstash QStash, Google Drive API service account.

## Global Constraints

- Do not place `RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET`, QStash tokens, signing keys, or Google credentials in version control or Codex `config.toml`.
- Keep historical Drive learning events and snapshots immutable; do not edit, move, or delete them.
- Preserve local events when ingress is unavailable; `accepted` is not Drive completion.
- Use `RELIABLE_DRIVE_SYNC_INGRESS_URL`, `RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET`, and `RELIABLE_DRIVE_SYNC_OUTBOX_PATH` as the only local MCP settings.
- Run the existing repository test, typecheck, build, and build verification commands before Worker deployment.

---

### Task 1: Convert the Algorithm Skill to MCP Event Submission

**Files:**
- Modify: `C:\Users\27846\.codex\skills\algorithm-learning\SKILL.md`
- Modify: `C:\Users\27846\.codex\skills\algorithm-learning\references\google-drive-runtime.md`

**Interfaces:**
- Consumes: MCP tool `submit_event(event: SyncEvent)` from server `reliable_drive_sync`.
- Produces: One factual event with `eventKey`, `userId`, `eventType`, `sourceSkill`, `destination`, `createdAt`, and `payload`.

- [ ] **Step 1: Define the expected MCP event in the Skill instructions**

```json
{
  "eventKey": "1aaa296b-9b35-4546-8dbd-8d97d81a9e8d:algorithm-learning:two-sum:2026-08-12T12:30:00.000Z",
  "eventType": "learning.consulted",
  "sourceSkill": "algorithm-learning",
  "destination": "drive",
  "createdAt": "2026-08-12T12:30:00.000Z",
  "payload": {"problem": "两数之和", "topic": "哈希表", "outcome": "consulted"}
}
```

- [ ] **Step 2: Replace direct Drive create/readback requirements with MCP result handling**

Use this rule: call `submit_event` after the educational answer; report `cloud_accepted` only for the MCP tool's accepted cloud result, otherwise report `local_pending`; never create Drive files from the Skill.

- [ ] **Step 3: Validate the instruction change**

Run: `Select-String -Path C:\Users\27846\.codex\skills\algorithm-learning\SKILL.md -Pattern 'submit_event|Google Drive|snapshot'`

Expected: `submit_event` is required and direct Google Drive creation/snapshot instructions are absent.

### Task 2: Configure the Local MCP Runtime Without Persisting Secrets in Config

**Files:**
- Modify: `C:\Users\27846\.codex\config.toml` only if the registered MCP command or non-secret outbox path is missing.
- Create: `docs/local-mcp-setup.md`

**Interfaces:**
- Consumes: user-level environment variables inherited by the registered Node stdio server.
- Produces: a deterministic absolute SQLite outbox path and an MCP runtime that exposes `submit_event` after Codex restart.

- [ ] **Step 1: Check only the presence, never the value, of secret-backed settings**

Run:

```powershell
@('RELIABLE_DRIVE_SYNC_INGRESS_URL','RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET') |
  ForEach-Object { "$($_)=" + [bool][Environment]::GetEnvironmentVariable($_,'User') }
```

Expected: both values are `True`; the command never prints the secret.

- [ ] **Step 2: Set non-secret URL and deterministic outbox path at user scope**

```powershell
setx RELIABLE_DRIVE_SYNC_INGRESS_URL "https://reliable-drive-sync.qiaobingyuan886.workers.dev/v1/jobs"
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\\ReliableDriveSync"
setx RELIABLE_DRIVE_SYNC_OUTBOX_PATH "$env:LOCALAPPDATA\\ReliableDriveSync\\outbox.sqlite"
```

- [ ] **Step 3: Document the one secret handoff**

Document that the user must set the same Worker ingress secret in `RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET`, then fully restart Codex. Never include the secret value in the document.

### Task 3: Verify Cloud Resources and Deploy the Worker

**Files:**
- Modify: no source files unless verification identifies a concrete configuration mismatch.
- Test: remote D1 and Worker deployment commands.

**Interfaces:**
- Consumes: existing `packages/workers/wrangler.toml`, remote D1 binding `DB`, and Worker Secrets.
- Produces: an applied D1 schema, a deployed Worker version, and verified presence of secret names.

- [ ] **Step 1: Inspect D1 schema and migration metadata**

Run:

```powershell
pnpm exec wrangler d1 execute reliable-drive-sync --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

Expected: `sync_jobs` and `sync_failure_notices` exist. Do not reapply an already initialized destructive schema.

- [ ] **Step 2: Inspect Worker Secret names without reading their values**

Run: `pnpm exec wrangler secret list`

Expected: ingress, QStash signing/publish, Google service-account, and Drive-folder secret names are present.

- [ ] **Step 3: Validate and deploy**

Run:

```powershell
pnpm test
pnpm typecheck
pnpm build
pnpm verify:build
pnpm exec wrangler deploy
```

Expected: all local commands pass and Wrangler reports a Worker version.

### Task 4: Execute an End-to-End Non-Destructive Smoke Event

**Files:**
- Create: `docs/operations/e2e-smoke-check.md`

**Interfaces:**
- Consumes: `submit_event`, the configured Worker, D1, QStash, and Drive adapter.
- Produces: a uniquely keyed `deployment-smoke` job whose final state is inspected without changing existing data.

- [ ] **Step 1: Submit one unique smoke event through MCP**

```json
{
  "eventKey": "deployment-smoke:7d5c992b-9ca0-4f63-bef8-68769b8f2f7c",
  "eventType": "profile.updated",
  "sourceSkill": "deployment-smoke",
  "destination": "drive",
  "createdAt": "2026-08-12T12:30:00.000Z",
  "userId": "smoke-test",
  "payload": {"purpose": "end-to-end verification"}
}
```

- [ ] **Step 2: Query only the job's state and error code**

Run:

```powershell
pnpm exec wrangler d1 execute reliable-drive-sync --remote --command "SELECT state,last_error_code,broker_message_id,updated_at FROM sync_jobs WHERE event_key='deployment-smoke:7d5c992b-9ca0-4f63-bef8-68769b8f2f7c';"
```

Expected: `broker_queued`, `syncing`, or `synced` without an error code. Preserve any pending state for later automatic retry.

- [ ] **Step 3: Record the exact result and recovery action**

If the state is `synced`, document the completed boundary. If the state is not `synced`, document the state/error code and the automatic retry/reconciliation path without replaying it unsafely.
