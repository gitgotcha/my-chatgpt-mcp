# Task 2 implementation report

## Files changed

- `packages/mcp-server/`: SQLite Outbox, bounded local submission service, disabled notice client, stdio MCP entrypoint, and tests.
- `packages/protocol/package.json`: exports for the validated protocol modules.
- `package.json`, `pnpm-lock.yaml`, `tsconfig.json`: TypeScript checking and project-local `better-sqlite3` build allow-list.
- `hooks/hooks.json`: SessionStart command that is a no-op until a built entrypoint exists, then runs bounded `flush-pending` without claiming Drive completion.

## TDD evidence

- Red: `pnpm --filter @reliable-drive-sync/mcp-server test` failed as expected because `../src/outbox.js` did not exist.
- Green: `pnpm --filter @reliable-drive-sync/mcp-server test` passed: 2 files, 6 tests.
- TypeScript: `pnpm typecheck` passed.

## Runtime dependency note

The first `pnpm install` skipped `better-sqlite3`'s native build and tests could not locate its binding. The project now has `pnpm.onlyBuiltDependencies = ["better-sqlite3"]`; after `pnpm install --force`, its install step completed and real SQLite tests passed. Runtime used `node v24.11.0`, despite the project contract being Node 22+. `esbuild` remains intentionally unapproved; tests use its prebuilt binary and passed.

## Risks

- The Ingress transport remains deliberately unconfigured until Task 3 supplies the authenticated endpoint.
- The hook requires a future build output at `packages/mcp-server/dist/index.js`; it safely does nothing beforehand.
- No cloud call, credential, local database file, or secret was created.

## Commit

`fadd9fa940c6970d6a1ea8355c8d622556c09642` — `feat: add MCP SQLite outbox`

## Reviewer fixes

- Added injectable delivery deadlines. An unresponsive prior event is restored to `pending` with `ingress_timeout`, allowing the current event to continue.
- A duplicate request that finds its event already `sending` now returns `{ accepted: false, deliveryState: "pending" }`; it no longer implies cloud acceptance.
- Red test run demonstrated a five-second hang for the prior-event case and a false `cloud_accepted` concurrent result. Green verification now passes 8 focused tests plus TypeScript checking.

## Second reviewer fixes

- `IngressTransport.send` now receives an `AbortSignal`; timeout aborts the real transport operation before restoring the SQLite row to `pending`.
- A late response from an aborted attempt is ignored by the raced delivery path and cannot acknowledge the row after it has been made retryable.
- Every submit/flush preflight creates one shared deadline budget. Once it expires, later older rows are skipped and the current event gets its own attempt budget.
- Red tests covered transport abort with late success and two hung older rows. Green verification passes 10 focused tests and `pnpm typecheck`.

# Task 3 implementation report

## Files changed

- `packages/workers/`: Cloudflare Worker package, D1 migration, repository abstraction, authenticated ingress routing, Worker entrypoint, local tests, Wrangler placeholder configuration, and secret-name documentation.
- `pnpm-lock.yaml`: workspace link for `@reliable-drive-sync/workers` to the shared protocol package.

## TDD evidence

- Red: `pnpm --filter @reliable-drive-sync/workers test -- ingress.test.ts` failed as expected because `../src/db.js` did not exist.
- Green: `pnpm --filter @reliable-drive-sync/workers test -- ingress.test.ts` passed: 1 file, 7 tests.
- Full regression: `pnpm test` passed: 4 files, 20 tests.
- TypeScript: `pnpm typecheck` passed.

## Cloudflare migration status

`migrations/0001_initial.sql` is committed but was **not applied**. Cloudflare credentials, a D1 database, and a Worker deployment have not been provisioned; this is intentionally deferred and is not a code or test failure. `wrangler.toml` contains non-secret placeholders that must be replaced locally after provisioning.

## Risks

- `D1JobRepository` relies on the D1 `event_key` unique constraint as its idempotency fence; later deployment work must run the included migration before exposing ingress.
- QStash dispatch and Drive writes are deliberately absent until later tasks.
- No cloud call, credential, local D1 database, or secret was created.

## Commit

`33402ad012779c232241e8a7e8e4d20990c718fb` — `feat: add idempotent cloud ingress`

## Task 3 reviewer security fix

- Red: the new missing/empty `INGRESS_SHARED_SECRET` regression test failed with `expected 401 to be 503`, confirming the Worker did not fail closed before authorization comparison.
- Green: ingress now returns the generic `{ "error": "Service unavailable" }` with HTTP 503 before reading or comparing bearer credentials whenever the configured secret is missing or empty. No request can create a job in that state.
- Verification: focused Worker test passed 8/8; `pnpm test` passed 21/21; `pnpm typecheck` passed.
- Commit: `c282ed3194ed7f922e7ec9f838f50ce992dea678` — `fix: reject empty ingress secret`.

