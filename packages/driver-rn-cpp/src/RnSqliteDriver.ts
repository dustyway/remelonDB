import type {
  BatchStatement,
  Row,
  SqlArgs,
  SqliteDriver,
} from '@remelondb/core'
import NativeRemelonDriver from './specs/NativeRemelonDriver'

/**
 * SqliteDriver over the NativeRemelonDriver C++ TurboModule.
 * Everything resolves synchronously underneath (in-process SQLite on the
 * JS thread); the Promise shape satisfies the seam contract — core never
 * depends on same-tick resolution.
 *
 * `name` is ':memory:', an absolute path, or a bare filename resolved
 * into the app's database directory by the native side.
 *
 * @example
 * ```ts
 * const db = await Database.open({
 *   driver: new RnSqliteDriver(),
 *   schema,
 *   name: 'app.db',   // resolved into the app's database directory
 * })
 * ```
 * @category Driver
 */
export class RnSqliteDriver implements SqliteDriver {
  private name: string | null = null

  private get openName(): string {
    if (this.name === null) {
      throw new Error('RnSqliteDriver: database is not open')
    }
    return this.name
  }

  async open(name: string): Promise<{ userVersion: number }> {
    if (this.name !== null) {
      throw new Error('RnSqliteDriver: database is already open')
    }
    const userVersion = NativeRemelonDriver.openDatabase(name)
    this.name = name
    return { userVersion }
  }

  async close(): Promise<void> {
    NativeRemelonDriver.close(this.openName)
    this.name = null
  }

  async query(sql: string, args: SqlArgs): Promise<Row[]> {
    return NativeRemelonDriver.query(this.openName, sql, args) as Row[]
  }

  async execute(sql: string, args: SqlArgs): Promise<void> {
    NativeRemelonDriver.execute(this.openName, sql, args)
  }

  async executeBatch(statements: readonly BatchStatement[]): Promise<void> {
    NativeRemelonDriver.executeBatch(this.openName, statements)
  }

  async setUserVersion(version: number): Promise<void> {
    NativeRemelonDriver.setUserVersion(this.openName, version)
  }

  async destroy(): Promise<void> {
    const name = this.name
    this.name = null
    if (name !== null) {
      NativeRemelonDriver.destroy(name)
    }
  }
}
