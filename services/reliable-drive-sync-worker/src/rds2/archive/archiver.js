// RDS V2 single-object archiver (Rev 6 plan T08 / addendum §9). One frozen
// object per invocation: find exact, upload once only when absent, verify by
// content readback, and complete through a guarded batch. Content hashes are
// compared against the artifact hash frozen at accept time (the exact frozen
// bytes) — a mismatch never overwrites and parks the task immediately.
import { claimForProcessing, completeTask, failTask, parkNeedsAttention } from "../tasks/repository.js";
import { hashText } from "../identity/hashing.js";
import { deriveTaskId } from "../events/repository.js";
import { canonicalJson } from "../../../../../shared/rds2-protocol.mjs";
import {
  requireScope, scopeFieldsEqual, validateDelta, validatePackage,
  validateWindowCoverage, replayError
} from "./replay-validate.js";

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
    if (error?.code === "drive_search_incomplete" || error?.code === "drive_response_invalid"
      || error?.code === "drive_response_too_large") {
      // Deterministic contract failures on the lookup side: the archive is
      // NOT allowed to conclude "no such object" and upload, and retrying
      // the same call cannot change the answer.
      await parkNeedsAttention({ db: io.db, lease: activeLease, now, code: error.code });
      return stepResult("needs_attention", taskId, error.code);
    }
    const failed = await failTask({ db: io.db, lease: activeLease, now, code: "drive_error" });
    return stepResult(failed.state === "needs_attention" ? "needs_attention" : "retry",
      taskId, "drive_error");
  }
}

