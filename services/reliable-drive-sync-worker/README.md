# Reliable Drive Sync Worker

This Cloudflare Worker exposes one JSON-RPC tool: `submit_event`. It stores
schema-1.2 JSON events in a Google Shared Drive and verifies every created file
by reading it back. Everything is written below one canonical root,
`DriveRoot/my-chatGPT-skills/`, and identity is global rather than per namespace.

## Canonical layout

```text
DriveRoot/my-chatGPT-skills/user-registry/registration-<userId>.json
DriveRoot/my-chatGPT-skills/users/<userId>/identity.json
DriveRoot/my-chatGPT-skills/users/<userId>/algorithm/{events,profile/snapshots,plans/daily}
DriveRoot/my-chatGPT-skills/users/<userId>/interview/{events,profile/snapshots}
DriveRoot/my-chatGPT-skills/users/<userId>/resume-knowledge/{sources/resume/snapshots,question-bank/snapshots,events,profile/snapshots,plans/daily}
```

Namespace-scoped user folders and namespace-level registries are never created
any more; the global registry under the canonical root is the only one.

## Envelope

```json
{
  "schemaVersion": "1.2",
  "namespace": "interview",
  "eventType": "interview.session.list",
  "identity": { "username": "乔炳源" },
  "payload": {},
  "requestId": "<uuid>"
}
```

`identity.userId` is optional and only checked, never trusted: the Worker
resolves the stable `userId` from the display name and rejects the call when a
supplied id contradicts the global registry. Names are normalized with NFKC plus
trimming, so the same name always resolves to the same `userId` across every
domain.

### Event types

```text
system.user-registered
system.legacy-migration-requested
algorithm.learning.completed
algorithm.daily-plan-created
interview.session.list
interview.session.load
interview.session.completed
interview.review.completed
resume-knowledge.resume-ingested
resume-knowledge.claim-confirmed
resume-knowledge.claim-rejected
resume-knowledge.question-bank-created
resume-knowledge.daily-plan-created
resume-knowledge.answer-scored
```

Calling a removed tool returns JSON-RPC `-32601`; an invalid envelope, payload or
identity returns `-32602`.

## Error statuses

| status | meaning |
| --- | --- |
| `invalid_schema_version` | envelope is not `schemaVersion: "1.2"` |
| `invalid_envelope` / `invalid_namespace` / `invalid_event_type` | unknown or malformed routing fields |
| `invalid_request_id` | missing request id |
| `invalid_identity` / `identity_mismatch` | the supplied id contradicts the registry |
| `invalid_payload` | payload fails the event-type schema |
| `user_conflict` | one name maps to more than one id; resolution stops |
| `event_key_conflict` | the same idempotency key carries different content |
| `projection_conflict` | a target snapshot already holds different content |
| `migration_plan_required` / `migration_plan_stale` | execute without, or with a void, approval |
| `migration_conflict` | a migration target holds different content; nothing is copied |
| `legacy_read_only` | a write was attempted against a pre-normalization path |

## Runtime setup

1. Create or select the Drive root folder and grant the OAuth user access. OAuth
   is the recommended deployment because service accounts do not have My Drive
   storage quota. A Shared Drive can also be used.
2. Configure Worker secrets (never commit them). OAuth setup:

   ```text
   wrangler secret put MCP_BEARER_TOKEN
   wrangler secret put GOOGLE_DRIVE_FOLDER_ID
   wrangler secret put GOOGLE_OAUTH_CLIENT_ID
   wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
   wrangler secret put GOOGLE_OAUTH_REFRESH_TOKEN
   ```

   Service-account alternative:

   ```text
   wrangler secret put MCP_BEARER_TOKEN
   wrangler secret put GOOGLE_DRIVE_FOLDER_ID
   wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON
   ```

3. For ChatGPT Work, run the one-step PowerShell setup from this directory:

   ```powershell
   .\setup-chatgpt-work.ps1
   ```

   It generates a new 256-bit URL token, stores it as the Cloudflare secret
   `MCP_URL_TOKEN`, deploys the Worker, and copies the complete MCP URL to the
   clipboard. It never prints or commits the token.

4. In ChatGPT Work, enable Developer mode, open Plugins, choose `+`, select an
   HTTPS/Streamable HTTP connection, paste the clipboard URL, and choose
   **No Authentication**. Tool discovery must show only `submit_event`.

The URL itself is the credential. Do not publish, screenshot, or commit it. If
it is exposed, run `setup-chatgpt-work.ps1` again; the new secret immediately
invalidates the prior URL after deployment. The original Worker root remains a
Bearer-authenticated JSON-RPC endpoint for the local Codex and WorkBuddy bridge.

## Statuses and outputs

`status: "ok"` is returned only after the event and any profile snapshot are
confirmed by Drive readback. If the event cannot be written, local Skills still
write JSON with `cloud_persistence_pending`. If the event is durable but the
rebuildable profile cache fails, the response is `profile_cache_pending` and the
event remains the source of truth. `already_scored_today` means the answer was
fed back but a second event for the same local date is never persisted.
`resume_required` means a resume snapshot must be ingested first.

Session and review copies are saved locally at:

```text
outputs/interview/<userId>/interview-<sessionId>-session.json
outputs/interview/<userId>/interview-<sessionId>-report.json
outputs/interview/<userId>/interview-<sessionId>-report.docx
```

Only the JSON event is uploaded. Markdown transcripts, Base64 payloads, and DOCX
reports are never uploaded; the Word file is generated locally from report JSON.

## Legacy migration safety boundary

`system.legacy-migration-requested` is the only way to touch pre-normalization
data, and it never runs automatically.

- `mode: "dry-run"` reports source, target and content hashes, plus copy, skip
  and conflict counts, and writes nothing at all.
- `mode: "execute"` requires the `migrationId` and the `approvedPlanHash` of the
  dry-run it approves. The scan is repeated and the hash must still match, so a
  source that changed in between voids the approval.
- Only missing objects are copied, and every copy is read back and compared
  against the source hash. Identical targets are skipped. A target that holds
  different content stops the whole run before any file is written.
- Source objects are only ever read: never updated, moved or deleted. The run
  writes an auditable `migration-<migrationId>-receipt.json` below the user root.
