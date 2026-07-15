import SQLiteDatabase from 'better-sqlite3'
import { unlink } from 'node:fs/promises'
import type {
  BatchStatement,
  Row,
  SqlArgs,
  SqliteDriver,
} from '@remelondb/core'

/**
 * SqliteDriver over better-sqlite3. Everything is synchronous underneath;
 * the Promise shape exists to satisfy the seam contract.
 *
 * `name` is a filesystem path, or ':memory:' for a throwaway database.
 */
export class NodeSqliteDriver implements SqliteDriver {
  private db: SQLiteDatabase.Database | null = null
  private name: string | null = null

  private get openDb(): SQLiteDatabase.Database {
    if (!this.db) {
      throw new Error('NodeSqliteDriver: database is not open')
    }
    return this.db
  }

  async open(name: string): Promise<{ userVersion: number }> {
    if (this.db) {
      throw new Error('NodeSqliteDriver: database is already open')
    }
    const db = new SQLiteDatabase(name)
    if (name !== ':memory:') {
      db.pragma('journal_mode = WAL')
    }
    this.db = db
    this.name = name
    const userVersion = db.pragma('user_version', { simple: true }) as number
    return { userVersion }
  }

  async close(): Promise<void> {
    this.openDb.close()
    this.db = null
  }

  async query(sql: string, args: SqlArgs): Promise<Row[]> {
    return this.openDb.prepare(sql).all(...bindArgs(args)) as Row[]
  }

  async execute(sql: string, args: SqlArgs): Promise<void> {
    this.openDb.prepare(sql).run(...bindArgs(args))
  }

  async executeBatch(statements: readonly BatchStatement[]): Promise<void> {
    const db = this.openDb
    db.transaction(() => {
      for (const [sql, argSets] of statements) {
        const prepared = db.prepare(sql)
        for (const args of argSets) {
          prepared.run(...bindArgs(args))
        }
      }
    })()
  }

  async setUserVersion(version: number): Promise<void> {
    this.openDb.pragma(`user_version = ${version}`)
  }

  async destroy(): Promise<void> {
    const name = this.name
    if (this.db) {
      await this.close()
    }
    this.name = null
    if (name && name !== ':memory:') {
      for (const suffix of ['', '-wal', '-shm']) {
        await unlink(name + suffix).catch(() => {})
      }
    }
  }
}

// SQLite has no boolean storage class and better-sqlite3 rejects boolean
// bind values, so they become 0/1 at the seam.
function bindArgs(args: SqlArgs): (string | number | null)[] {
  return args.map((value) => {
    if (typeof value === 'boolean') {
      return value ? 1 : 0
    }
    return value
  })
}
