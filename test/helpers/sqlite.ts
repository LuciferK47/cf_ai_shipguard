import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Db, SqlValue } from "../../src/server/memory/db";

/** A real SQLite database (Node's built-in) behind the memory layer's `Db` interface. */
export function createTestDb(): Db {
  const db = new DatabaseSync(":memory:");
  let depth = 0;

  const sql = ((strings: TemplateStringsArray, ...values: SqlValue[]) => {
    const text = strings.reduce(
      (acc, s, i) => acc + s + (i < values.length ? "?" : ""),
      ""
    );
    const bound = values.map(
      (v): SQLInputValue => (typeof v === "boolean" ? (v ? 1 : 0) : v)
    );
    return db.prepare(text).all(...bound);
  }) as Db["sql"];

  return {
    sql,
    transaction<T>(fn: () => T): T {
      if (depth > 0) return fn();
      depth++;
      db.exec("BEGIN");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      } finally {
        depth--;
      }
    }
  };
}
