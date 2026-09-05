// RDS V2 single-object archiver (Rev 6 plan T08 / addendum §9). One frozen
// object per invocation: find exact, upload once only when absent, verify by
// content readback, and complete through a guarded batch. Content hashes are
// compared against the artifact hash frozen at accept time (the exact frozen
// bytes) — a mismatch never overwrites and parks the task immediately.
import { claimForProcessing, completeTask, failTask, parkNeedsAttention } from "../tasks/repository.js";
import { hashText } from "../identity/hashing.js";
import { deriveTaskId } from "../events/repository.js";

function stepResult(outcome, taskId, code) {
  return { outcome, taskId, code };
}

// Guarded completion: the trigger validates the lease first, then the
// delivery result and the task completion land in the same atomic batch.
async function completeArchive({ io, lease, artifactId, driveFileId, now }) {
  const guardId = await deriveTaskId(
    lease.scope, `archive-guard-${lease.taskId}-${lease.epoch}`, "guard"
  );
  await io.db.batch([
    io.db.prepare(
      `INSERT INTO rds2_commit_guards (guard_id, task_id, owner, expected_epoch, now_utc, expected_revision, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`
    ).bind(guardId, lease.taskId, lease.owner, lease.epoch, now, now),
    io.db.prepare(
      `UPDATE rds2_archive_deliveries SET drive_file_id = ?, delivered_at = ?
       WHERE artifact_id = ? AND delivered_at IS NULL`
    ).bind(driveFileId, now, artifactId),
    io.db.prepare(
      `UPDATE rds2_tasks SET state = 'completed', lease_owner = NULL, lease_until = NULL, updated_at = ?
       WHERE task_id = ? AND state = 'processing'
         AND lease_owner = ? AND lease_epoch = ? AND lease_until > ?`
    ).bind(now, lease.taskId, lease.owner, lease.epoch, now),
    io.db.prepare("DELETE FROM rds2_commit_guards WHERE guard_id = ?").bind(guardId)
  ]);
}

export async function archiveOne({ io, taskId, owner, now, client, lease = null }) {
  const activeLease = lease ?? await claimForProcessing({ db: io.db, taskId, owner, now });
  if (!activeLease) return stepResult("noop", taskId, "not_claimable");
  const artifactId = activeLease.artifactId;
  if (!artifactId) {
    await parkNeedsAttention({ db: io.db, lease: activeLease, now, code: "artifact_missing" });
    return stepResult("needs_attention", taskId, "artifact_missing");
  }
  const artifact = await io.db.prepare(
    `SELECT artifact_id, object_name, frozen_json, artifact_hash, drive_file_id, delivered_at
     FROM rds2_archive_deliveries WHERE artifact_id = ?`
  ).bind(artifactId).first();
  if (!artifact) {
    await parkNeedsAttention({ db: io.db, lease: activeLease, now, code: "artifact_missing" });
    return stepResult("needs_attention", taskId, "artifact_missing");
  }

  try {
    if (artifact.delivered_at && artifact.drive_file_id) {
      // Already verified and delivered in an earlier pass: converge on the
      // completed state without touching Drive again.
      const done = await completeTask({ db: io.db, lease: activeLease, now });
      return done.rowsWritten
        ? stepResult("completed", taskId, null)
        : stepResult("retry", taskId, "completion_lost_lease");
    }
    const existing = await client.findExact(artifact.object_name);
    let driveFileId;
    if (existing.length === 0) {
      const uploaded = await client.upload(artifact.object_name, artifact.frozen_json);
      driveFileId = uploaded.id;
    } else if (existing.length === 1) {
      driveFileId = existing[0].id;
    } else {
      // Ambiguity is a diagnosable state: several same-name objects exist, so
      // neither overwriting nor guessing a winner is acceptable.
      await parkNeedsAttention({ db: io.db, lease: activeLease, now, code: "ambiguous_artifact" });
      return stepResult("needs_attention", taskId, "ambiguous_artifact");
    }
    // Content-only readback, verified against the frozen artifact hash.
    const content = await client.readContent(driveFileId);
    const actualHash = await hashText(content.text);
    if (actualHash !== artifact.artifact_hash) {
      await parkNeedsAttention({ db: io.db, lease: activeLease, now, code: "artifact_hash_mismatch" });
      return stepResult("needs_attention", taskId, "artifact_hash_mismatch");
    }
    try {
      await completeArchive({ io, lease: activeLease, artifactId, driveFileId, now });
      return stepResult("completed", taskId, null);
    } catch {
      // The completion guard rejected (stale owner / expired lease): the
      // Drive object is fine, but nothing may be reported as delivered.
      return stepResult("retry", taskId, "completion_lost_lease");
    }
  } catch (error) {
    if (error?.code === "artifact_not_json" || error?.code === "artifact_too_large") {
      // The object in Drive is not the artifact we froze: integrity problem.
      await parkNeedsAttention({ db: io.db, lease: activeLease, now, code: error.code });
      return stepResult("needs_attention", taskId, error.code);
    }
    const failed = await failTask({ db: io.db, lease: activeLease, now, code: "drive_error" });
    return stepResult(failed.state === "needs_attention" ? "needs_attention" : "retry",
      taskId, "drive_error");
  }
}

// Offline replay: rebuild a projection generation from archived artifacts
// alone. Every artifact's bytes are hash-verified, deltas must chain
// contiguously from baseRevision 0, and a missing page is a hard error.
export async function replayProjection(artifacts) {
  for (const artifact of artifacts) {
    const actual = await hashText(artifact.frozenJson);
    if (actual !== artifact.hash) {
      const error = new Error("replay_hash_mismatch");
      error.code = "replay_hash_mismatch";
      error.artifact = artifact.objectName;
      throw error;
    }
  }
  const deltas = artifacts
    .filter((artifact) => artifact.objectType === "projection_delta")
    .map((artifact) => ({ artifact, delta: JSON.parse(artifact.frozenJson) }))
    .sort((left, right) => left.delta.revision - right.delta.revision);
  if (!deltas.length) {
    const error = new Error("replay_missing_page");
    error.code = "replay_missing_page";
    throw error;
  }
  const rows = {};
  let expectedRevision = 0;
  let revision = 0;
  for (const { delta } of deltas) {
    if (delta.baseRevision !== expectedRevision) {
      const error = new Error("replay_missing_page");
      error.code = "replay_missing_page";
      error.expectedBaseRevision = expectedRevision;
      error.foundBaseRevision = delta.baseRevision;
      throw error;
    }
    for (const change of delta.changes) {
      rows[`${change.rowKind}:${change.rowKey}`] = change.value;
    }
    expectedRevision = delta.revision;
    revision = delta.revision;
  }
  return {
    revision,
    rows: Object.fromEntries(Object.entries(rows)
      .map(([key, value]) => [key, JSON.stringify(value)]))
  };
}
