// J28 local load test: a small run of the bench proves the workload is bounded
// and failure-free without turning the unit suite into a multi-minute job.
import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { runLocalLoad } from "../bench/local-load.mjs";

const REQUESTS = 40;
const PROJECTS = 4;
const BATCH = 5;

test("J28 local load: no failures, bounded pages and continuation", async () => {
  const started = performance.now();
  const report = await runLocalLoad({ requests: REQUESTS, projects: PROJECTS, batchSize: BATCH });
  const elapsed = performance.now() - started;

  assert.equal(report.mode, "local-only");
  assert.equal(report.network.calls, 0);
  assert.equal(report.requests.total, REQUESTS);
  assert.equal(report.requests.accepted, REQUESTS);
  assert.equal(report.requests.succeeded, REQUESTS);
  assert.equal(report.requests.conflicts, 0);
  assert.equal(report.requests.failed, 0);
  assert.equal(report.requests.acceptFailures, 0);
  assert.equal(report.failures.length, 0);
  assert.equal(report.checks.noFailures, true);
  assert.equal(report.checks.requestsAccountedFor, true);

  assert.ok(report.pages.count > 0, "at least one atomic page must run");
  assert.ok(report.pages.maxRowChanges > 0, "a page must change rows");
  assert.ok(
    report.pages.maxRowChanges <= 20,
    `page changes must stay bounded (got ${report.pages.maxRowChanges})`
  );
  assert.ok(
    report.continuation.maxBytes <= 64 * 1024,
    `continuation must stay under 64 KiB (got ${report.continuation.maxBytes})`
  );
  assert.ok(report.database.bytes > 0, "the temp database must be written");
  assert.ok(report.database.walBytes >= 0);
  assert.equal(report.checks.maxRowChangesWithinPageBudget, true);
  assert.equal(report.checks.continuationWithinBudget, true);

  assert.ok(Number.isFinite(report.latencyMs.p50), "p50 must be a number");
  assert.ok(Number.isFinite(report.latencyMs.p95), "p95 must be a number");
  assert.ok(report.latencyMs.max >= report.latencyMs.p95);
  assert.ok(elapsed < 60_000, `local load test took ${Math.round(elapsed)}ms, expected < 60s`);
});

test("J28 local concurrent acceptance keeps each project's writes isolated", async () => {
  const report = await runLocalLoad({ requests: 40, projects: 4, batchSize: 5, concurrency: 5 });
  assert.equal(report.concurrency.acceptParallelism, 5);
  assert.equal(report.concurrency.projectors, 1);
  assert.equal(report.requests.accepted, 40);
  assert.equal(report.requests.succeeded, 40);
  assert.equal(report.requests.conflicts, 0);
  assert.equal(report.requests.failed, 0);
  assert.equal(report.checks.projectIsolation, true);
  assert.equal(report.network.calls, 0);
});
