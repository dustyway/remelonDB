/**
 * The portability seam (see docs/architecture-layers.md).
 *
 * A driver is a dumb SQL executor: it knows nothing about queries, records,
 * schemas, tombstones, or sync. Everything above this interface is written
 * once in the core and is identical on every platform.
 *
 * The seam is Promise-shaped because the web driver lives in a Worker (OPFS
 * sync-access handles are worker-only) and the main thread can only reach it
 * asynchronously. Drivers on other platforms may resolve synchronously under
 * the hood; core must never depend on same-tick resolution for correctness.
 */

/** The entire value vocabulary that crosses the seam, in either direction. */
export type SqlValue = string | number | boolean | null

export type SqlArgs = SqlValue[]

/**
 * One result row, keyed by column name. SQLite has no boolean storage class,
 * so values read back are never `boolean` — columns written as booleans come
 * back as 0/1. Interpreting them is the core's job (it knows the schema).
 */
export type Row = Record<string, SqlValue>

/**
 * One entry of an atomic batch: an SQL statement plus the argument sets to
 * run it with. Grouping arg sets under one statement lets drivers prepare
 * once and run many times.
 */
export type BatchStatement = readonly [sql: string, argSets: readonly SqlArgs[]]

export interface SqliteDriver {
  /**
   * Open the database (creating it if needed) and return the current
   * `PRAGMA user_version`. Core uses the version to decide fresh setup vs
   * migration vs ready — the driver only reports it.
   */
  open(name: string): Promise<{ userVersion: number }>

  close(): Promise<void>

  /** Run a SELECT and return all result rows. */
  query(sql: string, args: SqlArgs): Promise<Row[]>

  /** Run a single non-SELECT statement (DDL during setup, PRAGMAs). */
  execute(sql: string, args: SqlArgs): Promise<void>

  /**
   * Run all statements in one transaction: all commit or none do. This is
   * the sole mutation path for records, tombstones, and local storage.
   */
  executeBatch(statements: readonly BatchStatement[]): Promise<void>

  setUserVersion(version: number): Promise<void>

  /** Delete the database and its sidecar files. Used by database reset. */
  destroy(): Promise<void>
}
