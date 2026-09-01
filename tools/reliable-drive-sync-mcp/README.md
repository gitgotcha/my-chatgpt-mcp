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
not enter either Outbox.

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

Environment variables read by `start.cmd`:

- `RELIABLE_DRIVE_SYNC_INGRESS_URL`
- `RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET`
- `RELIABLE_DRIVE_SYNC_NODE_PATH` (optional; defaults to `node`)
- `RELIABLE_DRIVE_SYNC_OUTBOX_PATH` (optional)

There is deliberately no public `/mcp` endpoint, capability URL, OAuth flow, or
Secure MCP Tunnel in this architecture.
