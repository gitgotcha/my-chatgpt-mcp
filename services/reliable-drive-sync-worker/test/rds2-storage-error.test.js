// G2-F2: the storage error translation layer. Marker shapes are pinned to the
// strings measured on BOTH bindings (plan §3.1.2); no test here depends on
// trigger execution order.
import test from "node:test";
import assert from "node:assert/strict";
import { extractStorageMarker, classifyStorageError } from "../src/rds2/errors/storage-error.js";

// Shapes copied verbatim from the dual-binding probe.
const SQLITE_TRIGGER = (marker) => ({
  name: "Error",
  message: marker,
  code: "ERR_SQLITE_ERROR",
  errcode: 1811,
  errstr: "constraint failed"
});

const D1_TRIGGER = (marker) => ({
  name: "Error",
  message: `D1_ERROR: ${marker}: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)`,
  code: null,
  cause: {
    name: "Error",
    message: `${marker}: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)`,
    code: null
  }
});

const SQLITE_CHECK = (column) => ({
  name: "Error",
  message: `CHECK constraint failed: ${column} IS NULL OR (json_valid(${column}) AND length(CAST(${column} AS BLOB)) <= 65536)`,
  code: "ERR_SQLITE_ERROR",
  errcode: 275,
  errstr: "constraint failed"
});

const D1_CHECK = (column) => ({
  name: "Error",
  message: `D1_ERROR: CHECK constraint failed: ${column} IS NULL OR (json_valid(${column}) AND length(CAST(${column} AS BLOB)) <= 65536): SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)`,
  code: null,
  cause: {
    name: "Error",
    message: `CHECK constraint failed: ${column} IS NULL OR (json_valid(${column}) AND length(CAST(${column} AS BLOB)) <= 65536): SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)`,
    code: null
  }
});

const SQLITE_GENERIC = {
  name: "Error",
  message: "no such table: rds2_no_such_table",
  code: "ERR_SQLITE_ERROR",
  errcode: 1,
  errstr: "SQL logic error"
};

const D1_GENERIC = {
  name: "Error",
  message: "D1_ERROR: no such table: rds2_no_such_table: SQLITE_ERROR",
  code: null,
  cause: { name: "Error", message: "no such table: rds2_no_such_table: SQLITE_ERROR", code: null }
};

// ---------------------------------------------------------------- markers

test("F2 the same marker is extracted from both bindings' shapes", async (t) => {
  for (const marker of [
    "stale_task_write",
    "stale_projection_revision",
    "guard_requires_expected_revision",
    "cursor_regression",
    "build_requires_building_flag"
  ]) {
    await t.test(marker, () => {
      assert.equal(extractStorageMarker(SQLITE_TRIGGER(marker)).marker, marker);
      assert.equal(extractStorageMarker(D1_TRIGGER(marker)).marker, marker);
      assert.equal(extractStorageMarker(SQLITE_TRIGGER(marker)).kind, "trigger");
      assert.equal(extractStorageMarker(D1_TRIGGER(marker)).kind, "trigger");
    });
  }
});

test("F2 a size CHECK yields kind check and the constrained column", () => {
  for (const make of [SQLITE_CHECK, D1_CHECK]) {
    const found = extractStorageMarker(make("continuation_json"));
    assert.equal(found.kind, "check");
    assert.equal(found.column, "continuation_json");
    assert.equal(found.marker, null);
  }
});

test("F2 an unrecognised storage error yields kind none", () => {
  assert.equal(extractStorageMarker(SQLITE_GENERIC).kind, "none");
  assert.equal(extractStorageMarker(D1_GENERIC).kind, "none");
  assert.equal(extractStorageMarker(null).kind, "none");
  assert.equal(extractStorageMarker(undefined).kind, "none");
  assert.equal(extractStorageMarker(new Error("")).kind, "none");
});

test("F2 a marker inside a longer message is still found", () => {
  const wrapped = {
    message: `D1_ERROR: prefix stale_task_write suffix: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)`
  };
  assert.equal(extractStorageMarker(wrapped).marker, "stale_task_write");
});

test("F2 a table name that merely resembles a marker is not a marker", () => {
  const decoy = { message: "no such table: rds2_cursor_regression_audit" };
  assert.equal(extractStorageMarker(decoy).kind, "none");
});

// ------------------------------------------------------------ classification

test("F2 lease and CAS conflicts are class B and never claim success", () => {
  for (const marker of ["stale_task_write", "stale_projection_revision"]) {
    for (const make of [SQLITE_TRIGGER, D1_TRIGGER]) {
      const result = classifyStorageError({ error: make(marker) });
      assert.equal(result.class, "B");
      assert.equal(result.code, "lease_conflict");
      assert.equal(result.marker, marker);
    }
  }
});

test("F2 a missing required contract field is class D, not a normal race", () => {
  for (const make of [SQLITE_TRIGGER, D1_TRIGGER]) {
    const result = classifyStorageError({ error: make("guard_requires_expected_revision") });
    assert.equal(result.class, "D");
    assert.equal(result.code, "missing_expected_revision");
  }
});