# Task 4 implementation report

## Files changed

- `packages/workers/src/dispatcher.ts`: state-guarded lease, safe retry recording, acknowledgement validation, and bounded pending scans.
- `packages/workers/src/qstash.ts`: isolated QStash HTTP boundary that sends only job identifiers, callback metadata, and a runtime-only bearer token.
- `packages/workers/src/db.ts`, `migrations/0001_initial.sql`: dispatch lease/attempt/message state support and D1 compare-and-set operations.
- `packages/workers/src/ingress.ts`, `src/index.ts`: non-blocking ingress dispatch through `waitUntil` and an injectable scheduled Cron handler.
- `packages/workers/tests/dispatcher.test.ts`: deterministic dispatcher, ingress, Cron, and HTTP-boundary coverage.

## TDD evidence

- Red: focused Dispatcher test first failed because `../src/dispatcher.js` did not exist. The later ingress/Cron tests also failed before wiring, with zero scheduled dispatches and missing `createWorker`.
- Green: focused Worker test passed: 1 file, 10 tests.
- Full regression: `pnpm test` passed: 5 files, 31 tests.
- TypeScript: `pnpm typecheck` passed.

## Safety and scope

- The atomic D1 lease only claims `dispatch_pending` jobs; a concurrent dispatcher cannot publish the same active job. Valid acknowledgement records its message id before moving to `broker_queued`; failures retain `dispatch_pending` and increment `dispatch_attempts`.
- Ingress returns HTTP 202 before best-effort work completes. Only a new event schedules `waitUntil`; duplicate ingress does not schedule another dispatch.
- QStash was **not contacted**, no credential was created or logged, and no Worker/D1 deployment occurred. Task 5 owns the signed sync endpoint and Drive writing.

## Commit

`feat: dispatch durable jobs through QStash`.

## Task 4 reviewer hardening

- Red: interleaved D1 insert test showed both duplicate requests returned `isNew: true`; acknowledgement CAS/throw tests showed a confirmed QStash message could be released back to `dispatch_pending` and republished.
- Green: `createOrGet` derives `isNew` solely from D1 `meta.changes === 1`; ingress tests prove only one of two interleaved duplicates schedules background dispatch.
- The durable dispatch claim now changes state from `dispatch_pending` to `dispatching` before QStash is called. If a valid acknowledgement cannot be committed to `broker_queued`, its message id is retained with `qstash_ack_persist_failed` when possible; if even that write fails, the durable `dispatching` state remains the no-republish fence. Future Task 6 reconciliation must inspect `dispatching` records rather than re-dispatch them.
- Verification: focused Worker tests passed 14/14; full suite passed 35/35; `pnpm typecheck` and `git diff --check` passed.
# Task 5 — signed Drive synchronization and snapshot recovery

- Red evidence: the first focused test execution exposed a malformed test assertion (suite transform failure); after fixing the harness, the same focused test exposed that signature verification imported an HMAC key with only `verify` usage while the constant-time implementation computes the MAC itself. Both failures were corrected before the green run.
- Green evidence: `pnpm --filter @reliable-drive-sync/workers test -- sync.test.ts drive-adapter.test.ts` passed (2 files, 7 tests); `pnpm test` passed (8 files, 42 tests); `pnpm typecheck` passed.
- Implemented `packages/workers/src/sync.ts`: raw-body HS256 JWT verification with audience, expiry/not-before, algorithm pinning, current/next key rotation, task-substitution validation, lease-guarded state transitions, and QStash response mapping.
- Implemented `packages/workers/src/drive-adapter.ts`: extensible destination contract, immutable event verification, complete-snapshot selection/rebuild, readback verification, and retryable/permanent classification.
- Extended `db.ts` and `index.ts` with lease-safe sync repository operations and the `/v1/sync` route (adapter injection only).
- Added `drive-adapter.test.ts` and `sync.test.ts` for duplicate/recovery, snapshot failure, invalid/tampered/expired signatures, substitution defense, success, and 429 mapping.
- Commit: `97e9601 feat: sync immutable Drive events and snapshots`.
- No Drive OAuth/HTTP request, QStash request, Cloudflare request, deployment, secret, or refresh token was used. A production Google Drive HTTP capability remains deliberately unconfigured: it must be added after dedicated OAuth credentials and a Drive test folder exist, behind the already-defined `DriveCapability` interface.

## Task 5 review hardening

