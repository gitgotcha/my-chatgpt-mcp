# Reliable Drive Sync MCP

This is the local WorkBuddy stdio entry point for Reliable Drive Sync. It
exposes exactly one MCP tool: `submit_event`, and forwards validated JSON-RPC
calls to the configured Worker ingress.

The launcher reads these environment variables without printing them:

- `RELIABLE_DRIVE_SYNC_NODE_PATH` (optional; defaults to `node`)
- `RELIABLE_DRIVE_SYNC_INGRESS_URL`
- `RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET`

WorkBuddy should point to `start.cmd` from a stable checkout. Do not point it at
the historical WorkBuddy package build, and do not place a secret in a committed
configuration file.

After restarting WorkBuddy, `tools/list` must return only:

```text
["submit_event"]
```
