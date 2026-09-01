# Local Outbox Architecture Restoration Design

## Goal

Restore the last known reliable submission shape without reverting schema 1.2,
the canonical Drive layout, global identity, or current Skill data:

```text
ChatGPT desktop / Codex / WorkBuddy
  -> local stdio MCP (submit_event only)
  -> local SQLite Outbox
  -> Worker POST /v1/jobs
  -> D1 cloud Outbox
  -> QStash retry delivery
  -> schema-1.2 Drive dispatcher
  -> Google Drive readback verification
```

The remote `/mcp/<token>` endpoint, Secure MCP Tunnel helper, and ChatGPT web
connector setup are removed. The Worker is an authenticated job/query service,
not a remote MCP server.

## Preserved contracts

- The only MCP tool remains `submit_event`.
- Every business envelope remains schema `1.2`.
- The canonical root remains `DriveRoot/my-chatGPT-skills/`.
- Existing Drive objects and legacy roots are never moved, overwritten, or
  deleted by this restoration.
- Identity remains global and is resolved by NFKC-normalized, trimmed display
  name. A supplied `userId` is checked, never blindly trusted.
- Drive event writes and projections still use the current stores and readback
  verification in `services/reliable-drive-sync-worker/src/`.

## Local MCP

`tools/reliable-drive-sync-mcp/stdio-bridge.mjs` remains the portable stdio
entrypoint used by all three local clients. It gains a SQLite-backed Outbox.
Every write request is inserted by `requestId` before network access. Reusing a
`requestId` with different JSON is rejected; an identical retry reuses the
original row.

The bridge resolves identity before sending a job. It first checks a local
identity cache, then calls the authenticated, read-only Worker identity lookup.
An existing user reuses the verified ID. An explicit Worker `404` reserves a new
UUID and includes it in the queued registration/business envelope. A transport
failure does not invent a second identity; the row stays local until identity
can be resolved.

The bridge flushes older rows before the current row, retries pending rows while
the process remains alive, and deletes a row only after `/v1/jobs` returns `202`
with a non-empty `jobId`.

Write results have queue semantics:

- `deliveryState: "cloud_accepted"`: D1 durably accepted the job; Drive is still
  pending in the Worker/QStash pipeline.
- `deliveryState: "pending"`: SQLite durably holds the request; cloud acceptance
  has not yet been confirmed.

Neither result claims a Drive file ID or completed projection. Read-only
operations remain synchronous through `/v1/query` so session list/load and
legacy migration dry-runs can return data.

## Worker and cloud Outbox

The Worker exposes these authenticated or signed routes:

- `POST /v1/jobs`: validate the schema-1.2 envelope, insert or reuse a D1 job,
  schedule QStash dispatch, and return `202` only after D1 persistence.
- `POST /v1/query`: allow only `interview.session.list`,
  `interview.session.load`, and legacy migration `dry-run`.
- `GET /v1/identity`: read-only display-name lookup; it never registers a user.
- `POST /v1/sync`: accept only a valid QStash signature, lease the D1 job, call
  the existing schema-1.2 dispatcher, and persist the terminal/retry state.
- `POST /v1/qstash/failure`: accept only a valid QStash signature, mark exhausted
  jobs for attention, and open an operator notice.

A new `schema12_jobs` table avoids changing or deleting the historical
`sync_jobs` rows already present in the existing D1 database. `request_id` is
the idempotency fence. QStash publish failures remain `dispatch_pending` for the
five-minute Cron reconciler. Delivery failures remain retryable unless they are
validated permanent protocol/identity conflicts.

`status: "ok"` and `already_scored_today` are terminal. `profile_cache_pending`,
`cloud_persistence_pending`, and dependency-order statuses such as
`resume_required` are retried because an earlier queued job may make the next
attempt succeed.

## Skill contract changes

The affected active Skills are:

- `algorithm-learning`
- `conducting-java-backend-mock-interviews`
- `reviewing-java-backend-interviews`
- `java-knowledge-based-on-resume-learn-skill`

They still call only `submit_event`, but write acknowledgements now mean queue
durability, not immediate Drive completion. They may say “cloud Outbox accepted”
for `cloud_accepted` and “saved locally, awaiting upload” for `pending`. They
must never say “Drive saved”, “profile updated”, or cite a Drive `fileId` from a
write acknowledgement. Synchronous query success may still use `status: "ok"`.

Local interview output records use `cloud_accepted` or `pending`; the existing
portable JSON/DOCX rules remain unchanged. Historical design documents stay
historical; active Skill files, active references, scripts, and contract tests
are updated.

`backend-project-learning` and `child-photoShop-skill` do not use
`submit_event`; they are verified as unaffected and are not modified.

## Client setup

ChatGPT desktop, Codex CLI, and the Codex IDE extension share the local MCP
configuration. One `reliable_drive_sync` stdio entry points at `start.cmd`.
WorkBuddy points at the same command. The launcher reads the URL, bearer secret,
Outbox path, and optional Node path from current-user environment variables
without printing them.

The repository provides one local installer/diagnostic path and no Tunnel or
remote-connector setup.

## Verification

- TDD red/green coverage for SQLite durability, request conflicts, identity
  caching, older-row flush, D1 idempotency, QStash transitions/signatures,
  query allow-listing, and route removal.
- Full Worker and local MCP suites in `my-chatgpt-mcp`.
- Mirrored Worker/MCP suites plus all affected Skill contract tests in
  `my-chatgpt-skills`.
- Repository scan proving no active Tunnel, `/mcp/<token>`, direct Drive write,
  or synchronous-Drive-success wording remains.
- Final diff review, clean worktrees, fast-forward merge to `main`, and GitHub
  push for both repositories.
