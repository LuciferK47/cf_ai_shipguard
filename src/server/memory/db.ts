export type SqlValue = string | number | boolean | null;

/** A tagged-template SQL runner. The agent's `this.sql` satisfies this. */
export interface SqlRunner {
  <T = Record<string, SqlValue>>(
    strings: TemplateStringsArray,
    ...values: SqlValue[]
  ): T[];
}

/**
 * The narrow database surface the memory layer needs. In production it is
 * backed by the Agent's SQLite (`this.sql`, `ctx.storage.transactionSync`);
 * in tests by Node's built-in SQLite, so the real SQL is exercised.
 */
export interface Db {
  sql: SqlRunner;
  transaction<T>(fn: () => T): T;
}
