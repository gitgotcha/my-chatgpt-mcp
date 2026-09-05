# RDS V2 Shared Protocol Types (Rev 6)

Authority: `docs/superpowers/specs/2026-09-05-rds-v2-rev6-design-addendum.md` and
`docs/superpowers/plans/2026-09-05-rds-v2-remaining-development-plan-rev6.md` (T01).
Executable source: `shared/rds2-protocol.mjs`. This document records the
contract; the code is normative for behaviour, this file is normative for intent.

## Submission classification

```ts
type Scope = { userId: string; namespace: string; projectionName: string };

type SubmissionKind = "read" | "write" | "adminOnly" | "disabled";

type Classification = { kind: SubmissionKind; envelope: Envelope };
```

- `read` — `system.capabilities.read`, `system.user.resolve`,
  `interview.session.list`, `interview.session.load`, `profile.snapshot.read`.
  These are served by `/v2/query` (Rev 6 addendum §5); at `/v2/events` they are
  rejected with `read_only_event`.
- `adminOnly` — `system.user-registered`. Only the admin initialization entry
  accepts it; the ordinary write endpoint returns `unsupported_write_type`.
- `disabled` — `system.legacy-migration-requested`. V2 always answers
  `migration_disabled`; it is never silently converted into a learning event.
- `write` — every other existing V1 event type (the 13 business writes).
- Classification runs the full V1 `validateEnvelope` first; malformed
  submissions throw the existing V1 error codes (`invalid_schema_version`,
  `invalid_event_type`, `invalid_payload`, ...). `system.user.resolve` accepts
  only `payload.displayName`; a `username` payload is invalid and can never
  turn a read into a write.

## Idempotency decision

```ts
type IntentRows = {
  request: { requestId: string; envelopeHash: string; canonicalEventId: string } | null;
  eventById: { eventId: string; contentHash: string } | null;
  eventByKey: { eventId: string; contentHash: string } | null;
  businessKey: { eventId: string; contentHash: string } | null;
};

type IncomingIntent = {
  requestId: string; eventId: string; eventKey: string; eventType: string;
  envelopeHash: string; contentHash: string;
  businessKeyConfigured: boolean;
};

type IntentDecision =
  | { outcome: "new"; code: null; eventId: string; ignoredDuplicate: false }
  | { outcome: "replay"; code: "already_recorded"; eventId: string; ignoredDuplicate: false }
  | { outcome: "alias"; code: "already_recorded"; eventId: string; ignoredDuplicate: false }
  | { outcome: "firstResult"; code: "already_recorded"; eventId: string; ignoredDuplicate: true }
  | { outcome: "conflict"; code:
      | "identity_of_intent_conflict" | "request_id_conflict"
      | "event_id_conflict" | "event_key_conflict"; eventId: string | null };
```

- `decideIntent` is pure and synchronous; it never performs I/O. The pre-check
  and the post-UNIQUE-constraint recheck must call this same function (Rev 6
  plan T04), at most one recheck per submission.
- Conflict priority: when the present rows reference more than one distinct
  event, the result is `identity_of_intent_conflict` regardless of which key
  disagreed — never an arbitrary row choice.
- `businessKeyConfigured` is true only for `BUSINESS_KEY_EVENT_TYPES`
  (initially `resume-knowledge.answer-scored`). The same-day duplicate branch
  must not freeze same-day events of any other domain.
- `businessKey` is derived server-side as
  `hashJson([boundUserId, eventType, questionKey, localDate])` — identity comes
  from the verified credential, never from the payload.

## Hashes

- `canonicalJson(value)`: keys sorted recursively, arrays keep order,
  non-representable values (undefined / function / symbol / bigint / NaN /
  Infinity / circular) are rejected, output is UTF-8.
- `envelopeHash = hashJson(full envelope)` — includes the transport requestId;
  used for strict replay checking of the same request.
- `contentHash = hashJson({schemaVersion, namespace, eventType, identity, payload})`
  — the complete business event and identity WITHOUT the transport requestId;
  used for eventId / eventKey / businessKey comparisons. Changing only the
  requestId changes the envelopeHash but never the contentHash.

## V2 query DTO (addendum §5)

```ts
type Query = {
  storageVersion: 2;
  operation:
    | "capabilities" | "user.resolve" | "projection.read"
    | "interview.session.list" | "interview.session.load" | "event.status";
  params: Record<string, unknown>;
};
```

- Exactly the three top-level fields; no write envelope is accepted here.
- `capabilities`: `{}`. `user.resolve`: `{displayName}` (resolves only the
  credential-bound user). `projection.read`:
  `{namespace, projectionName, limit?, cursor?}` — no default scope, both scope
  fields are required. `interview.session.list`: `{limit?, cursor?}`.
  `interview.session.load`: `{sessionId}`. `event.status`:
  `{targetRequestId}` XOR `{targetEventId}` — strictly exactly one target.
- `limit` is an integer 1..50 when present (default 20 is applied by the
  query service, not by validation); `cursor` is a non-empty string. Extra or
  missing params reject with `invalid_query_params`; unknown operation with
  `invalid_query_operation`; wrong storage version with
  `invalid_query_storage_version`; wrong top-level shape with `invalid_query`.

## Receipts (T04 consumes these)

```ts
type WriteReceipt = {
  storageVersion: 2; attemptedRequestId: string; canonicalRequestId: string;
  eventId: string; jobId: string; userId: string;
  disposition: "accepted" | "already_recorded";
  ignoredDuplicate: boolean; cloudPersistence: "d1_committed";
};
```

`jobId` is the projection taskId derived from the first event (scope +
eventId + type), not the Queue message id. A receipt only ever proves D1
persistence (`cloudPersistence: "d1_committed"`); projection and Drive archive
state are separate dimensions exposed by `event.status`.
