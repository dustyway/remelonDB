import type {
  BatchStatement,
  Row,
  SqlArgs,
  SqliteDriver,
} from '@remelon/core'
import NativeWatermelonDriver from './specs/NativeWatermelonDriver'

/**
 * SqliteDriver over the NativeWatermelonDriver C++ TurboModule.
 * Everything resolves synchronously underneath (in-process SQLite on the
 * JS thread); the Promise shape satisfies the seam contract — core never
 * depends on same-tick resolution.
 *
 * `name` is ':memory:', an absolute path, or a bare filename resolved
 * into the app's database directory by the native side.
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
    const userVersion = NativeWatermelonDriver.openDatabase(name)
    this.name = name
    return { userVersion }
  }

  async close(): Promise<void> {
    NativeWatermelonDriver.close(this.openName)
    this.name = null
  }

  async query(sql: string, args: SqlArgs): Promise<Row[]> {
    return NativeWatermelonDriver.query(this.openName, sql, args) as Row[]
  }

  async execute(sql: string, args: SqlArgs): Promise<void> {
    NativeWatermelonDriver.execute(this.openName, sql, args)
  }

  async executeBatch(statements: readonly BatchStatement[]): Promise<void> {
    NativeWatermelonDriver.executeBatch(this.openName, statements)
  }

  async setUserVersion(version: number): Promise<void> {
    NativeWatermelonDriver.setUserVersion(this.openName, version)
  }

  async destroy(): Promise<void> {
    const name = this.name
    this.name = null
    if (name !== null) {
      NativeWatermelonDriver.destroy(name)
    }
  }
}
