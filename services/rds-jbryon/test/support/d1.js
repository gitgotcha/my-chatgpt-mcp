import { DatabaseSync } from "node:sqlite";
import { Miniflare } from "miniflare";

function sqliteD1() {
  const sqlite = new DatabaseSync(":memory:");
  const db = {
    isNodeSqliteSimulator: true,
    exec(sql) { sqlite.exec(sql); },
    prepare(sql) {
      let values = [];
      return {
        sql,
        get values() { return values; },
        bind(...args) { values = args; return this; },
        async run() {
          const result = sqlite.prepare(sql).run(...values);
          return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid ?? 0) } };
        },
        async first(column) {
          const row = sqlite.prepare(sql).get(...values) ?? null;
          return typeof column === "string" && row ? row[column] : row;
        },
        async all() {
          return { success: true, results: sqlite.prepare(sql).all(...values) };
        }
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) {
          const result = sqlite.prepare(statement.sql).run(...(statement.values ?? []));
          results.push({ success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid ?? 0) } });
        }
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    close() { sqlite.close(); }
  };
  return db;
}

export async function applySchema(db, sql) {
  const body = sql.replace(/^\s*--.*$/gm, "");
  if (db.isNodeSqliteSimulator) return db.exec(body);
  const triggers = body.match(/CREATE\s+TRIGGER\b[\s\S]*?\bEND\s*;/gi) ?? [];
  const withoutTriggers = body.replace(/CREATE\s+TRIGGER\b[\s\S]*?\bEND\s*;/gi, "");
  const statements = [
    ...withoutTriggers.split(";"),
    ...triggers
  ].map((part) => part.trim()).filter(Boolean);
  for (const statement of statements) {
    await db.prepare(statement).run();
  }
}

export async function withD1(callback) {
  const sqlite = sqliteD1();
  try {
    await callback("node:sqlite", sqlite);
  } finally {
    sqlite.close();
  }

  const miniflare = new Miniflare({
    modules: true,
    script: "export default { async fetch() { return new Response('ok'); } }",
    d1Databases: ["DB"]
  });
  try {
    const db = await miniflare.getD1Database("DB");
    await callback("miniflare-d1", db);
  } finally {
    await miniflare.dispose();
  }
}
