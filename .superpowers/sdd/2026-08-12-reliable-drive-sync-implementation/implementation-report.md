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
