# Reliable Drive Sync local MCP

This is the local stdio entry point shared by ChatGPT desktop Work, Codex, and
WorkBuddy. It exposes exactly one tool, `submit_event`.

Write path:

```text
local stdio MCP -> SQLite Outbox -> Worker /v1/jobs -> D1 Outbox
                 -> QStash / Worker retry -> Google Drive
```

The event is written to SQLite before any network call. A row is removed only
after `/v1/jobs` returns HTTP 202 with a non-empty `jobId`. Rows left in
`pending` or interrupted in `sending` are retried automatically. Read-only
interview session queries and legacy migration dry-runs use `/v1/query` and do
not enter either Outbox. When `RELIABLE_DRIVE_SYNC_WRITE_VERSION=v2`, the
same read-only operations use `/v2/query`, while writes use `/v2/events`.

## Windows setup

From the repository root:

```powershell
$env:RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET = '<Worker MCP_BEARER_TOKEN>'
.\tools\reliable-drive-sync-mcp\setup-local-clients.ps1
```

The script:

- persists `RELIABLE_DRIVE_SYNC_INGRESS_URL` and the shared secret in the
  current user's environment;
- adds `[mcp_servers.reliable_drive_sync]` to `~/.codex/config.toml`, used by
  ChatGPT desktop and Codex;
- writes or updates a WorkBuddy `mcpServers` JSON file pointing to the same
  `start.cmd`;
- never places the shared secret in either client configuration.

Pass `-WorkBuddyConfigPath '<path>'` when WorkBuddy already has a known JSON MCP
configuration file. Otherwise the generated file is placed below
`%LOCALAPPDATA%\ReliableDriveSync\workbuddy-mcp.json` for import in WorkBuddy.

Restart ChatGPT desktop, Codex, and WorkBuddy. `tools/list` must return only:

```text
["submit_event"]
```

## Receipt meanings

- `deliveryState: "cloud_accepted"`: SQLite staged the event and D1 accepted
  the durable job. `persistence.drive` is still `pending`.
- `deliveryState: "pending"`: SQLite holds the event, but D1 acceptance has not
  been confirmed yet. The client may close safely; the row remains durable.

Neither receipt claims that Google Drive has already finished. Drive delivery
is completed asynchronously by QStash and the Worker.

For V2 receipts, `persistence.localOutbox: "pending"` means the envelope is
durable locally but D1 has not acknowledged it yet; `cloudPersistence:
"d1_committed"` means D1 accepted it. Drive archival remains asynchronous and
must be checked separately; no V2 receipt claims a Drive file id or completed
archival until the archive worker has verified it.

Environment variables read by `start.cmd`:

- `RELIABLE_DRIVE_SYNC_INGRESS_URL`
- `RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET`
- `RELIABLE_DRIVE_SYNC_NODE_PATH` (optional; defaults to `node`)
- `RELIABLE_DRIVE_SYNC_OUTBOX_PATH` (optional)

There is deliberately no public `/mcp` endpoint, capability URL, OAuth flow, or
Secure MCP Tunnel in this architecture.

## Generic profile reads and writes

The local server also routes the opt-in generic profile protocol over the same
`submit_event` tool. `tools/list` still exposes exactly one tool.

- `system.capabilities.read`, `system.user.resolve` and `profile.snapshot.read`
  flow directly to `/v2/query` in V2 mode and never enter the SQLite Outbox. Capability
  discovery works without `identity` or `displayName`.
- `profile.evidence.recorded` is a durable write to `/v2/events`. Before enqueue, the local
  delivery service validates the caller event shape and domain, requires an
  explicit `identity.userId`/`identity.username`, and resolves an existing
  identity through `/v1/identity`. A `404` returns `identity_not_found` before
  any enqueue and never fabricates a local UUID; the old timeout/404 fallback
  that auto-registers strangers remains untouched for legacy event types.
- Bound identity and domain are written into `payload.event` before the
  envelope is sent to `/v2/events`, matching the shape the Worker ingress
  validates.
- `unsupported_capability`, `invalid_domain`, `invalid_profile_event` and
  `identity_not_found` are permanent (non-retryable) local results.

A `cloud_accepted` receipt means D1 accepted the durable job; it never promises
a Drive `fileId`. A `pending` receipt means SQLite still holds the event for
retry. `profile_cache_pending` is a Worker-internal projection state, not an
immediate MCP acknowledgement.
