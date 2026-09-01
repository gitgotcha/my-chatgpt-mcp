# Reliable Drive Sync

Reliable Drive Sync is the single persistence boundary for the skills
ecosystem. It exposes exactly one MCP tool, `submit_event`, and writes only
validated schema `1.2` events through the canonical Drive layout:

```text
DriveRoot/my-chatGPT-skills/user-registry/
DriveRoot/my-chatGPT-skills/users/<userId>/<domain>/events/
DriveRoot/my-chatGPT-skills/users/<userId>/<domain>/profile/snapshots/
```

## Repository layout

- `services/reliable-drive-sync-worker/` — Cloudflare Worker and its tests.
- `tools/reliable-drive-sync-mcp/` — local WorkBuddy/Codex stdio bridge.

## Verify locally

```bash
npm test
```

The repository has no runtime npm dependencies. Node.js 22 or newer is
recommended.

## Deploy the Worker

```bash
cd services/reliable-drive-sync-worker
npx wrangler deploy
```

Configure the Worker secrets before deployment:

```text
MCP_BEARER_TOKEN
GOOGLE_DRIVE_FOLDER_ID
GOOGLE_OAUTH_CLIENT_ID
GOOGLE_OAUTH_CLIENT_SECRET
GOOGLE_OAUTH_REFRESH_TOKEN
```

The service-account alternative is documented in the Worker README.

## Configure the local bridge

Point WorkBuddy at `tools/reliable-drive-sync-mcp/start.cmd` on Windows (or
run `stdio-bridge.mjs` with Node on other platforms), and provide:

```text
RELIABLE_DRIVE_SYNC_INGRESS_URL
RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET
```

After restarting the host, `tools/list` must return only `submit_event`.

Direct Drive writes and the removed artifact/candidate tools are intentionally
unsupported.
