// RDS V2 guarded projection commit (Rev 6 plan T06 / addendum §7). Every
// commit is ONE D1 batch in a fixed order: guard insert (the trigger
// validates lease, epoch and base revision at the database level), the
// bounded row changes, the head or build update, the frozen delta plus its
// archive task, the lease-bound task completion, and the guard delete. Any
// failure rolls the whole batch back — no half deltas, no half heads.
import { canonicalJson } from "../../../../../shared/rds2-protocol.mjs";
import { hashText } from "../identity/hashing.js";
import { deriveTaskId } from "../events/repository.js";

export const MAX_ROW_CHANGES_PER_COMMIT = 20;
export const MAX_ROW_JSON_BYTES = 64 * 1024;
export const MAX_DELTA_BYTES = 256 * 1024;
export const MAX_COMMIT_STATEMENTS = 32;

export function assertRowChangesBounded(rowChanges) {
  if (!Array.isArray(rowChanges) || rowChanges.length > MAX_ROW_CHANGES_PER_COMMIT) {
    const error = new Error("changes_too_large");
    error.code = "changes_too_large";
    throw error;
  }
  for (const change of rowChanges) {
    if (new TextEncoder().encode(canonicalJson(change.value)).length > MAX_ROW_JSON_BYTES) {
      const error = new Error("changes_too_large");
      error.code = "changes_too_large";
      throw error;
    }
  }
}

export function buildDelta({ scope, baseRevision, revision, eventSeq, rowChanges }) {
  return {
    storageVersion: 2,
    kind: "projection_delta",
    scope: { ...scope },
    baseRevision,
    revision,
    eventSeq,
    changes: rowChanges
  };
}

async function deltaArtifact({ io, scope, revision, eventSeq, delta }) {
  const frozenJson = canonicalJson(delta);
  if (new TextEncoder().encode(frozenJson).length > MAX_DELTA_BYTES) {
    const error = new Error("changes_too_large");
    error.code = "changes_too_large";
    throw error;
  }
  const artifactHash = await hashText(frozenJson);
  const artifactId = await deriveTaskId(scope, `delta-${revision}-${eventSeq}`, "artifact-delta");
  return { frozenJson, artifactHash, artifactId };
}

