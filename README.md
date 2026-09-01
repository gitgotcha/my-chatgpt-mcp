# Reliable Drive Sync

Reliable Drive Sync is the single persistence boundary for the skills
ecosystem. The local stdio server exposes exactly one MCP tool, `submit_event`.
Every write is staged in SQLite, accepted into a D1 cloud Outbox through
`/v1/jobs`, and then delivered asynchronously to the canonical Drive layout:

```text
DriveRoot/my-chatGPT-skills/user-registry/
DriveRoot/my-chatGPT-skills/users/<userId>/<domain>/events/
DriveRoot/my-chatGPT-skills/users/<userId>/<domain>/profile/snapshots/
```

## Repository layout

- `services/reliable-drive-sync-worker/` — Cloudflare Worker and its tests.
- `tools/reliable-drive-sync-mcp/` — local ChatGPT desktop Work, Codex, and
  WorkBuddy stdio server with a SQLite Outbox.

## Verify locally

```bash
npm test
```

The repository has no runtime npm dependencies. Node.js 22 or newer is
recommended.

## Deploy the Worker

```bash
cd services/reliable-drive-sync-worker
npx wrangler d1 migrations apply reliable-drive-sync --remote
npx wrangler deploy
```

Configure the Worker secrets before deployment:

```text
MCP_BEARER_TOKEN
QSTASH_TOKEN
QSTASH_CURRENT_SIGNING_KEY
QSTASH_NEXT_SIGNING_KEY
GOOGLE_DRIVE_FOLDER_ID
GOOGLE_OAUTH_CLIENT_ID
GOOGLE_OAUTH_CLIENT_SECRET
GOOGLE_OAUTH_REFRESH_TOKEN
```

The service-account alternative is documented in the Worker README.

## Configure the local bridge

On Windows, run the setup script once from PowerShell. It configures the shared
ChatGPT desktop/Codex `config.toml`, writes a WorkBuddy MCP JSON configuration,
and persists the Worker settings without printing the secret:

```powershell
$env:RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET = '<Worker MCP_BEARER_TOKEN>'
.\tools\reliable-drive-sync-mcp\setup-local-clients.ps1
```

The stdio server reads:

```text
RELIABLE_DRIVE_SYNC_INGRESS_URL
RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET
RELIABLE_DRIVE_SYNC_OUTBOX_PATH (optional)
```

After restarting all three clients, `tools/list` must return only
`submit_event`. A `cloud_accepted` receipt means D1 accepted the durable job;
Drive remains asynchronous. A `pending` receipt means SQLite still holds the
event for retry.

Direct Drive writes and the removed artifact/candidate tools are intentionally
unsupported.
