# RDS-JBryon

RDS-JBryon is the single-user snapshot and persistence service for 乔炳源. It provides path-routed JSON snapshots, durable local Outbox writes, D1 persistence, queue-based projection, retries, and conflict-aware updates.

## Runtime

- Cloudflare Worker: `services/rds-jbryon/`
- Local stdio MCP: `tools/rds-jbryon-mcp/`
- Local Outbox: `%LOCALAPPDATA%/ReliableDriveSync/rds-jbryon-outbox.sqlite`
- Cloud resources are configured in `services/rds-jbryon/wrangler.jsonc`; secrets stay outside the repository.

Users route data with readable paths such as `project/12306/学习快照.json` and `knowledge/java/jvm/学习快照.json`. Internal node IDs and request IDs are service-managed.

## Verify and deploy

Requires Node.js 22 or newer.

```powershell
npm test
npm run test:worker
npm run test:bridge
```

Deployment is an explicit operation:

```powershell
npm run deploy:rds-jbryon
```

## Reliability boundaries

An accepted request is durably queued locally before network delivery. Cloud acceptance, projection, and readable snapshot state are distinct stages; report only the stage confirmed by the service. Queue retries and Cron recovery remain enabled. Concurrent updates merge independent fields and surface same-field conflicts for user resolution.