// A projection commit that applies `changes` on top of `baseRevision` and
// completes the leased task inside the same atomic batch. Rows land in the
// CURRENT active generation; the building flag is left untouched. Guarded by
// the trigger, a losing commit aborts with zero side effects.
export async function commitProjection({ io, lease, baseRevision, activeGeneration, changes, now }) {
  assertRowChangesBounded(changes.rowChanges);
  const revision = baseRevision + 1;
  const delta = buildDelta({
    scope: lease.scope, baseRevision, revision,
    eventSeq: changes.eventSeq, rowChanges: changes.rowChanges
  });
  const { frozenJson, artifactHash, artifactId } = await deltaArtifact({
    io, scope: lease.scope, revision, eventSeq: changes.eventSeq, delta
  });
  const archiveTaskId = await deriveTaskId(lease.scope, `delta-${revision}-${changes.eventSeq}`, "archive-delta");
  const guardId = await deriveTaskId(lease.scope, `guard-${lease.taskId}-${lease.epoch}`, "guard");
  const scope = lease.scope;

  const statements = [
    io.db.prepare(
      `INSERT INTO rds2_commit_guards (guard_id, task_id, owner, expected_epoch, now_utc, expected_revision, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(guardId, lease.taskId, lease.owner, lease.epoch, now, baseRevision, now),
    ...changes.rowChanges.map((change) => io.db.prepare(
      `INSERT INTO rds2_projection_rows (user_id, namespace, projection_name, generation, row_kind, row_key,
         member_key, sort_key, value_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, namespace, projection_name, generation, row_kind, row_key)
       DO UPDATE SET member_key = excluded.member_key, sort_key = excluded.sort_key,
         value_json = excluded.value_json, updated_at = excluded.updated_at`
    ).bind(
      scope.userId, scope.namespace, scope.projectionName, activeGeneration,
      change.rowKind, change.rowKey, change.memberKey ?? null, change.sortKey ?? null,
      canonicalJson(change.value), now
    )),
    io.db.prepare(
      `UPDATE rds2_projections SET revision = ?, last_event_seq = ?, summary_json = ?, updated_at = ?
       WHERE user_id = ? AND namespace = ? AND projection_name = ?
         AND revision = ? AND last_event_seq < ?`
    ).bind(revision, changes.eventSeq, changes.summary === null ? null : canonicalJson(changes.summary), now,
      scope.userId, scope.namespace, scope.projectionName, baseRevision, changes.eventSeq),
    io.db.prepare(
      `INSERT INTO rds2_archive_deliveries (artifact_id, user_id, namespace, projection_name, object_type,
         object_name, frozen_json, artifact_hash, created_at)
       VALUES (?, ?, ?, ?, 'projection_delta', ?, ?, ?, ?)`
    ).bind(artifactId, scope.userId, scope.namespace, scope.projectionName,
      `${artifactId}.json`, frozenJson, artifactHash, now),
    io.db.prepare(
      `INSERT INTO rds2_tasks (task_id, type, user_id, namespace, projection_name, event_seq, artifact_id,
         state, available_at, created_at, updated_at)
       VALUES (?, 'archive_delta', ?, ?, ?, NULL, ?, 'pending', ?, ?, ?)`
    ).bind(archiveTaskId, scope.userId, scope.namespace, scope.projectionName, artifactId, now, now, now),
    io.db.prepare(
      `UPDATE rds2_tasks SET state = 'completed', lease_owner = NULL, lease_until = NULL, updated_at = ?
       WHERE task_id = ? AND state = 'processing'
         AND lease_owner = ? AND lease_epoch = ? AND lease_until > ?`
    ).bind(now, lease.taskId, lease.owner, lease.epoch, now),
    io.db.prepare("DELETE FROM rds2_commit_guards WHERE guard_id = ?").bind(guardId)
  ];
  if (statements.length > MAX_COMMIT_STATEMENTS) {
    const error = new Error("commit_batch_too_large");
    error.code = "commit_batch_too_large";
    throw error;
  }
  await io.db.batch(statements);
  return { revision, artifactId };
}

// The activation commit for a finished build: switch the active generation,
// advance the cursor to the build target and complete the leased task, all
// guarded by the unchanged base revision.
export async function commitActivation({ io, lease, build, baseRevision, changes, now }) {
  assertRowChangesBounded(changes.rowChanges);
  const revision = baseRevision + 1;
  const delta = buildDelta({
    scope: lease.scope, baseRevision, revision,
    eventSeq: build.target_event_seq, rowChanges: changes.rowChanges
  });
  const { frozenJson, artifactHash, artifactId } = await deltaArtifact({
    io, scope: lease.scope, revision, eventSeq: build.target_event_seq, delta
  });
  const archiveTaskId = await deriveTaskId(lease.scope, `delta-${revision}-${build.target_event_seq}`, "archive-delta");
  const guardId = await deriveTaskId(lease.scope, `guard-${lease.taskId}-${lease.epoch}`, "guard");
  const scope = lease.scope;

  const statements = [
    io.db.prepare(
      `INSERT INTO rds2_commit_guards (guard_id, task_id, owner, expected_epoch, now_utc, expected_revision, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(guardId, lease.taskId, lease.owner, lease.epoch, now, baseRevision, now),
    ...changes.rowChanges.map((change) => io.db.prepare(
      `INSERT INTO rds2_projection_rows (user_id, namespace, projection_name, generation, row_kind, row_key,
         member_key, sort_key, value_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, namespace, projection_name, generation, row_kind, row_key)
       DO UPDATE SET member_key = excluded.member_key, sort_key = excluded.sort_key,
         value_json = excluded.value_json, updated_at = excluded.updated_at`
    ).bind(
      scope.userId, scope.namespace, scope.projectionName, build.staging_generation,
      change.rowKind, change.rowKey, change.memberKey ?? null, change.sortKey ?? null,
      canonicalJson(change.value), now
    )),
    io.db.prepare(
      `UPDATE rds2_projection_builds SET stage = 'completed', continuation_json = NULL, updated_at = ?
       WHERE build_id = ? AND stage IN ('scanning', 'activating')`
    ).bind(now, build.build_id),
    io.db.prepare(
      `UPDATE rds2_projections SET revision = ?, last_event_seq = ?, active_generation = ?,
         building = 0, summary_json = ?, updated_at = ?
       WHERE user_id = ? AND namespace = ? AND projection_name = ?
         AND revision = ? AND building = 1`
    ).bind(revision, build.target_event_seq, build.staging_generation,
      changes.summary === null ? null : canonicalJson(changes.summary), now,
      scope.userId, scope.namespace, scope.projectionName, baseRevision),
    io.db.prepare(
      `INSERT INTO rds2_archive_deliveries (artifact_id, user_id, namespace, projection_name, object_type,
         object_name, frozen_json, artifact_hash, created_at)
       VALUES (?, ?, ?, ?, 'projection_delta', ?, ?, ?, ?)`
    ).bind(artifactId, scope.userId, scope.namespace, scope.projectionName,
      `${artifactId}.json`, frozenJson, artifactHash, now),
    io.db.prepare(
      `INSERT INTO rds2_tasks (task_id, type, user_id, namespace, projection_name, event_seq, artifact_id,
         state, available_at, created_at, updated_at)
       VALUES (?, 'archive_delta', ?, ?, ?, NULL, ?, 'pending', ?, ?, ?)`
    ).bind(archiveTaskId, scope.userId, scope.namespace, scope.projectionName, artifactId, now, now, now),
    io.db.prepare(
      `UPDATE rds2_tasks SET state = 'completed', lease_owner = NULL, lease_until = NULL, updated_at = ?
       WHERE task_id = ? AND state = 'processing'
         AND lease_owner = ? AND lease_epoch = ? AND lease_until > ?`
    ).bind(now, lease.taskId, lease.owner, lease.epoch, now),
    io.db.prepare("DELETE FROM rds2_commit_guards WHERE guard_id = ?").bind(guardId)
  ];
  if (statements.length > MAX_COMMIT_STATEMENTS) {
    const error = new Error("commit_batch_too_large");
    error.code = "commit_batch_too_large";
    throw error;
  }
  await io.db.batch(statements);
  return { revision, artifactId };
}