// Offline replay: rebuild a projection from archived artifacts alone.
// Every artifact's bytes are hash-verified; the kind/storageVersion/scope are
// validated; deltas must chain contiguously from baseRevision 0; an
// activation delta's build manifest demands every build package of that
// generation, so a missing page is a hard error instead of partial data.
export async function replayProjection(artifacts) {
  const parsed = [];
  for (const artifact of artifacts) {
    const actual = await hashText(artifact.frozenJson);
    if (actual !== artifact.hash) {
      const error = new Error("replay_hash_mismatch");
      error.code = "replay_hash_mismatch";
      error.artifact = artifact.objectName;
      throw error;
    }
    let data;
    try {
      data = JSON.parse(artifact.frozenJson);
    } catch {
      const error = new Error("replay_artifact_invalid");
      error.code = "replay_artifact_invalid";
      error.artifact = artifact.objectName;
      throw error;
    }
    parsed.push({ ...artifact, data });
  }
  let scopeKey = null;
  for (const item of parsed) {
    // Event artifacts are identity context, not replay input: only deltas
    // and build packages carry the storage contract.
    if (item.objectType !== "projection_delta" && item.objectType !== "build_package") continue;
    if (item.data.storageVersion !== 2) {
      const error = new Error("replay_artifact_invalid");
      error.code = "replay_artifact_invalid";
      error.artifact = item.objectName;
      throw error;
    }
    const expectedKind = item.objectType === "projection_delta" ? "projection_delta"
      : item.objectType === "build_package" ? "build_package"
      : item.objectType === "event" ? null : undefined;
    if (expectedKind === undefined || (expectedKind !== null && item.data.kind !== expectedKind)) {
      const error = new Error("replay_artifact_invalid");
      error.code = "replay_artifact_invalid";
      error.artifact = item.objectName;
      throw error;
    }
    // R1: the scope is NOT optional. A delta or package without a complete
    // scope cannot be attributed to a projection at all.
    const scope = requireScope(item.data.scope, item.objectName);
    // R2: scopes are compared field by field — never by JSON text, which
    // would make the verdict depend on key order no writer promises.
    if (scopeKey === null) scopeKey = scope;
    else if (!scopeFieldsEqual(scope, scopeKey)) {
      throw replayError("replay_scope_mismatch", item.objectName);
    }
    // S1–S5 / R4 / R7 / R9: the artifact must be internally coherent on its
    // own before it is allowed to take part in a replay.
    if (item.objectType === "projection_delta") validateDelta(item.data, item.objectName);
    else validatePackage(item.data, item.objectName);
  }
  const deltas = parsed
    .filter((item) => item.objectType === "projection_delta")
    .map((item) => item.data)
    .sort((left, right) => left.revision - right.revision);
  if (!deltas.length) {
    const error = new Error("replay_missing_page");
    error.code = "replay_missing_page";
    throw error;
  }
  const packagesByBuild = new Map();
  for (const item of parsed) {
    if (item.objectType !== "build_package") continue;
    if (!packagesByBuild.has(item.data.buildId)) packagesByBuild.set(item.data.buildId, []);
    packagesByBuild.get(item.data.buildId).push(item.data);
  }
  const generations = new Map();
  const rowsOf = (generation) => {
    if (!generations.has(generation)) generations.set(generation, new Map());
    return generations.get(generation);
  };
  let activeGeneration = 0;
  let expectedRevision = 0;
  let revision = 0;
  let summary = null;
  let previousEventSeq = null;
  for (const delta of deltas) {
    if (delta.baseRevision !== expectedRevision) {
      const error = new Error("replay_missing_page");
      error.code = "replay_missing_page";
      error.expectedBaseRevision = expectedRevision;
      error.foundBaseRevision = delta.baseRevision;
      throw error;
    }
    // R5: the replayed cursor never rewinds. An activation delta sits at its
    // frozen target, so a rewind means two activations claim the same range.
    if (previousEventSeq !== null && delta.eventSeq < previousEventSeq) {
      throw replayError("replay_revision_not_chained", null, {
        field: "eventSeq", previousEventSeq, foundEventSeq: delta.eventSeq
      });
    }
    previousEventSeq = delta.eventSeq;
    if (delta.build) {
      const manifest = delta.build;
      const packages = (packagesByBuild.get(manifest.buildId) ?? [])
        .sort((left, right) => left.page - right.page);
      if (packages.length !== manifest.pages) {
        const error = new Error("replay_missing_page");
        error.code = "replay_missing_page";
        error.buildId = manifest.buildId;
        throw error;
      }
      // R6: page numbers must tile 1..pages — a duplicate page is as fatal as
      // a missing one, because either leaves the manifest unprovable.
      const seenPages = new Set();
      for (const pkg of packages) {
        if (seenPages.has(pkg.page)) {
          throw replayError("replay_missing_page", null, {
            buildId: manifest.buildId, duplicatePage: pkg.page
          });
        }
        seenPages.add(pkg.page);
      }
      for (let index = 0; index < packages.length; index += 1) {
        const pkg = packages[index];
        if (pkg.page !== index + 1) {
          const error = new Error("replay_missing_page");
          error.code = "replay_missing_page";
          error.buildId = manifest.buildId;
          throw error;
        }
        if (pkg.buildId !== manifest.buildId) {
          throw replayError("replay_manifest_invalid", null, { field: "buildId" });
        }
        if (pkg.generation !== manifest.generation) {
          throw replayError("replay_manifest_invalid", null, { field: "generation" });
        }
        const rows = rowsOf(manifest.generation);
        for (const change of pkg.rowChanges) {
          rows.set(change.rowKind + ":" + change.rowKey, change.value);
        }
      }
      // R8: the manifest's window must be exactly tiled by the packages'
      // chained scan windows. Cross-user sequence gaps inside a window are
      // expected; a window seam that does not close is not.
      if (manifest.pages >= 1) validateWindowCoverage(manifest, packages, null);
      activeGeneration = manifest.generation;
    } else {
      const rows = rowsOf(activeGeneration);
      for (const change of delta.changes) {
        rows.set(change.rowKind + ":" + change.rowKey, change.value);
      }
    }
    if (delta.summary !== undefined && delta.summary !== null) summary = delta.summary;
    expectedRevision = delta.revision;
    revision = delta.revision;
  }
  const finalRows = {};
  for (const [key, value] of generations.get(activeGeneration) ?? []) {
    finalRows[key] = canonicalJson(value);
  }
  return {
    revision,
    summary: summary === null ? null : canonicalJson(summary),
    rows: finalRows
  };
}
