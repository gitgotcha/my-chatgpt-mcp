// RDS V2 paged rebuilds (Rev 6 plan T06 / addendum §7). A build stages the
// recomputed projection into a fresh generation page by page — one page per
// invocation, never a while loop — and only the final activation switches the
// active generation and advances the event cursor. Old-generation rows stay
// readable the whole time, and replayed pages cannot double-contribute
// because staging rows are keyed and upserted.
import { claimForProcessing, deferTask, completeTask, getTask, parkNeedsAttention } from "../tasks/repository.js";
import { commitActivation, assertRowChangesBounded, MAX_COMMIT_STATEMENTS } from "./commit.js";
import { canonicalJson } from "../../../../../shared/rds2-protocol.mjs";
import { deriveTaskId } from "../events/repository.js";
import { hashText } from "../identity/hashing.js";

export const BUILD_PAGE_SIZE = 50;
export const MAX_BUILD_PAGE_SIZE = 50;

// Page size is a bounded parameter, never an unbounded caller knob.
export function validatePageSize(pageSize) {
  const value = pageSize === undefined ? BUILD_PAGE_SIZE : Number(pageSize);
  if (!Number.isInteger(value) || value < 1 || value > MAX_BUILD_PAGE_SIZE) {
    const error = new Error("invalid_page_size");
    error.code = "invalid_page_size";
    throw error;
  }
  return value;
}

function stepResult(outcome, taskId, code) {
  return { outcome, taskId, code };
}

// A lost lease is NOT success: only the authoritative database state — build
// completed, generation switched, cursor at the frozen target — may back a
// completed verdict.
async function verifyBuildActivated({ db, scope, build }) {
  const buildRow = await db.prepare(
    "SELECT stage, staging_generation, base_revision, target_event_seq FROM rds2_projection_builds WHERE build_id = ?"
  ).bind(build.build_id).first();
  const head = await loadProjectionHead(db, scope);
  return Boolean(buildRow)
    && buildRow.stage === "completed"
    && Number(head.activeGeneration) === Number(buildRow.staging_generation)
    && Number(head.revision) === Number(buildRow.base_revision) + 1
    && Number(head.lastEventSeq) === Number(buildRow.target_event_seq);
}

export async function loadProjectionHead(db, scope) {
  const row = await db.prepare(
    `SELECT revision, last_event_seq, active_generation, building, summary_json
     FROM rds2_projections
     WHERE user_id = ? AND namespace = ? AND projection_name = ?`
  ).bind(scope.userId, scope.namespace, scope.projectionName).first();
  if (!row) {
    const error = new Error("projection_head_missing");
    error.code = "projection_head_missing";
    throw error;
  }
  return {
    revision: Number(row.revision),
    lastEventSeq: Number(row.last_event_seq),
    activeGeneration: Number(row.active_generation),
    building: Number(row.building),
    summary: row.summary_json === null ? null : JSON.parse(row.summary_json)
  };
}

export async function fetchEventBySeq(db, scope, eventSeq) {
  const row = await db.prepare(
    `SELECT event_seq, event_id, event_key, event_type, user_id, envelope_json
     FROM rds2_events
     WHERE user_id = ? AND namespace = ? AND projection_name = ? AND event_seq = ?`
  ).bind(scope.userId, scope.namespace, scope.projectionName, eventSeq).first();
  if (!row) return null;
  const envelope = JSON.parse(row.envelope_json);
  return {
    eventSeq: Number(row.event_seq),
    eventId: row.event_id,
    eventKey: row.event_key,
    eventType: row.event_type,
    userId: row.user_id,
    username: envelope.payload?.event?.username ?? envelope.identity?.username ?? null,
    payload: envelope.payload ?? {}
  };
}

