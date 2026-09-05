// RDS V2 test support: a Node SQLite stand-in for the D1 binding plus a
// withD1 helper that runs the SAME assertions against both the simulator and
// a real Miniflare/workerd D1 binding. SQLite simulation never replaces the
// real binding run (Rev 6 global constraints); every D1 task executes both.
// This module holds no business logic.
import { DatabaseSync } from "node:sqlite";
import { Miniflare } from "miniflare";

// Miniflare version is pinned exactly in the root package.json
// (miniflare 4.20260730.0 / workerd 1.20260730.1 at the time of writing).
export const MINIFLARE_VERSION = "4.20260730.0";

export function createSqliteD1({ path = ":memory:" } = {}) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  // Connection-level write counters, read AFTER a statement executed, mirror
  // real D1 metadata for RETURNING statements (changes = actual writes,
  // last_row_id = connection state) without inferring them from row counts.
  const connectionState = db.prepare("SELECT changes() AS c, last_insert_rowid() AS r");
  const state = () => connectionState.get();
  const makeStatement = (sql) => {
    const stmt = db.prepare(sql);
    // node:sqlite rows use a null prototype; D1 returns plain objects, so
    // rows are normalized here to keep both bindings' results comparable.
    const plain = (row) => (row === null || typeof row !== "object" ? row : { ...row });
    const rowsFor = (...params) => stmt.all(...params).map(plain);
    // Result-set statements (SELECT or RETURNING) are detected up front so a
    // RETURNING insert can never be reduced to a bare run() that drops rows.
    const returnsRows = stmt.columns().length > 0;
    const hasReturning = /\bRETURNING\b/i.test(sql);
    const isRead = !hasReturning && /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(sql);
    // Real D1 reports changes 0 for plain reads regardless of connection
    // state, and the actual write count for RETURNING statements. rows_read
    // on reads mirrors the rows the statement pulled (an upper bound of the
    // scan cost for point lookups), so scale tests can measure it.
    const metaFor = () => {
      if (isRead) return { changes: 0, last_row_id: Number(state().r), duration: 0 };
      const s = state();
      return { changes: Number(s.c), last_row_id: Number(s.r), duration: 0 };
    };
    const make = (bound) => ({
      bind: (...values) => make(values),
      async first(...args) {
        const rows = rowsFor(...bound);
        const row = rows[0] ?? null;
        if (row === null || args.length === 0) return row;
        return row[args[0]] ?? null;
      },
      async all() {
        const rows = rowsFor(...bound);
        const meta = metaFor();
        return { success: true, meta: { ...meta, rows_read: isRead ? rows.length : 0 }, results: rows };
      },
      async run() {
        if (returnsRows) {
          const rows = rowsFor(...bound);
          const meta = metaFor();
          return { success: true, results: rows, meta: { ...meta, rows_read: rows.length } };
        }
        const result = stmt.run(...bound);
        return {
          success: true,
          results: [],
          meta: { changes: result.changes ?? 0, last_row_id: Number(result.lastInsertRowid ?? 0), duration: 0, rows_read: 0 }
        };
      },
      __isRds2SimulatedStatement: true,
      __execute() {
        return returnsRows ? this.all() : this.run();
      }
    });
    return make([]);
  };
  return {
    __rds2Simulated: true,
    prepare: (sql) => makeStatement(sql),
    exec: (sql) => db.exec(sql),
    // Explicit transaction: a D1 batch is all-or-nothing, so the simulator
    // wraps every batch in BEGIN IMMEDIATE / COMMIT / ROLLBACK. Statements
    // execute sequentially; a rejection rolls the whole batch back.
    async batch(statements) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const out = [];
        for (const statement of statements) {
          out.push(await statement.__execute());
        }
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => db.close()
  };
}

// Splits a migration script into top-level statements. Trigger bodies contain
// semicolons and nested CASE...END blocks, so a depth counter over
// BEGIN/CASE/END words decides statement boundaries; -- and /* */ comments are
// stripped first because they may legally contain semicolons.
export function splitSqlStatements(sqlText) {
  const statements = [];
  let current = "";
  let depth = 0;
  let inString = false;
  for (let index = 0; index < sqlText.length; index += 1) {
    const char = sqlText[index];
    if (inString) {
      current += char;
      if (char === "'") {
        if (sqlText[index + 1] === "'") { current += "'"; index += 1; }
        else inString = false;
      }
      continue;
    }
    if (char === "-" && sqlText[index + 1] === "-") {
      while (index < sqlText.length && sqlText[index] !== "\n") index += 1;
      current += " ";
      continue;
    }
    if (char === "/" && sqlText[index + 1] === "*") {
      index += 2;
      while (index < sqlText.length && !(sqlText[index] === "*" && sqlText[index + 1] === "/")) index += 1;
      index += 1;
      current += " ";
      continue;
    }
    if (char === "'") { inString = true; current += char; continue; }
    if (/[A-Za-z_]/.test(char)) {
      let word = "";
      let cursor = index;
      while (cursor < sqlText.length && /[A-Za-z_]/.test(sqlText[cursor])) {
        word += sqlText[cursor];
        cursor += 1;
      }
      const upper = word.toUpperCase();
      if (upper === "BEGIN" || upper === "CASE") depth += 1;
      else if (upper === "END") depth -= 1;
      current += word;
      index = cursor - 1;
      continue;
    }
    if (char === ";" && depth <= 0) {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = "";
      continue;
    }
    current += char;
  }
  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

// Applies a migration script: the simulator executes it natively; a real D1
// binding receives each split statement in one transactional batch.
export async function applySchema(db, sqlText) {
  if (db.__rds2Simulated) {
    db.exec(sqlText);
    return;
  }
  const statements = splitSqlStatements(sqlText);
  if (!statements.length) return;
  await db.batch(statements.map((sql) => db.prepare(sql)));
}

export async function createMiniflareD1() {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null, { status: 204 }); } };",
    d1Databases: ["DB"]
  });
  const db = await mf.getD1Database("DB");
  return { mf, db };
}

// Runs `callback(bindingName, db)` first against the Node SQLite simulator and
// then against a real Miniflare/workerd D1 binding, closing each in finally.
// A failure on either binding fails the test.
export async function withD1(callback) {
  const sqlite = createSqliteD1();
  try {
    await callback("sqlite", sqlite);
  } finally {
    sqlite.close();
  }
  const { mf, db } = await createMiniflareD1();
  try {
    await callback("miniflare", db);
  } finally {
    await mf.dispose();
  }
}
