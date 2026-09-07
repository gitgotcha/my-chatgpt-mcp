// G2-F3: strict structural validation of replay inputs.
//
// A correct hash only proves the bytes are the bytes we froze — it says
// nothing about whether the content honours the storage contract. These
// validators close that gap: every projection_delta and build_package must
// carry a complete scope, well-typed integers and a coherent range, and a
// build manifest must be provable from its packages.
//
// Every rejection is a STABLE code and a hard failure: replay never returns a
// partial result as if it were a complete recovery.
import { canonicalJson } from "../../../../../shared/rds2-protocol.mjs";

export const SCOPE_FIELDS = Object.freeze(["userId", "namespace", "projectionName"]);

function replayError(code, artifactName, extra = {}) {
  const error = new Error(code);
  error.code = code;
  error.artifact = artifactName ?? null;
  for (const [key, value] of Object.entries(extra)) error[key] = value;
  return error;
}

// R1: the scope is NOT optional. A delta or package without a complete scope
// cannot be attributed to a projection, so it can never be replayed.
export function requireScope(scope, artifactName) {
  if (scope === null || typeof scope !== "object" || Array.isArray(scope)) {
    throw replayError("replay_scope_missing", artifactName);
  }
  for (const field of SCOPE_FIELDS) {
    const value = scope[field];
    if (typeof value !== "string" || value.length === 0) {
      throw replayError("replay_scope_missing", artifactName, { field });
    }
  }
  return scope;
}

// R2: scopes are compared FIELD BY FIELD. Comparing JSON strings would make
// the verdict depend on key order, which no writer promises.
export function scopeFieldsEqual(left, right) {
  return SCOPE_FIELDS.every((field) => left[field] === right[field]);
}

function assertSafeInteger(value, field, artifactName, { min = 0, allowNull = false } = {}) {
  // `firstEventSeq: null` on an empty build is the ONE sanctioned exception
  // (plan §4.2): the field is absent because no event was ever consumed.
  if (allowNull && (value === null || value === undefined)) return null;
  if (!Number.isSafeInteger(value) || value < min) {
    throw replayError("replay_artifact_invalid", artifactName, { field });
  }
  return value;
}

// S1: change collections are arrays of well-formed row changes. The null /
// missing rules for optional fields mirror the writer, which upserts
// `member_key` / `sort_key` with `?? null` — a validator that rejected its
// own output would be useless.
function assertChangeArray(changes, field, artifactName) {
  if (!Array.isArray(changes)) {
    throw replayError("replay_artifact_invalid", artifactName, { field });
  }
  for (const change of changes) {
    if (change === null || typeof change !== "object" || Array.isArray(change)) {
      throw replayError("replay_artifact_invalid", artifactName, { field });
    }
    if (typeof change.rowKind !== "string" || change.rowKind.length === 0
      || typeof change.rowKey !== "string" || change.rowKey.length === 0) {
      throw replayError("replay_artifact_invalid", artifactName, { field });
    }
    for (const optional of ["memberKey", "sortKey"]) {
      const value = change[optional];
      if (value !== undefined && value !== null && typeof value !== "string") {
        throw replayError("replay_artifact_invalid", artifactName, { field });
      }
    }
    if (change.value === undefined) {
      throw replayError("replay_artifact_invalid", artifactName, { field });
    }
  }
}

// R4 / R5 / S2 for a projection delta (normal incremental or activation).
export function validateDelta(delta, artifactName) {
  assertSafeInteger(delta.baseRevision, "baseRevision", artifactName);
  assertSafeInteger(delta.revision, "revision", artifactName);
  if (delta.revision !== delta.baseRevision + 1) {
    // A jump or a rewind breaks the chain: the archive cannot prove that
    // nothing in between was lost.
    throw replayError("replay_revision_not_chained", artifactName, {
      expectedRevision: delta.baseRevision + 1,
      foundRevision: delta.revision
    });
  }
  assertSafeInteger(delta.eventSeq, "eventSeq", artifactName);
  assertChangeArray(delta.changes, "changes", artifactName);
  if (delta.build !== null && delta.build !== undefined) {
    validateManifest(delta.build, artifactName);
  }
}