test("F2 a cursor regression is class D and must not be deferred forever", () => {
  for (const make of [SQLITE_TRIGGER, D1_TRIGGER]) {
    const result = classifyStorageError({ error: make("cursor_regression") });
    assert.equal(result.class, "D");
    assert.equal(result.code, "cursor_regression");
  }
});

test("F2 build_requires_building_flag follows the build-start CAS, never unconditionally B", () => {
  for (const make of [SQLITE_TRIGGER, D1_TRIGGER]) {
    const raced = classifyStorageError({
      error: make("build_requires_building_flag"),
      context: { buildStartCasFailed: true }
    });
    assert.equal(raced.class, "B");
    assert.equal(raced.code, "build_start_race");

    const broken = classifyStorageError({
      error: make("build_requires_building_flag"),
      context: { buildStartCasFailed: false }
    });
    assert.equal(broken.class, "D");
    assert.equal(broken.code, "build_requires_building_flag");
  }
});

test("F2 a size CHECK is a deterministic constraint error, never retried forever", () => {
  for (const make of [SQLITE_CHECK, D1_CHECK]) {
    const result = classifyStorageError({ error: make("continuation_json") });
    assert.equal(result.class, "D");
    assert.equal(result.code, "storage_check_violation");
    assert.equal(result.column, "continuation_json");
  }
});

test("F2 an unrecognised storage error falls through to bounded retry (class C)", () => {
  for (const error of [SQLITE_GENERIC, D1_GENERIC, null, undefined]) {
    const result = classifyStorageError({ error });
    assert.equal(result.class, "C");
    assert.equal(result.code, "storage_error");
  }
});

test("F2-R1 internal deterministic codes are class D, never a blind retry", () => {
  // These codes are thrown by our OWN modules (staging-read.js, builds.js,
  // commit.js, invocation-io.js): they are closed-set, deterministic contract
  // or size errors. The 2026-09-07 implementation review reproduced all three
  // named codes falling through to C/storage_error — that hid them behind
  // endless retries instead of parking.
  for (const code of [
    "build_state_too_large",
    "build_read_limit_exceeded",
    "build_read_kind_rejected",
    "build_read_key_invalid",
    // Review P1-3: a malformed read plan is a deterministic caller bug.
    // Pinned here so dropping it from the whitelist cannot silently degrade
    // it to the class-C fallback (blind retry).
    "build_read_plan_invalid",
    "build_continuation_invalid",
    "invalid_page_size",
    "changes_too_large",
    "commit_batch_too_large",
    "unsupported_algorithm_event"
  ]) {
    const result = classifyStorageError({ error: { message: code, code } });
    assert.equal(result.class, "D", `${code} must be deterministic`);
    assert.equal(result.code, code, `${code} must keep its specific code`);
    assert.equal(result.marker, null);
    assert.equal(result.column, null);
  }
});

test("F2-R1 budget_exhausted keeps the approved A semantics (no parking)", () => {
  // The approved plan's three-way split: entering a stage without room is a
  // normal wait (A); only a close-out without booking room is E. Parking on
  // budget exhaustion would be "park everything" again.
  const result = classifyStorageError({ error: { message: "budget_exhausted", code: "budget_exhausted" } });
  assert.equal(result.class, "A");
  assert.equal(result.code, "budget_exhausted");
});

test("F2-R1 an internal code wins over decoy text and is not confused with driver codes", () => {
  // The internal code is the trusted closed-set signal: raw text around it
  // (which may legitimately quote table or guard names) must not override it.
  const decoy = classifyStorageError({
    error: { message: "invalid_page_size near stale_task_write", code: "invalid_page_size" }
  });
  assert.equal(decoy.class, "D");
  assert.equal(decoy.code, "invalid_page_size");

  // A driver-level code (ERR_SQLITE_ERROR) is NOT an internal code: it must
  // still go through text extraction.
  const driver = classifyStorageError({ error: SQLITE_TRIGGER("stale_task_write") });
  assert.equal(driver.class, "B");
  assert.equal(driver.code, "lease_conflict");
});

// ------------------------------------------------------------------ hygiene

test("F2 the classification result carries no raw message, SQL or parameters", () => {
  const results = [
    classifyStorageError({ error: SQLITE_GENERIC }),
    classifyStorageError({ error: D1_GENERIC }),
    classifyStorageError({ error: SQLITE_CHECK("continuation_json") }),
    classifyStorageError({ error: D1_CHECK("continuation_json") }),
    classifyStorageError({ error: D1_TRIGGER("stale_task_write") })
  ];
  for (const result of results) {
    const text = JSON.stringify(result);
    assert.ok(!text.includes("no such table"), `leaked table text: ${text}`);
    assert.ok(!text.includes("rds2_no_such_table"), `leaked table name: ${text}`);
    assert.ok(!text.includes("json_valid"), `leaked CHECK expression: ${text}`);
    assert.ok(!text.includes("SQLITE_"), `leaked driver text: ${text}`);
    assert.ok(!text.includes("D1_ERROR"), `leaked driver prefix: ${text}`);
  }
});

test("F2 the result exposes only closed-set fields", () => {
  const result = classifyStorageError({ error: SQLITE_TRIGGER("stale_task_write") });
  for (const key of Object.keys(result)) {
    assert.ok(["class", "code", "marker", "column"].includes(key), `unexpected field ${key}`);
  }
});
