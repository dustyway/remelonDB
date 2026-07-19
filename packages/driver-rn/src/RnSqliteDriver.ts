import type {
  BatchStatement,
  Row,
  SqlArgs,
  SqliteDriver,
} from '@remelondb/core'
import * as SQLite from 'expo-sqlite'

/**
 * SqliteDriver over expo-sqlite: a thin adapter mapping the seam's seven
 * methods onto its async API. expo-sqlite owns the native SQLite build —
 * and ships inside Expo Go, so apps using this driver need no custom
 * native build. The previous in-repo C++ TurboModule is parked
 * (docs/parked.md, tag `parked/driver-rn-cpp`) and revivable behind the
 * same interface.
 *
 * `name` is ':memory:' or a database filename managed by expo-sqlite.
 *
 * @example
 * ```ts
 * const db = await Database.open({
 *   driver: new RnSqliteDriver(),
 *   schema,
 *   name: 'app.db',
 * })
 * ```
 * @category Driver
 */
export class RnSqliteDriver implements SqliteDriver {
  private db: SQLite.SQLiteDatabase | null = null
  private name: string | null = null

  private get openDb(): SQLite.SQLiteDatabase {
    if (this.db === null) {
      throw new Error('RnSqliteDriver: database is not open')
    }
    return this.db
  }

  async open(name: string): Promise<{ userVersion: number }> {
    if (this.db !== null) {
      throw new Error('RnSqliteDriver: database is already open')
    }
    const db = await SQLite.openDatabaseAsync(name)
    await db.execAsync('pragma journal_mode = WAL')
    const row = await db.getFirstAsync<{ user_version: number }>(
      'pragma user_version',
    )
    this.db = db
    this.name = name
    return { userVersion: row?.user_version ?? 0 }
  }

  async close(): Promise<void> {
    await this.openDb.closeAsync()
    this.db = null
    this.name = null
  }

  async query(sql: string, args: SqlArgs): Promise<Row[]> {
    return this.openDb.getAllAsync<Row>(sql, args as SQLite.SQLiteBindValue[])
  }

  async execute(sql: string, args: SqlArgs): Promise<void> {
    await this.openDb.runAsync(sql, args as SQLite.SQLiteBindValue[])
  }

  async executeBatch(statements: readonly BatchStatement[]): Promise<void> {
    const db = this.openDb
    await db.withTransactionAsync(async () => {
      for (const [sql, argSets] of statements) {
        const statement = await db.prepareAsync(sql)
        try {
          for (const args of argSets) {
            await statement.executeAsync(args as SQLite.SQLiteBindValue[])
          }
        } finally {
          await statement.finalizeAsync()
        }
      }
    })
  }

  async setUserVersion(version: number): Promise<void> {
    if (!Number.isInteger(version) || version < 0) {
      throw new Error(`RnSqliteDriver: invalid user_version ${version}`)
    }
    await this.openDb.execAsync(`pragma user_version = ${version}`)
  }

  async destroy(): Promise<void> {
    const db = this.db
    const name = this.name
    this.db = null
    this.name = null
    if (db !== null) {
      await db.closeAsync()
    }
    if (name !== null && name !== ':memory:') {
      await SQLite.deleteDatabaseAsync(name)
    }
  }
}
