// RDS V2 paged rebuilds (Rev 6 plan T06 / addendum §7). A build stages the
// recomputed projection into a fresh generation page by page — one page per
// invocation, never a while loop — and only the final activation switches the
// active generation and advances the event cursor. Old-generation rows stay
// readable the whole time, and replayed pages cannot double-contribute
// because staging rows are keyed and upserted.
import { claimForProcessing, deferTask } from "../tasks/repository.js";
import { commitActivation } from "./commit.js";
import { canonicalJson } from "../../../../../shared/rds2-protocol.mjs";
import { deriveTaskId } from "../events/repository.js";
import { hashText } from "../identity/hashing.js";

export const BUILD_PAGE_SIZE = 50;

function stepResult(outcome, taskId, code) {
  return { outcome, taskId, code };
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
// building and schedules the first build-page task.
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
  await db.batch([
    db.prepare(
      `INSERT INTO rds2_projection_builds (build_id, user_id, namespace, projection_name, base_revision,
         target_event_seq, stage, staging_generation, continuation_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'scanning', ?, NULL, ?, ?)`
    ).bind(buildId, scope.userId, scope.namespace, scope.projectionName, baseRevision,
      targetEventSeq, stagingGeneration, now, now),
    db.prepare(
      `UPDATE rds2_projections SET building = 1, updated_at = ?
       WHERE user_id = ? AND namespace = ? AND projection_name = ?`
    ).bind(now, scope.userId, scope.namespace, scope.projectionName),
    db.prepare(
      `INSERT INTO rds2_tasks (task_id, type, user_id, namespace, projection_name, event_seq, artifact_id,
         state, available_at, created_at, updated_at)
       VALUES (?, 'projection_build', ?, ?, ?, NULL, NULL, 'pending', ?, ?, ?)`
    ).bind(await buildPageTaskId(scope, buildId, 1), scope.userId, scope.namespace, scope.projectionName, now, now, now)
  ]);
  return { build_id: buildId, stage: "scanning", base_revision: baseRevision, target_event_seq: targetEventSeq, staging_generation: stagingGeneration };
}

async function buildPageTaskId(scope, buildId, pageNumber) {
  return deriveTaskId(scope, `${buildId}-page-${pageNumber}`, "build-page");
}

export async function continueBuild({ io, taskId, owner, now, reducer, pageSize = BUILD_PAGE_SIZE }) {
  const lease = await claimForProcessing({ db: io.db, taskId, owner, now });
  if (!lease) return stepResult("noop", taskId, "not_claimable");
  const scope = lease.scope;
  const build = await io.db.prepare(
    `SELECT build_id, base_revision, target_event_seq, stage, staging_generation, continuation_json
     FROM rds2_projection_builds
     WHERE user_id = ? AND namespace = ? AND projection_name = ?
       AND stage IN ('scanning', 'activating')`
  ).bind(scope.userId, scope.namespace, scope.projectionName).first();
  if (!build) return stepResult("noop", taskId, "no_running_build");
  const head = await loadProjectionHead(io.db, scope);
  if (head.revision !== Number(build.base_revision)) {
    // The head moved under the build: the build is obsolete and must be
    // restarted rather than activated on top of a foreign base.
    await deferTask({ db: io.db, lease, now, availableAt: now });
    return stepResult("retry", taskId, "build_base_moved");
  }
  const targetEventSeq = Number(build.target_event_seq);
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

  const events = [];
  let nextAfterPage = continuation.nextEventSeq;
  if (continuation.nextEventSeq <= targetEventSeq) {
    const page = await io.db.prepare(
      `SELECT event_seq, event_id, event_key, event_type, user_id, envelope_json
       FROM rds2_events
       WHERE user_id = ? AND namespace = ? AND projection_name = ? AND event_seq >= ?
       ORDER BY event_seq LIMIT ?`
    ).bind(scope.userId, scope.namespace, scope.projectionName, continuation.nextEventSeq, pageSize).all();
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
    nextAfterPage = events.length
      ? events[events.length - 1].eventSeq + 1
      : continuation.nextEventSeq;
  }
  const done = continuation.nextEventSeq > targetEventSeq || events.length < pageSize;

  const pageResult = reducer.buildPage({
    scope, events, head,
    continuation: { ...continuation, nextAfterPage }
  });

  try {
    if (!done) {
      // Mid-build page: stage rows, save the continuation, schedule the next
      // page and complete this task — all atomic, cursor untouched.
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
        ).bind(canonicalJson(pageResult.continuation), now, build.build_id),
        io.db.prepare(
          `INSERT INTO rds2_tasks (task_id, type, user_id, namespace, projection_name, event_seq, artifact_id,
             state, available_at, created_at, updated_at)
           VALUES (?, 'projection_build', ?, ?, ?, NULL, NULL, 'pending', ?, ?, ?)
           ON CONFLICT (task_id) DO NOTHING`
        ).bind(nextTaskId, scope.userId, scope.namespace, scope.projectionName, now, now, now),
        io.db.prepare(
          `UPDATE rds2_tasks SET state = 'completed', lease_owner = NULL, lease_until = NULL, updated_at = ?
           WHERE task_id = ? AND state = 'processing'
             AND lease_owner = ? AND lease_epoch = ? AND lease_until > ?`
        ).bind(now, lease.taskId, lease.owner, lease.epoch, now),
        io.db.prepare("DELETE FROM rds2_commit_guards WHERE guard_id = ?").bind(guardId)
      ];
      await io.db.batch(statements);
      return stepResult("continued", taskId, "build_page_staged");
    }

    // Final page: the activation switches the generation atomically.
    await commitActivation({
      io, lease, build, baseRevision: head.revision,
      changes: {
        rowChanges: pageResult.rowChanges,
        summary: pageResult.summary ?? head.summary,
        eventSeq: targetEventSeq
      },
      now
    });
    return stepResult("completed", taskId, "build_activated");
  } catch {
    const deferred = await deferTask({ db: io.db, lease, now, availableAt: now });
    if (!deferred.rowsWritten) {
      return stepResult("completed", taskId, "build_activated");
    }
    return stepResult("retry", taskId, "deferred_commit_failed");
  }
}

export { hashText };
