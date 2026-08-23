/**
 * The portability seam (see docs/layers.md).
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
export type SqlValue = string | number | boolean | null;

export type SqlArgs = readonly SqlValue[];

/**
 * One result row, keyed by column name. SQLite has no boolean storage class,
 * so values read back are never `boolean` — columns written as booleans come
 * back as 0/1. Interpreting them is the core's job (it knows the schema).
 */
export type Row = Record<string, SqlValue>;

/**
 * One entry of an atomic batch: an SQL statement plus the argument sets to
 * run it with. Grouping arg sets under one statement lets drivers prepare
 * once and run many times.
 */
export type BatchStatement = readonly [
  sql: string,
  argSets: readonly SqlArgs[],
];

export interface SqliteDriver {
  /**
   * Open the database (creating it if needed) and return the current
   * `PRAGMA user_version`. Core uses the version to decide fresh setup vs
   * migration vs ready — the driver only reports it.
   */
  open(name: string): Promise<{ userVersion: number }>;

  close(): Promise<void>;

  /** Run a SELECT and return all result rows. */
  query(sql: string, args: SqlArgs): Promise<Row[]>;

  /** Run a single non-SELECT statement (DDL during setup, PRAGMAs). */
  execute(sql: string, args: SqlArgs): Promise<void>;

  /**
   * Run all statements in one transaction: all commit or none do. This is
   * the sole mutation path for records, tombstones, and local storage.
   */
  executeBatch(statements: readonly BatchStatement[]): Promise<void>;

  setUserVersion(version: number): Promise<void>;

  /** Delete the database and its sidecar files. Used by database reset. */
  destroy(): Promise<void>;

  /**
   * Optional cross-context arbitration (docs/multi-tab.md): when the same
   * storage is shared between contexts (browser tabs behind one broker),
   * `database.write` blocks must not interleave with each other or with
   * `database.read` consistency windows from other contexts. A driver that
   * shares storage implements this; the returned function releases the
   * slot. Drivers with exclusive storage omit it — the in-process work
   * queue already serializes locally, and core skips the hook entirely.
   */
  acquireWorkSlot?(exclusive: boolean): Promise<() => Promise<void>>;

  /**
   * Optional change propagation, the sending half (docs/multi-tab.md):
   * core calls this after every committed batch with the batch's change
   * set. A shared-storage driver relays it to the other contexts;
   * best-effort and fire-and-forget — a lost notification means a stale
   * cache elsewhere until the next one, never data loss.
   */
  publishChanges?(changes: ExternalChangeSet): void;

  /**
   * Optional change propagation, the receiving half: the driver invokes
   * `handler` with change sets committed by OTHER contexts. Core feeds
   * them into `database.applyExternalChanges`. At most one handler; a
   * driver that implements one of the propagation members implements both.
   */
  onExternalChanges?(handler: (changes: ExternalChangeSet) => void): void;

  /**
   * Optional sync ownership (docs/multi-tab.md): when storage is shared
   * between contexts, only one of them should run `synchronize` at a
   * time. Implemented as a lease the holder renews by asking again;
   * `synchronize` consults this at entry and returns early when denied.
   * Drivers with exclusive storage omit it — they always own sync.
   */
  requestSyncTurn?(): Promise<boolean>;
}

/** One committed change, as propagated between contexts. */
export interface ExternalChange {
  readonly record: { readonly id: string } & Record<string, unknown>;
  readonly type: 'created' | 'updated' | 'destroyed';
}

/** A batch's changes keyed by table — the shape the change buses deliver. */
export type ExternalChangeSet = {
  readonly [table: string]: readonly ExternalChange[];
};