- Added CAS-result checking to every sync completion/failure transition. Only an already durable `synced` duplicate receives 204; a lost lease or any other state uncertainty returns 503 for broker retry.
- Sync claims now only accept `broker_queued`, preserving the Dispatcher acknowledgement fence; `dispatch_pending` cannot be delivered directly.
- Permanent outcomes now create/idempotently retain an open `sync_failure_notices` record before a 489 acknowledgement, and return 503 if either durable step cannot be confirmed.
- Snapshot acceptance now requires a valid event aggregate whose event keys exactly match the complete valid immutable event set. Added corrupt/partial/newest-complete and snapshot-readback tests.
- Added current/next rotation, nbf, lost lease, dispatch fence, durable permanent notice, and duplicate-safe coverage.
- Verification: focused 2 files/12 tests, full 8 files/47 tests, and typecheck all pass. Follow-up commit: `ebcd605 fix: harden signed sync recovery`.

## Task 5 second review completion

- Default Worker construction now injects a production-shaped `GoogleDriveCapability` and `DriveDestinationAdapter`. It has no network side effect until the sync route is called; missing OAuth/folder configuration classifies through the Drive adapter as a permanent configuration/authorization failure rather than a missing-adapter 503.
- Durable `needs_attention` duplicate delivery returns QStash's non-retryable 489 header, while only `synced` returns 204.
- Snapshot validation now canonical-compares every aggregate event against its immutable event body, rejecting payload alteration even when identity and eventKey match.
- Security tests now actually exercise HS algorithm mismatch, audience mismatch, valid current and next signing keys, raw-body tampering, missing, expiration, and nbf. Duplicate permanent delivery uses a valid signature.
- Verification: focused 2 files/13 tests, full 8 files/48 tests, and typecheck pass. Commit: `57eaad7 fix: complete sync worker safety checks`.

# Task 6 — reconciliation, failure callbacks, and notices

- Red evidence: the new reconciler suite first failed because `src/reconciler.ts` did not exist. MCP tests then specified that notice lookup runs only after accepted Ingress persistence and must not reverse acceptance.
- Green evidence: focused reconciler (2 tests), Drive cache (9 tests), and MCP notice/submit (11 tests) suites pass. Final full verification passes 10 files / 58 tests and `pnpm typecheck` passes.
- Added a bounded reconciler: only `dispatch_pending` rows are dispatched. Hourly and six-hour paths deliberately do not mutate broker/sync/acknowledged-uncertain fences until a separately verified broker/DLQ reconciliation adapter exists.
- Added signed QStash terminal-failure callback handling on `/v1/qstash/failure`; raw signature is validated before parsing its body, then task identity is checked before idempotently opening a scoped failure notice and setting `needs_attention`.
- Notice GET now atomically consumes only the requesting user's open notices. MCP reads it only after a successful accepted submit and returns `[]` if the advisory lookup fails.
- Added module/isolate-local Drive adapter cache keyed by every credential and parent-folder identity; identical configuration reuses the capability and differing configuration does not.
- Public operator replay remains intentionally disabled because no authenticated operator remediation workflow exists yet; any future replay must be an explicit internal durable transition from `needs_attention`, never an automatic Cron action.
- Cron entries are configuration-ready only. No Cloudflare/QStash/Google call, deployment, credential, or secret was used.

## Task 6 review hardening

- Replaced select-then-update notice consumption with D1 `UPDATE ... RETURNING`; concurrent readers atomically claim open notices and cannot both surface the same notice.
- Added an internal-only `replayAfterRemediation` compare-and-set method: an explicit non-empty remediation acknowledgement can move only `needs_attention` to `dispatch_pending`; no public replay route exists and live states are rejected.
- Added direct signed failure-callback route coverage for current/next key rotation, missing signature, foreign task rejection, terminal 489 header, and idempotent notices.
- Replaced raw credential concatenation in the isolate-local cache key with a one-way non-secret fingerprint. Tests retain reuse/separation coverage.
- Final verification: `pnpm typecheck` and `pnpm test` passed (10 files, 61 tests). No external resource, credential, or deployment was used.

## Task 6 final cache/callback hardening

- The module cache now uses a full SHA-256 digest of length-delimited configuration values, never raw credentials, and keeps at most 64 least-recently-used adapters. Same configuration reuses an adapter; a different configuration remains isolated.
- Failure callback tests now prove tampered raw body, expired JWT, and incorrect audience all return non-retryable failure without mutating the job or notices.
- `replayAfterRemediation` remains an internal repository primitive only. Its caller must verify operator authorization and remediation evidence externally; the repository enforces only explicit acknowledgement plus atomic `needs_attention` CAS and there is no public route.