// Creates (or reuses) the single running build for a scope, flags the head as
// building and schedules the first build-page task. Startup is transactional:
// the building flag is a CAS on the exact base revision and the build row's
// insert trigger requires that flag, so a build can never start on a stale
// base and a failed initiator can never leave half a build behind.
export async function ensureBuild({ db, scope, baseRevision, now }) {
  const head = await loadProjectionHead(db, scope);
  const running = await db.prepare(
    `SELECT build_id, stage, base_revision, target_event_seq, staging_generation
     FROM rds2_projection_builds
     WHERE user_id = ? AND namespace = ? AND projection_name = ?
       AND stage IN ('scanning', 'activating')`
  ).bind(scope.userId, scope.namespace, scope.projectionName).first();
  if (running) return running;
  const target = await db.prepare(
    `SELECT MAX(event_seq) AS maxSeq FROM rds2_events
     WHERE user_id = ? AND namespace = ? AND projection_name = ?`
  ).bind(scope.userId, scope.namespace, scope.projectionName).first("maxSeq");
  const targetEventSeq = Number(target);
  const stagingGeneration = head.activeGeneration + 1;
  const buildId = await deriveTaskId(scope, `build-${baseRevision}-${targetEventSeq}`, "build");
  const buildPageTask = await buildPageTaskId(scope, buildId, 1);
  try {
    await db.batch([
      // CAS: the flag flips only from revision 0-state on the exact base.
      db.prepare(
        `UPDATE rds2_projections SET building = 1, updated_at = ?
         WHERE user_id = ? AND namespace = ? AND projection_name = ?
           AND revision = ? AND building = 0`
      ).bind(now, scope.userId, scope.namespace, scope.projectionName, baseRevision),
      // The insert trigger requires building = 1, so a lost CAS aborts the
      // whole batch — no build row on a stale base.
      db.prepare(
        `INSERT INTO rds2_projection_builds (build_id, user_id, namespace, projection_name, base_revision,
           target_event_seq, stage, staging_generation, continuation_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'scanning', ?, NULL, ?, ?)`
      ).bind(buildId, scope.userId, scope.namespace, scope.projectionName, baseRevision,
        targetEventSeq, stagingGeneration, now, now),
      db.prepare(
        `INSERT INTO rds2_tasks (task_id, type, user_id, namespace, projection_name, event_seq, artifact_id,
           state, available_at, payload_json, created_at, updated_at)
         VALUES (?, 'projection_build', ?, ?, ?, NULL, NULL, 'pending', ?, json_set('{}', '$.buildId', json_quote(?)), ?, ?)`
      ).bind(buildPageTask, scope.userId, scope.namespace, scope.projectionName, now, buildId, now, now)
    ]);
  } catch (error) {
    // Re-read: a racing winner with the same base is fine, a moved base is a
    // diagnosable refusal — either way nothing was half-created.
    const winner = await db.prepare(
      `SELECT build_id, stage, base_revision, target_event_seq, staging_generation
       FROM rds2_projection_builds
       WHERE user_id = ? AND namespace = ? AND projection_name = ?
         AND stage IN ('scanning', 'activating')`
    ).bind(scope.userId, scope.namespace, scope.projectionName).first();
    if (winner && Number(winner.base_revision) === baseRevision) return winner;
    const failure = new Error("build_base_moved");
    failure.code = "build_base_moved";
    failure.cause = error;
    throw failure;
  }
  return { build_id: buildId, stage: "scanning", base_revision: baseRevision, target_event_seq: targetEventSeq, staging_generation: stagingGeneration };
}

async function buildPageTaskId(scope, buildId, pageNumber) {
  return deriveTaskId(scope, `${buildId}-page-${pageNumber}`, "build-page");
}

