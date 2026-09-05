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
  const makeStatement = (sql) => {
    const stmt = db.prepare(sql);
    // node:sqlite rows use a null prototype; D1 returns plain objects, so
    // rows are normalized here to keep both bindings' results comparable.
    const plain = (row) => (row === null || typeof row !== "object" ? row : { ...row });
    const rowsFor = (...params) => stmt.all(...params).map(plain);
    // Result-set statements (SELECT or RETURNING) are detected up front so a
    // RETURNING insert can never be reduced to a bare run() that drops rows.
    const returnsRows = stmt.columns().length > 0;
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
        return { success: true, meta: { changes: 0, last_row_id: 0, duration: 0 }, results: rows };
      },
      async run() {
        const result = returnsRows
          ? { changes: rowsFor(...bound).length, lastInsertRowid: 0 }
          : stmt.run(...bound);
        return {
          success: true,
          results: [],
          meta: { changes: result.changes ?? 0, last_row_id: Number(result.lastInsertRowid ?? 0), duration: 0 }
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
    prepare: (sql) => makeStatement(sql),
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
