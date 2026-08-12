# MCP Cloud Ingress Configuration

## Goal

Allow the local Reliable Drive Sync MCP server to submit persisted Outbox events to the deployed Cloudflare Worker. Preserve the local Outbox whenever cloud delivery is not configured or fails.

## Configuration contract

The MCP process reads only these local environment variables:

- `RELIABLE_DRIVE_SYNC_INGRESS_URL`: complete Worker ingress URL, currently `https://reliable-drive-sync.qiaobingyuan886.workers.dev/v1/jobs`.
- `RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET`: the same high-entropy value stored in Cloudflare as `INGRESS_SHARED_SECRET`.

Neither value belongs in source control. The Cloudflare secret and the local MCP variable use the same secret value but different variable names because they live on opposite sides of the HTTP boundary.

## Behavior

1. `submit_event` first persists the immutable event in the local SQLite Outbox.
2. When both variables are configured, an ingress transport sends a JSON `POST` to the configured URL with `Authorization: Bearer <secret>`.
3. Only HTTP `202` means the Worker accepted the event. The Outbox can then mark cloud acceptance.
4. Any non-`202` response, network error, timeout, or incomplete configuration leaves the event pending locally for `flush-pending`.
5. Incomplete configuration must never emit a network request or erase a local event.

## Boundaries

- This change does not alter QStash credentials, Drive credentials, D1 schema, or worker routes.
- QStash remains responsible for Worker-to-sync delivery; the new transport only covers MCP-to-Worker ingress.
- A dedicated `fetch`-backed `IngressTransport` keeps network logic testable and keeps `SubmitEventService` independent of environment parsing.

## Verification

Tests will cover URL/header/body construction, a `202` acceptance, non-`202` and network-error pending behavior, and safe no-network fallback for absent or partial configuration. Existing Outbox retry tests must continue to pass.

## Rollout

1. Generate one high-entropy ingress secret.
2. Put it into Cloudflare as `INGRESS_SHARED_SECRET`.
3. Add the two local variables to the Codex MCP server configuration.
4. Rebuild, deploy the Worker if necessary, and submit a non-sensitive test event.
