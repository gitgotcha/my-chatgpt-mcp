# Reliable Drive Sync Worker

This Cloudflare Worker accepts validated schema-1.2 envelopes at `/v1/jobs`,
stores them durably in a D1 Outbox, and delivers them asynchronously through
QStash to Google Drive. It does not expose a remote MCP endpoint. Everything is
written below one canonical root, `DriveRoot/my-chatGPT-skills/`, and identity
is global rather than per namespace.

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

Invalid envelopes are rejected before D1 persistence. Local MCP tool discovery
and JSON-RPC errors are handled by `tools/reliable-drive-sync-mcp`.

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
   wrangler secret put QSTASH_TOKEN
   wrangler secret put QSTASH_CURRENT_SIGNING_KEY
   wrangler secret put QSTASH_NEXT_SIGNING_KEY
   wrangler secret put GOOGLE_DRIVE_FOLDER_ID
   wrangler secret put GOOGLE_OAUTH_CLIENT_ID
   wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
   wrangler secret put GOOGLE_OAUTH_REFRESH_TOKEN
   ```

   Service-account alternative:

   ```text
   wrangler secret put MCP_BEARER_TOKEN
   wrangler secret put QSTASH_TOKEN
   wrangler secret put QSTASH_CURRENT_SIGNING_KEY
   wrangler secret put QSTASH_NEXT_SIGNING_KEY
   wrangler secret put GOOGLE_DRIVE_FOLDER_ID
   wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON
   ```

3. Apply D1 migrations and deploy:

   ```bash
   npx wrangler d1 migrations apply reliable-drive-sync --remote
   npx wrangler deploy
   ```

4. Configure ChatGPT desktop Work, Codex, and WorkBuddy through
   `tools/reliable-drive-sync-mcp/setup-local-clients.ps1`. All three use the
   same local stdio process and SQLite Outbox.

## Statuses and outputs

`POST /v1/jobs` returns HTTP 202 only after D1 stores or idempotently finds the
job. This is cloud-Outbox acceptance, not Drive completion. QStash invokes
`/v1/sync`; a signed terminal result then marks the job synced. Transient
`profile_cache_pending`, `cloud_persistence_pending`, and `resume_required`
results release the lease for retry. `already_scored_today` is terminal and does
not create a second score event for the same local date.

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

## Generic profile capability

An opt-in generic user-profile protocol shares `submit_event`. It is gated by
the `GENERIC_PROFILE_ENABLED` variable: only the exact string `"true"` enables
it. When disabled, `system.user.resolve`, `profile.snapshot.read` and
`profile.evidence.recorded` return `unsupported_capability`; every existing
event and Drive layout is unchanged.

Logical events and routes:

- `system.capabilities.read` → `/v1/query`, returns the protocol revision and
  the supported event-type list. Side-effect free.
- `system.user.resolve` → `/v1/query`, resolves a normalized display name to a
  stable `userId`. Never registers; unknown users return
  `identity_not_found`.
- `profile.snapshot.read` → `/v1/query`, returns the rebuilt profile for a
  verified user and domain. Selects the newest snapshot whose
  `sourceEventKeys` exactly equal the verified event-key set; otherwise
  rebuilds in memory and creates no file (`projectionState:
  "rebuilt_in_memory"`).
- `profile.evidence.recorded` → `/v1/jobs`, the only durable generic write.
  Ingress validates the bound inner event, domain and identity before
  `repository.createOrGet`, so a malformed request never creates a D1 job.

Generic domains are kebab-case, length 2–64, matching
`^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$`, and reject `algorithm`, `interview`,
`resume-knowledge`, `system` and `profile`. The generic store persists events
under `users/<userId>/<domain>/events/event-<eventId>.json` and snapshots under
`users/<userId>/<domain>/profile/snapshots/profile-<headEventId>.json`. Both
carry a SHA-256 `contentHash`; readback verifies the hash, single-parent
ownership, identity and domain before trusting any record.

The reducer is a pure, deterministic projection: a negative outcome opens a
weakness; only two positive outcomes from distinct `sourceRef` values after the
most recent negative close it into a stable strength; a partial after a
negative is an improving signal; `observed`/`consulted` never create or close
anything. Corrections (`supersede`/`invalidate`) target strictly earlier active
evidence and are sealed through `ProtocolError` so they become non-retryable
`needs_attention` jobs.

A `cloud_accepted` MCP receipt means D1 accepted the durable job; Drive delivery
remains asynchronous and the receipt never carries a Drive `fileId`.
`profile_cache_pending` is a Worker-internal state returned when the durable
event was accepted but the snapshot could not yet be cached; it is not an MCP
acknowledgement.
