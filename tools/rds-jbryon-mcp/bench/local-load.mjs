#!/usr/bin/env node
// J28 local load bench: accepts and projectAll over a throwaway node:sqlite
// database. No network, no Cloudflare credentials, no real RDS and no user
// data: the database lives in an OS temp directory and is deleted afterwards.
//
// The bench reports the measurements the acceptance case requires: request
// counts, success/conflict/failure, p50/p95/max latency, the maximum number of
// row changes in one atomic commit ("page"), the maximum continuation/cursor
// byte size, and the final database size. It does not claim production
// throughput: this is one local SQLite file and one in-process sender.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createRdsStore, initWorkspace } from "../../../services/rds-jbryon/src/store.js";

export const EPOCH = "0123456789abcdef0123456789abcdef";
export const PAGE_BUDGET = 20;
export const CONTINUATION_BUDGET_BYTES = 64 * 1024;

const PROTOCOL = "rds-jbryon";
const API_VERSION = 1;
const MIGRATION_PATH = new URL(
  "../../../services/rds-jbryon/migrations/0001_rds_jbryon.sql",
  import.meta.url
);

// --------------------------------------------------------------- D1 stand-in

/**
 * Minimal D1-compatible adapter over node:sqlite. It deliberately mirrors the
 * small surface createRdsStore uses (prepare/bind/first/all/run/batch/exec) and
 * records the total number of row changes in every batch, which is the bench's
 * "rowChanges per page" measurement. This is a measurement harness, not a
 * production D1 implementation.
 */
function createBenchDatabase(path, metrics) {
  const sqlite = new DatabaseSync(path);
  sqlite.exec("PRAGMA busy_timeout = 5000;");
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const connectionState = sqlite.prepare("SELECT changes() AS c, last_insert_rowid() AS r");
  const state = () => connectionState.get();
  const plain = (row) => (row === null || typeof row !== "object" ? row : { ...row });

  const makeStatement = (sql, bound = []) => {
    const statement = sqlite.prepare(sql);
    const hasReturning = /\bRETURNING\b/i.test(sql);
    const isRead = !hasReturning && /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(sql);
    const returnsRows = statement.columns().length > 0;
    const rowsFor = () => statement.all(...bound).map(plain);
    const metaFor = () => {
      if (isRead) return { changes: 0, last_row_id: Number(state().r) };
      const current = state();
      return { changes: Number(current.c), last_row_id: Number(current.r) };
    };
    const api = {
      bind: (...values) => makeStatement(sql, values),
      async first(...args) {
        const rows = rowsFor();
        const row = rows[0] ?? null;
        if (row === null || args.length === 0) return row;
        return row[args[0]] ?? null;
      },
      async get(...args) {
        return api.first(...args);
      },
      async all() {
        const rows = rowsFor();
        const meta = metaFor();
        return {
          success: true,
          results: rows,
          meta: { ...meta, rows_read: isRead ? rows.length : 0, duration: 0 }
        };
      },
      async run() {
        if (returnsRows) {
          const rows = rowsFor();
          const meta = metaFor();
          return {
            success: true,
            results: rows,
            meta: { ...meta, rows_read: rows.length, duration: 0 }
          };
        }
        const result = statement.run(...bound);
        return {
          success: true,
          results: [],
          meta: {
            changes: Number(result.changes ?? 0),
            last_row_id: Number(result.lastInsertRowid ?? 0),
            rows_read: 0,
            duration: 0
          }
        };
      },
      __execute() {
        return returnsRows ? api.all() : api.run();
      }
    };
    return api;
  };

  let batchChain = Promise.resolve();
  return {
    prepare: (sql) => makeStatement(sql),
    exec: (sql) => sqlite.exec(sql),
    // D1 batch = one atomic page. All statements commit or none do.
    batch(statements) {
      const execute = async () => {
        sqlite.exec("BEGIN IMMEDIATE");
        const results = [];
        let rowChanges = 0;
        try {
          for (const statement of statements) {
            const result = await statement.__execute();
            results.push(result);
            rowChanges += Number(result?.meta?.changes ?? 0);
          }
          sqlite.exec("COMMIT");
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
        metrics.pages.push(rowChanges);
        return results;
      };
      const result = batchChain.then(execute, execute);
      batchChain = result.then(() => {}, () => {});
      return result;
    },
    close: () => sqlite.close()
  };
}

// ------------------------------------------------------------------- helpers

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index];
}

function summarise(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50: Number(percentile(sorted, 0.5).toFixed(3)),
    p95: Number(percentile(sorted, 0.95).toFixed(3)),
    max: Number((sorted.at(-1) ?? 0).toFixed(3))
  };
}

