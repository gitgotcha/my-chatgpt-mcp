# Algorithm Skill MCP Ingress Design

## Goal

Move algorithm-learning persistence from direct Google Drive connector writes to the reliable-drive-sync MCP ingress. The learning response must remain fast while events are stored durably on the local machine and synchronized to Google Drive asynchronously.

## Chosen Design

The algorithm skill calls the registered `reliable_drive_sync` MCP server's `submit_event` tool after an algorithm-learning response. It never calls Google Drive directly and never creates profile snapshots itself.

The MCP server validates the event, persists it in a local SQLite outbox, and attempts authenticated ingress delivery. A `202` means D1 accepted the job; unavailable networking leaves the event pending for a later preflush/SessionStart retry. The Cloudflare Worker owns D1 persistence, QStash dispatch, signed delivery verification, Google Drive writes, and snapshot reconstruction.

## Event Contract

Each request emits a deduplicated event with a stable `eventKey`, user identity, source skill `algorithm-learning`, destination `drive`, event type `learning.consulted`, and a payload containing only observed learning facts: problem, topic, outcome, evidence, tags, and timestamp. No secret, Google Drive credential, or profile snapshot is sent by the Skill.

## Local Configuration

Codex keeps the MCP server registration in its existing configuration. The MCP process inherits these user-level environment variables rather than storing secrets in `config.toml`:

- `RELIABLE_DRIVE_SYNC_INGRESS_URL`
- `RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET`
- `RELIABLE_DRIVE_SYNC_OUTBOX_PATH`

The first points at `/v1/jobs`; the secret must match Cloudflare's `INGRESS_SHARED_SECRET`; the outbox path is an absolute user-local SQLite location.

## Cloud Deployment

The existing remote D1 schema is treated as authoritative and inspected before deployment. The Worker remains bound to `DB`; it uses existing QStash and Google service-account secrets. Deployment is an idempotent Wrangler deploy after static checks. QStash is a managed broker and has no separate application deployment.

## Verification

1. Run package tests, typecheck, build, and build verification.
2. Verify D1 tables and Worker deployment bindings without reading secrets.
3. Verify the MCP server exposes `submit_event` with local configuration.
4. Submit an idempotent smoke event through MCP and inspect its D1 state.
5. If delivery reaches `synced`, confirm its immutable event and snapshot in the configured Drive folders. If it remains pending, report the exact boundary and preserve the local outbox record.

## Safety

The Skill never declares Drive completion based on local acceptance. It reports `accepted` / `cloud_accepted` only as returned by MCP. Existing direct Drive learning files remain immutable historical data and are not moved, edited, or deleted.