// S3 / S4 / R7 for a build manifest. `pages: 0` is legal for exactly ONE
// encoding — the zero-event build — and never for a non-empty event range.
export function validateManifest(manifest, artifactName) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw replayError("replay_manifest_invalid", artifactName);
  }
  if (typeof manifest.buildId !== "string" || manifest.buildId.length === 0) {
    throw replayError("replay_manifest_invalid", artifactName, { field: "buildId" });
  }
  assertSafeInteger(manifest.generation, "generation", artifactName, { min: 1 });
  assertSafeInteger(manifest.pages, "pages", artifactName);
  if (manifest.pages === 0) {
    if (manifest.firstEventSeq !== null || manifest.lastEventSeq !== 0) {
      throw replayError("replay_range_inconsistent", artifactName, { field: "pages" });
    }
    return;
  }
  assertSafeInteger(manifest.firstEventSeq, "firstEventSeq", artifactName, { min: 1 });
  assertSafeInteger(manifest.lastEventSeq, "lastEventSeq", artifactName, { min: 1 });
  if (manifest.lastEventSeq < manifest.firstEventSeq) {
    throw replayError("replay_range_inconsistent", artifactName, { field: "lastEventSeq" });
  }
}

// R9 / §4.2 for a build package: the recorded range is what the page actually
// CONSUMED (a non-empty prefix of what it read), plus both scan cursors so an
// offline replay can prove the windows chain without gaps.
export function validatePackage(pkg, artifactName) {
  if (typeof pkg.buildId !== "string" || pkg.buildId.length === 0) {
    throw replayError("replay_manifest_invalid", artifactName, { field: "buildId" });
  }
  assertSafeInteger(pkg.generation, "generation", artifactName, { min: 1 });
  assertSafeInteger(pkg.page, "page", artifactName, { min: 1 });
  if (pkg.consumedCount === 0) {
    // A page that consumed nothing cannot exist: it would re-read its events
    // forever, so this is a range contradiction, not a typing one.
    throw replayError("replay_range_inconsistent", artifactName, { field: "consumedCount" });
  }
  assertSafeInteger(pkg.consumedCount, "consumedCount", artifactName, { min: 1 });
  assertSafeInteger(pkg.firstEventSeq, "firstEventSeq", artifactName, { min: 1 });
  assertSafeInteger(pkg.lastEventSeq, "lastEventSeq", artifactName, { min: 1 });
  if (pkg.lastEventSeq < pkg.firstEventSeq) {
    throw replayError("replay_range_inconsistent", artifactName, { field: "lastEventSeq" });
  }
  assertSafeInteger(pkg.scanFirstCursor, "scanFirstCursor", artifactName, { min: 1 });
  assertSafeInteger(pkg.scanCursorAfter, "scanCursorAfter", artifactName, { min: 1 });
  if (pkg.scanCursorAfter <= pkg.scanFirstCursor) {
    throw replayError("replay_range_inconsistent", artifactName, { field: "scanCursorAfter" });
  }
  // The consumed range and the scan window must agree EXACTLY: the last
  // consumed event is the one just below the post-scan cursor.
  if (pkg.lastEventSeq !== pkg.scanCursorAfter - 1) {
    throw replayError("replay_range_inconsistent", artifactName, { field: "lastEventSeq" });
  }
  assertChangeArray(pkg.rowChanges, "rowChanges", artifactName);
}

// R8: the manifest's window must be exactly covered by its packages' chained
// scan windows. Sequence numbers may contain other users' gaps — that is fine
// — but the windows themselves must tile without a hole.
export function validateWindowCoverage(manifest, packages, artifactName) {
  let expectedCursor = manifest.firstEventSeq;
  for (const pkg of packages) {
    if (pkg.scanFirstCursor !== expectedCursor) {
      throw replayError("replay_range_inconsistent", artifactName, {
        field: "scanFirstCursor",
        expectedCursor
      });
    }
    expectedCursor = pkg.scanCursorAfter;
  }
  if (expectedCursor !== manifest.lastEventSeq + 1) {
    throw replayError("replay_range_inconsistent", artifactName, {
      field: "scanCursorAfter",
      expectedCursor
    });
  }
}

export { replayError, canonicalJson };
