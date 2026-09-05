import SQLiteDatabase from 'better-sqlite3';
import { unlink } from 'node:fs/promises';
import type {
  BatchStatement,
  Row,
  SqlArgs,
  SqliteDriver,
} from '@remelondb/core';

/**
 * SqliteDriver over better-sqlite3. Everything is synchronous underneath;
 * the Promise shape exists to satisfy the seam contract.
 *
 * `name` is a filesystem path, or ':memory:' for a throwaway database.
 *
 * @example
 * ```ts
 * const db = await Database.open({
 *   driver: new NodeSqliteDriver(),
 *   schema,
 *   name: ':memory:',
 * })
 * ```
 * @category Driver
 */
export class NodeSqliteDriver implements SqliteDriver {
  private db: SQLiteDatabase.Database | null = null;
  private name: string | null = null;

  private get openDb(): SQLiteDatabase.Database {
    if (!this.db) {
      throw new Error('NodeSqliteDriver: database is not open');
    }
    return this.db;
  }

  async open(name: string): Promise<{ userVersion: number }> {
    if (this.db) {
      throw new Error('NodeSqliteDriver: database is already open');
    }
    const db = new SQLiteDatabase(name);
    if (name !== ':memory:') {
      db.pragma('journal_mode = WAL');
    }
    this.db = db;
    this.name = name;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- better-sqlite3 types `pragma` as `unknown`; `user_version` is an integer by SQLite's own definition.
    const userVersion = db.pragma('user_version', { simple: true }) as number;
    return { userVersion };
  }

  async close(): Promise<void> {
    this.openDb.close();
    this.db = null;
  }

  async query(sql: string, args: SqlArgs): Promise<Row[]> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- better-sqlite3 types `all()` as `unknown[]`; the driver contract is that callers ask for columns SQLite can return.
    const rows = this.openDb.prepare(sql).all(...bindArgs(args)) as Row[];
    for (const row of rows) {
      for (const key in row) {
        const value = row[key];
        // Buffer is a Uint8Array with its own toJSON; hand out a plain view.
        if (Buffer.isBuffer(value)) {
          row[key] = new Uint8Array(
            value.buffer,
            value.byteOffset,
            value.length,
          );
        }
      }
    }
    return rows;
  }

  async execute(sql: string, args: SqlArgs): Promise<void> {
    this.openDb.prepare(sql).run(...bindArgs(args));
  }

  async executeBatch(statements: readonly BatchStatement[]): Promise<void> {
    const db = this.openDb;
    db.transaction(() => {
      for (const [sql, argSets] of statements) {
        const prepared = db.prepare(sql);
        for (const args of argSets) {
          prepared.run(...bindArgs(args));
        }
      }
    })();
  }

  async setUserVersion(version: number): Promise<void> {
    this.openDb.pragma(`user_version = ${version}`);
  }

  async destroy(): Promise<void> {
    const name = this.name;
    if (this.db) {
      await this.close();
    }
    this.name = null;
    if (name && name !== ':memory:') {
      for (const suffix of ['', '-wal', '-shm']) {
        await unlink(name + suffix).catch(() => {});
      }
    }
  }
}

// SQLite has no boolean storage class and better-sqlite3 rejects boolean
// bind values, so they become 0/1 at the seam.
function bindArgs(args: SqlArgs): (string | number | Uint8Array | null)[] {
  return args.map((value) => {
    if (typeof value === 'boolean') {
      return value ? 1 : 0;
    }
    return value;
  });
}
