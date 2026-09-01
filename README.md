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

## Generic profile capability

The single `submit_event` tool also serves an opt-in generic user-profile
protocol. Five logical events share the existing tool:

- `system.capabilities.read` — discover whether the deployed runtime supports
  the generic profile protocol. Read-only via `/v1/query`.
- `system.user.resolve` — resolve a normalized display name to a stable
  `userId` without registering. Read-only via `/v1/query`.
- `system.user-registered` — explicit registration (unchanged behavior).
- `profile.snapshot.read` — read the rebuilt profile for a verified user and
  domain. Read-only via `/v1/query`.
- `profile.evidence.recorded` — append immutable profile evidence. Write via
  `/v1/jobs`; only this event is durable.

The protocol is gated by the Worker variable `GENERIC_PROFILE_ENABLED`. Only
the exact string `"true"` enables it; unset, empty, `"false"` and any other
value keep it off, and the three generic read/write events return
`unsupported_capability` while all existing events behave exactly as before.

Generic profile domains are kebab-case, length 2–64, matching
`^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$`, and reject the reserved names
`algorithm`, `interview`, `resume-knowledge`, `system` and `profile`. The
generic store writes only under `users/<userId>/<domain>/{events,profile/snapshots}`;
it never reuses the specialized domain folders.

A successful write acknowledgement reports only `deliveryState: "pending"`
(local SQLite durable) or `"cloud_accepted"` (D1 accepted). It never promises a
Drive `fileId`; Drive delivery is asynchronous. `profile_cache_pending` is a
Worker-internal projection state returned when the durable event was accepted
but the snapshot could not yet be cached; it is not an MCP acknowledgement.

Existing `algorithm`, `interview` and `resume-knowledge` domains remain
specialized and unchanged; their protocols, stores and reducers are not
migrated.