export async function continueBuild({ io, taskId, owner, now, reducer, pageSize = BUILD_PAGE_SIZE }) {
  const lease = await claimForProcessing({ db: io.db, taskId, owner, now });
  if (!lease) return stepResult("noop", taskId, "not_claimable");
  const scope = lease.scope;
  // Page tasks bind their build: the authoritative build row is loaded by the
  // task's payload buildId, never by "whatever is currently running".
  const taskRow = await getTask(io.db, taskId);
  const boundBuildId = (() => {
    try { return JSON.parse(taskRow?.payload_json ?? "{}")?.buildId ?? null; }
    catch { return null; }
  })();
  const build = boundBuildId
    ? await io.db.prepare(
        `SELECT build_id, base_revision, target_event_seq, stage, staging_generation, continuation_json
         FROM rds2_projection_builds WHERE build_id = ?`
      ).bind(boundBuildId).first()
    : null;
  if (!build || !["scanning", "activating"].includes(build.stage)) {
    // The build is already settled (completed, aborted or replaced): the page
    // task converges instead of holding a processing lease forever.
    const done = await completeTask({ db: io.db, lease, now });
    return done.rowsWritten
      ? stepResult("completed", taskId, "build_already_settled")
      : stepResult("noop", taskId, "no_running_build");
  }
  const head = await loadProjectionHead(io.db, scope);
  if (head.revision !== Number(build.base_revision)) {
    // The head moved under the build: abort it diagnostically, release the
    // building flag and let the next pass re-decide from the fresh head.
    await io.db.batch([
      io.db.prepare(
        `UPDATE rds2_projection_builds SET stage = 'aborted', continuation_json = NULL, updated_at = ?
         WHERE build_id = ? AND stage IN ('scanning', 'activating')`
      ).bind(now, build.build_id),
      io.db.prepare(
        `UPDATE rds2_projections SET building = 0, updated_at = ?
         WHERE user_id = ? AND namespace = ? AND projection_name = ? AND building = 1`
      ).bind(now, scope.userId, scope.namespace, scope.projectionName)
    ]);
    await deferTask({ db: io.db, lease, now, availableAt: now });
    return stepResult("retry", taskId, "deferred_build_aborted");
  }
  const targetEventSeq = Number(build.target_event_seq);
  const effectivePageSize = validatePageSize(pageSize);
  let continuation = build.continuation_json
    ? JSON.parse(build.continuation_json)
    : null;
  if (!continuation) {
    const first = await io.db.prepare(
      `SELECT MIN(event_seq) AS minSeq FROM rds2_events
       WHERE user_id = ? AND namespace = ? AND projection_name = ?`
    ).bind(scope.userId, scope.namespace, scope.projectionName).first("minSeq");
    continuation = { nextEventSeq: first === null ? targetEventSeq + 1 : Number(first), stagedCount: 0, page: 1 };
  }
  if (!Number.isInteger(continuation.nextEventSeq) || continuation.nextEventSeq < 1) {
    const error = new Error("build_continuation_invalid");
    error.code = "build_continuation_invalid";
    throw error;
  }

  // Page reads are bounded by the FROZEN target: events that arrived after
  // the build started belong to a later build, never to this one.
  const events = [];
  if (continuation.nextEventSeq <= targetEventSeq) {
    const page = await io.db.prepare(
      `SELECT event_seq, event_id, event_key, event_type, user_id, envelope_json
       FROM rds2_events
       WHERE user_id = ? AND namespace = ? AND projection_name = ?
         AND event_seq >= ? AND event_seq <= ?
       ORDER BY event_seq LIMIT ?`
    ).bind(scope.userId, scope.namespace, scope.projectionName, continuation.nextEventSeq,
      targetEventSeq, effectivePageSize).all();
    for (const row of page.results) {
      const envelope = JSON.parse(row.envelope_json);
      events.push({
        eventSeq: Number(row.event_seq),
        eventId: row.event_id,
        eventKey: row.event_key,
        eventType: row.event_type,
        userId: row.user_id,
        username: envelope.payload?.event?.username ?? envelope.identity?.username ?? null,
        payload: envelope.payload ?? {}
      });
    }
  }

  // The reducer owns its consumption cursor: it may process fewer events than
  // the page offered (bounded row changes). Activation is decided by the
  // consumption progress, never by the fetched page length.
  const emptyPage = events.length === 0;
  let pageResult = null;
  if (!emptyPage) {
    pageResult = reducer.buildPage({
      scope, events, head,
      continuation: { ...continuation, nextAfterPage: events[events.length - 1].eventSeq + 1 }
    });
    const nextSeq = pageResult.continuation?.nextEventSeq;
    if (!Number.isInteger(nextSeq) || nextSeq <= continuation.nextEventSeq || nextSeq > targetEventSeq + 1) {
      // No forward progress or a cursor beyond the fetched range is a
      // deterministic reducer contract violation — never a silent loop.
      await parkNeedsAttention({ db: io.db, lease, now, code: "build_no_progress" });
      return stepResult("needs_attention", taskId, "build_no_progress");
    }
  }
  const nextEventSeq = emptyPage ? targetEventSeq + 1 : pageResult.continuation.nextEventSeq;
  const done = nextEventSeq > targetEventSeq;

  try {
    if (!done) {
      // Mid-build page: stage rows, save the continuation, schedule the next
      // page and complete this task — all atomic, cursor untouched. The same
      // bounded-commit checks apply as for a final activation.
      assertRowChangesBounded(pageResult.rowChanges);
      const guardId = await deriveTaskId(scope, `guard-${lease.taskId}-${lease.epoch}`, "guard");
      const nextTaskId = await buildPageTaskId(scope, build.build_id, continuation.page + 1);
      const statements = [
        io.db.prepare(
          `INSERT INTO rds2_commit_guards (guard_id, task_id, owner, expected_epoch, now_utc, expected_revision, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(guardId, lease.taskId, lease.owner, lease.epoch, now, head.revision, now),
        ...pageResult.rowChanges.map((change) => io.db.prepare(
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
          `UPDATE rds2_projection_builds SET continuation_json = ?, updated_at = ?
           WHERE build_id = ? AND stage = 'scanning'`
        ).bind(canonicalJson({
          ...pageResult.continuation,
          nextEventSeq,
          page: continuation.page + 1
        }), now, build.build_id),
        io.db.prepare(
          `INSERT INTO rds2_tasks (task_id, type, user_id, namespace, projection_name, event_seq, artifact_id,
             state, available_at, payload_json, created_at, updated_at)
           VALUES (?, 'projection_build', ?, ?, ?, NULL, NULL, 'pending', ?, json_set('{}', '$.buildId', json_quote(?)), ?, ?)
           ON CONFLICT (task_id) DO NOTHING`
        ).bind(nextTaskId, scope.userId, scope.namespace, scope.projectionName, now, build.build_id, now, now),
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
      return stepResult("continued", taskId, "build_page_staged");
    }

    // Final page (or an empty terminator page): the activation switches the
    // generation atomically.
    await commitActivation({
      io, lease, build, baseRevision: head.revision,
      changes: {
        rowChanges: emptyPage ? [] : pageResult.rowChanges,
        summary: (emptyPage ? null : pageResult.summary) ?? head.summary,
        eventSeq: targetEventSeq
      },
      now
    });
    return stepResult("completed", taskId, "build_activated");
  } catch (error) {
    if (error?.code === "changes_too_large" || error?.code === "commit_batch_too_large") throw error;
    const deferred = await deferTask({ db: io.db, lease, now, availableAt: now });
    if (!deferred.rowsWritten) {
      // The lease was taken over — only the AUTHORITATIVE state may declare
      // the build complete (R4 verifies task, build stage, head and cursor).
      const converged = await verifyBuildActivated({ db: io.db, scope, build });
      return converged
        ? stepResult("completed", taskId, "build_activated")
        : stepResult("noop", taskId, "lease_lost");
    }
    return stepResult("retry", taskId, "deferred_commit_failed");
  }
}

export { hashText };