const requestId = (prefix, index) => `${prefix}-${String(index).padStart(8, "0")}`;
const byteLength = (value) => Buffer.byteLength(String(value), "utf8");
const ensure = (condition, message) => {
  if (!condition) throw new Error(`local_load_invariant:${message}`);
};

async function drain(store, owner) {
  const results = [];
  for (let round = 0; round < 100; round += 1) {
    const run = await store.projectAll({ owner, maxTasks: 1000 });
    results.push(...run.results);
    if (run.processed === 0) break;
  }
  return results;
}

// ------------------------------------------------------------------- workload

/**
 * Runs the local workload and returns a JSON-serialisable report.
 *
 * @param {object} options
 * @param {number} options.requests  accepted patch requests (default 200)
 * @param {number} options.projects  independent project directories (default 8)
 * @param {number} options.batchSize accepts between projectAll passes (default 10)
 */
export async function runLocalLoad({ requests = 200, projects = 8, batchSize = 10, concurrency = 1 } = {}) {
  if (!Number.isInteger(requests) || requests < 1) throw new Error("invalid_requests");
  if (!Number.isInteger(projects) || projects < 1) throw new Error("invalid_projects");
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("invalid_batch_size");
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("invalid_concurrency");
  const size = Math.min(batchSize, requests);
  const acceptParallelism = Math.min(size, concurrency);
  const pageBudget = PAGE_BUDGET;
  const continuationBudget = CONTINUATION_BUDGET_BYTES;
  const directory = mkdtempSync(join(tmpdir(), "rds-jbryon-load-"));
  const databasePath = join(directory, "local-load.sqlite");
  const migration = readFileSync(MIGRATION_PATH, "utf8");
  const metrics = { pages: [] };
  const owner = "j28-local-load";
  const clock = () => new Date().toISOString();
  const failures = [];
  const acceptLatencies = [];
  const projectLatencies = [];
  const endToEndLatencies = [];
  const acceptedAt = new Map();
  const outcomes = new Map();
  const expectedByProject = Array.from({ length: projects }, () => []);
  let networkCalls = 0;
  let projectAllCalls = 0;
  let accepted = 0;
  let acceptFailures = 0;
  let db = null;
  const originalFetch = globalThis.fetch;

  // A hard local guarantee: any accidental network call fails the bench.
  globalThis.fetch = (...args) => {
    networkCalls += 1;
    throw new Error(`network_disabled_in_local_load:${String(args[0] ?? "")}`);
  };

  try {
    db = createBenchDatabase(databasePath, metrics);
    db.exec(migration);
    await initWorkspace(db, { epoch: EPOCH });
    const store = createRdsStore({ db, epoch: EPOCH, now: clock });

    // Setup: one domain and one snapshot per project, fully projected before
    // measurements start.
    const projectNodes = [];
    const snapshotNodes = [];
    let setupIndex = 0;
    for (let project = 0; project < projects; project += 1) {
      const name = `project-${String(project + 1).padStart(2, "0")}`;
      const domainRequest = {
        protocol: PROTOCOL,
        apiVersion: API_VERSION,
        workspaceEpoch: EPOCH,
        requestId: `req-setup-d-${String(project + 1).padStart(3, "0")}`,
        operation: "directory.create",
        target: { path: [name], kind: "domain" }
      };
      const domainReceipt = await store.accept(domainRequest);
      const domainRun = await drain(store, owner);
      ensure(domainRun.some((result) => result.requestId === domainReceipt.requestId
        && (result.effect === "applied" || result.effect === "applied_noop")), "domain_not_projected");
      const domain = await store.resolvePath([name]);
      projectNodes.push(domain.nodeId);
      setupIndex += 1;

      const snapshotRequest = {
        protocol: PROTOCOL,
        apiVersion: API_VERSION,
        workspaceEpoch: EPOCH,
        requestId: `req-setup-s-${String(project + 1).padStart(3, "0")}`,
        operation: "snapshot.create",
        target: { parentId: domain.nodeId, name: "notes.json", kind: "snapshot" },
        changes: [
          { op: "set", path: ["title"], value: name },
          { op: "set", path: ["counter"], value: 0 }
        ]
      };
      const snapshotReceipt = await store.accept(snapshotRequest);
      const snapshotRun = await drain(store, owner);
      ensure(snapshotRun.some((result) => result.requestId === snapshotReceipt.requestId
        && (result.effect === "applied" || result.effect === "applied_noop")), "snapshot_not_projected");
      const snapshot = await store.resolvePath([name, "notes.json"]);
      snapshotNodes.push(snapshot.nodeId);
      setupIndex += 1;
    }

    // Measurement starts after setup.
    metrics.pages.length = 0;
    const revisions = new Array(projects).fill(1);
    const startedAt = performance.now();

    for (let batchStart = 0; batchStart < requests; batchStart += size) {
      const batch = Array.from({ length: Math.min(size, requests - batchStart) }, (_, offset) => batchStart + offset);
      let nextIndex = 0;
      await Promise.all(Array.from({ length: Math.min(acceptParallelism, batch.length) }, async () => {
        while (nextIndex < batch.length) {
          const index = batch[nextIndex++];
          const project = index % projects;
          const id = requestId("req-load", index + 1);
          const field = `field-${index}`;
          const request = {
            protocol: PROTOCOL,
            apiVersion: API_VERSION,
            workspaceEpoch: EPOCH,
            requestId: id,
            operation: "snapshot.patch",
            target: { nodeId: snapshotNodes[project] },
            baseRevision: revisions[project],
            changes: [{ op: "set", path: [field], value: index }]
          };
          const acceptStarted = performance.now();
          try {
            await store.accept(request);
            acceptLatencies.push(performance.now() - acceptStarted);
            accepted += 1;
            acceptedAt.set(id, performance.now());
            outcomes.set(id, "pending");
            expectedByProject[project].push([field, index]);
          } catch (error) {
            acceptLatencies.push(performance.now() - acceptStarted);
            acceptFailures += 1;
            failures.push({
              phase: "accept", requestId: id, code: error?.code ?? String(error?.message ?? error)
            });
          }
        }
      }));

      const projectStarted = performance.now();
      try {
        const run = await store.projectAll({ owner, maxTasks: requests + projects + 1 });
        projectAllCalls += 1;
        projectLatencies.push(performance.now() - projectStarted);
        for (const result of run.results) {
          const effect = result.effect ?? (result.ok ? "applied" : "failed");
          outcomes.set(result.requestId, effect);
          if (acceptedAt.has(result.requestId)) {
            endToEndLatencies.push(performance.now() - acceptedAt.get(result.requestId));
            acceptedAt.delete(result.requestId);
          }
          if (effect !== "applied" && effect !== "applied_noop") {
            failures.push({
              phase: "projection",
              requestId: result.requestId,
              code: result.code ?? result.reason ?? effect
            });
          }
        }
      } catch (error) {
        projectAllCalls += 1;
        projectLatencies.push(performance.now() - projectStarted);
        failures.push({
          phase: "projectAll", code: error?.code ?? String(error?.message ?? error)
        });
      }
      for (let projectIndex = 0; projectIndex < projects; projectIndex += 1) {
        // Reading the projected revision keeps the next baseRevision exact even
        // when several queued patches to one file merge in a batch.
        const snapshot = await store.readSnapshot({ nodeId: snapshotNodes[projectIndex] });
        revisions[projectIndex] = snapshot.revision;
      }
    }

    // Anything still pending after the final projection is a failure, not an
    // implied success.
    for (const id of acceptedAt.keys()) {
      outcomes.set(id, "failed");
    }
    acceptedAt.clear();

    let succeeded = 0;
    let conflicts = 0;
    for (const effect of outcomes.values()) {
      if (effect === "applied" || effect === "applied_noop") succeeded += 1;
      else if (effect === "conflict") conflicts += 1;
    }
    const failed = requests - succeeded - conflicts;
    const elapsedMs = performance.now() - startedAt;
    let projectIsolation = true;
    for (let projectIndex = 0; projectIndex < projects; projectIndex += 1) {
      const snapshot = await store.readSnapshot({ nodeId: snapshotNodes[projectIndex] });
      for (const [field, value] of expectedByProject[projectIndex]) {
        if (snapshot.content[field] !== value) projectIsolation = false;
      }
    }

    // Paged reads after the load exercise real continuation/cursor values. The
    // bench does not claim a deletion page size here; the projection pages are
    // measured above, and the cursor bytes are the persisted continuation size
    // a paged client would receive.
    let continuationPages = 0;
    let continuationMaxBytes = 0;
    let cursor = null;
    do {
      const page = await store.listDirectory({ parentId: null, limit: 1, cursor });
      continuationPages += 1;
      if (page.nextCursor) {
        continuationMaxBytes = Math.max(continuationMaxBytes, byteLength(page.nextCursor));
        cursor = page.nextCursor;
      } else {
        cursor = null;
      }
    } while (cursor);
    for (const nodeId of projectNodes) {
      let after = null;
      do {
        const page = await store.snapshotQuery({ nodeId, limit: 1, cursor: after });
        continuationPages += 1;
        if (page.nextCursor) {
          continuationMaxBytes = Math.max(continuationMaxBytes, byteLength(page.nextCursor));
          after = page.nextCursor;
        } else {
          after = null;
        }
      } while (after);
    }

    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const pageCount = Number((await db.prepare("PRAGMA page_count").get())?.page_count ?? 0);
    const pageSize = Number((await db.prepare("PRAGMA page_size").get())?.page_size ?? 0);
    const sqliteVersion = (await db.prepare("SELECT sqlite_version() AS version").get())?.version ?? null;
    const databaseBytes = statSync(databasePath).size;
    const walBytes = existsSync(`${databasePath}-wal`) ? statSync(`${databasePath}-wal`).size : 0;
    db.close();
    db = null;

    const maxRowChanges = metrics.pages.length ? Math.max(...metrics.pages) : 0;
    const totalRowChanges = metrics.pages.reduce((total, value) => total + value, 0);
    const endToEnd = summarise(endToEndLatencies);
    const report = {
      generatedAt: new Date().toISOString(),
      mode: "local-only",
      node: process.version,
      sqlite: sqliteVersion,
      config: {
        requests,
        projects,
        batchSize: size,
        concurrency: acceptParallelism,
        pageBudget,
        continuationBudgetBytes: continuationBudget
      },
      network: { calls: networkCalls, disabled: true },
      concurrency: { acceptParallelism, projectors: 1 },
      requests: {
        total: requests,
        accepted,
        acceptCalls: requests,
        acceptFailures,
        projectAllCalls,
        succeeded,
        conflicts,
        failed
      },
      latencyMs: {
        p50: endToEnd.p50,
        p95: endToEnd.p95,
        max: endToEnd.max,
        accept: summarise(acceptLatencies),
        projectAll: summarise(projectLatencies),
        endToEnd
      },
      throughputPerSecond: Number((requests / Math.max(elapsedMs / 1000, 0.001)).toFixed(2)),
      pages: {
        count: metrics.pages.length,
        maxRowChanges,
        totalRowChanges
      },
      continuation: {
        maxBytes: continuationMaxBytes,
        pages: continuationPages
      },
      database: {
        name: basename(databasePath),
        bytes: databaseBytes,
        walBytes,
        pageCount,
        pageSize
      },
      checks: {
        noFailures: failed === 0 && conflicts === 0 && acceptFailures === 0,
        maxRowChangesWithinPageBudget: maxRowChanges <= pageBudget,
        continuationWithinBudget: continuationMaxBytes <= continuationBudget,
        databaseNonEmpty: databaseBytes > 0,
        projectIsolation,
        requestsAccountedFor: succeeded + conflicts + failed === requests
      },
      failures: failures.slice(0, 20),
      setupRequests: setupIndex
    };
    return report;
  } finally {
    if (db) {
      try { db.close(); } catch { /* best-effort close before cleanup */ }
    }
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

// ----------------------------------------------------------------------- CLI

function parseArgs(argv) {
  const config = { requests: 200, projects: 8, batchSize: 10, out: null };
  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") return { help: true, ...config };
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (!match) throw new Error(`unknown_argument:${argument}`);
    const [, key, value] = match;
    if (key === "requests") config.requests = Number(value);
    else if (key === "projects") config.projects = Number(value);
    else if (key === "batch") config.batchSize = Number(value);
    else if (key === "out") config.out = value;
    else throw new Error(`unknown_argument:${argument}`);
  }
  return config;
}

const usage = [
  "Usage: node tools/rds-jbryon-mcp/bench/local-load.mjs [options]",
  "",
  "  --requests=N   accepted patch requests (default 200)",
  "  --projects=N   independent project directories (default 8)",
  "  --batch=N      accepts between projectAll passes (default 10)",
  "  --out=PATH     also write the JSON report to PATH",
  "",
  "Local only: node:sqlite temp database, no network, no RDS credentials."
].join("\n");

async function main() {
  let config;
  try {
    config = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage}\n`);
    process.exitCode = 2;
    return;
  }
  if (config.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  const report = await runLocalLoad(config);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (config.out) {
    const target = resolve(config.out);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, json, "utf8");
    process.stdout.write(`${JSON.stringify({
      out: target,
      requests: report.requests.total,
      succeeded: report.requests.succeeded,
      conflicts: report.requests.conflicts,
      failed: report.requests.failed,
      p50: report.latencyMs.p50,
      p95: report.latencyMs.p95,
      max: report.latencyMs.max,
      maxRowChanges: report.pages.maxRowChanges,
      continuationBytes: report.continuation.maxBytes,
      databaseBytes: report.database.bytes
    })}\n`);
  } else {
    process.stdout.write(json);
  }
  if (!Object.values(report.checks).every(Boolean)) process.exitCode = 1;
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (entryUrl && entryUrl === import.meta.url) {
  await main();
}
