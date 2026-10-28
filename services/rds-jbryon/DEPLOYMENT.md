# RDS-JBryon deployment handoff

This file is the RDS-JBryon deployment runbook and acceptance record. The dedicated Worker, D1, Queue, migration, workspace epoch, and local MCP registration are in place. The legacy RDS-V2 Worker, shared D1, four queues, archived Drive files, local source/cache, and old user environment variables were retired by 2026-10-28. Do not restart or deploy the retired code.

## Current deployment status (verified 2026-10-28)

| Item | Deployed value / result |
| --- | --- |
| Worker | `rds-jbryon` at `https://rds-jbryon.qiaobingyuan886.workers.dev`; deployment `c87a6701-e742-41a6-b5a8-56baaeee760a` verified |
| D1 | Dedicated `rds-jbryon` database in APAC; no pending migrations; remote schema catalog contains the RDS-JBryon tables |
| Queue | `rds-jbryon-projection`; one producer and one consumer binding, confirmed in current account inventory |
| Cron | `* * * * *` dispatcher enabled |
| Workspace | Fresh random epoch initialized and read back equal to the Worker variable |
| Authentication | Missing bearer credential returns HTTP 401; the service token is stored as a Cloudflare secret and in the ignored, user-restricted local `.dev.vars` file |
| Read-only acceptance | `capabilities` returned the expected product/protocol/epoch; root listing was empty and complete |
| Write/delete smoke | Temporary `project-rds-smoke` domain create and delete both reached `applied`/`projected`; final root listing was empty and complete |
| Local MCP | `rds-jbryon` was added to Codex and is listed as enabled; the launcher was tested over stdio. Reload Codex before expecting the current tool catalog to expose it. |

The smoke-test domain is logically deleted. The service deliberately retains tombstone and audit records; it does not hard-delete those identifiers. The RDS-V2 retirement removed its old resources and local client state while preserving RDS-JBryon. No RDS-JBryon redeployment was performed during the 2026-10-28 verification.

Wrangler's D1 account-list metadata reported `num_tables=0`, while a read-only query of the remote SQLite schema catalog returned 15 tables, including `workspace_meta`, `snapshots`, `requests`, and `tasks`. Treat the list count as inconsistent metadata; the actual schema and migration state were verified separately.

## Resource inventory

| Resource | Dedicated RDS-JBryon setting | Purpose |
| --- | --- | --- |
| Worker | `rds-jbryon` | HTTP `/rds`, Queue consumer, and one-minute Cron dispatcher |
| D1 | new database named `rds-jbryon` | Authoritative workspace, requests, tasks, and snapshots |
| Queue | one new uniquely named projection queue | Carries only task identity; D1 remains authoritative |
| Secret | `RDS_TOKEN` | Single-owner service access; never put it in JSONC or source control |
| Variable | `RDS_WORKSPACE_EPOCH` | 32-character lowercase hex workspace epoch matching the D1 row |
| Variable | `RDS_DISPATCH_LIMIT=20` | Maximum tasks staged per Cron invocation |

The checked-in configuration is intentionally `wrangler.jsonc.template`, not an auto-loaded Wrangler config. Its D1 ID, Queue name, and epoch are placeholders so a copy cannot deploy accidentally. After the Cloudflare account and resource names are confirmed, copy it to `wrangler.jsonc`, fill those values, and keep the working copy untracked if it contains account-specific identifiers.

## Safe order (historical deployment checklist; deployment completed 2026-10-27)

1. Confirm Wrangler is authenticated to the intended Cloudflare account. Read the account's D1 and Queue inventories first, and choose a **new dedicated** D1 database and Queue name. Do not point this Worker at the RDS-V2 D1 database or its queues.
2. Create the new D1 database and Queue, record their IDs/names, and populate the copied config. Avoid any `--update-config` action until the exact generated config changes are reviewed.
3. Review the target D1 name and ID, then apply only `migrations/0001_rds_jbryon.sql` to that new database with Wrangler's explicit `--remote` migration command. Wrangler prompts before applying migrations and captures a backup afterward; still verify the target before confirming.
4. Generate a fresh 16-byte random epoch locally. Update the seeded `workspace_meta` row in the new D1 database to that epoch, verify exactly one row changed, then put the same epoch in the Worker variable. Do not reuse an epoch from another workspace.
5. Set `RDS_TOKEN` with Wrangler's secret command. Do not paste the value into chat, a config file, a log, or a test report.
6. Run Wrangler validation/dry-run against the reviewed config. Then deploy the Worker to its `workers.dev` URL; no custom route or domain is configured by this template.
7. First verify only read-only `capabilities` and empty directory listing. Run a write/Queue smoke test only after selecting a disposable canary route and agreeing whether its test record should be retained or removed.
8. Install the local MCP connection only after the endpoint, token handling, and `project-12306` read/write behavior are verified. The retired MCP entry is disabled in the Skills plugin source and installed cache; restart Codex to refresh its tool catalog. The local legacy files and old user environment variables were cleared and verified on 2026-10-28.

## Local checks completed before account access

- Worker contract: the Cron only dispatches; Queue consumers perform projection. Queue-send failure releases the matching queued epoch; overdue handoffs and expired leases are safely redispatched.
- Duplicate Queue delivery remains protected by the D1 lease and epoch guard.
- RDS-JBryon full local test suite and the JSONC template contract test are run separately; they do not prove Cloudflare account, Queue, or remote D1 behavior.
- Wrangler 4.152.0 `deploy --dry-run` parsed the template and bundled the Worker successfully. The dry-run did not contact Cloudflare and cannot verify remote resource existence.

The official Wrangler configuration reference documents D1, Queue, Cron, and secret bindings: <https://developers.cloudflare.com/workers/wrangler/configuration/>. D1 database and migration commands are documented at <https://developers.cloudflare.com/d1/wrangler-commands/>.
