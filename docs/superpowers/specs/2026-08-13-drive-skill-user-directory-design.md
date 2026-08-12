# Drive Skill/User Directory Design

## Goal

Store every newly synchronized immutable event and snapshot in a Drive directory determined by its `sourceSkill` and `userId`, without changing the local Outbox, D1, QStash, or existing files.

## Directory layout

For the configured events parent and snapshots parent, the Worker will use this structure:

```text
<events parent>/<sourceSkill>/<userId>/event-<eventKey>.json
<snapshots parent>/<sourceSkill>/<userId>/snapshot-<timestamp>-<uuid>.json
```

Example:

```text
events/algorithm-learning/qiaobingyuan/event-qiaobingyuan%3Aalgorithm-learning%3Atwo-sum....json
snapshots/interview/qiaobingyuan/snapshot-2026-08-13T....json
```

Existing files directly under either configured parent remain readable as historical data and are never moved, changed, or deleted. New writes exclusively use the new hierarchy.

## Directory resolution

The Worker derives the two path components directly from the already protocol-validated `sourceSkill` and `userId` values. A component must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`. Values outside this set cause a permanent `invalid_drive_identity` outcome; they are never sent to Google Drive as folder names.

For each write, the adapter lists the immediate parent for a folder with the desired name and Google Drive folder MIME type. It creates that folder only when absent, then repeats the same operation under it for the user directory. If more than one matching folder exists, it selects the lexicographically lowest Drive file id, making retry behavior deterministic.

## Drive boundary

`DriveCapability` gains a folder-aware list result and `ensureFolder(parentId, name)`. The production Google capability can list folder metadata and creates folders through the existing multipart upload endpoint using `application/vnd.google-apps.folder`; JSON creation remains restricted to JSON files. The destination adapter remains independent of Google HTTP details.

## Sync behavior

After resolving the event and snapshot user directories, the existing immutable event write, read-back validation, snapshot completeness validation, and state-machine outcomes are reused unchanged. A snapshot contains only immutable events found in that same event Skill/user directory, preventing cross-user and cross-Skill aggregates.

## Safety and verification

- No old Drive content is migrated or deleted.
- Folder creation is idempotent under normal retry: an existing same-name folder is reused.
- Tests cover hierarchy creation/reuse, Skill and user isolation, invalid component rejection before Drive I/O, and snapshot aggregation scoped to one hierarchy.
- The final verification includes focused tests, the full test suite, type-checking, build verification, deployment, and one new cloud smoke event.
