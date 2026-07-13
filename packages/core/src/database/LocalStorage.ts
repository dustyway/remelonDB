/**
 * String key-value storage over the core-owned `local_storage` table
 * (created by encodeSchema). Used by sync for its cursor, available to
 * apps for small metadata. A core feature over plain SQL — not a driver
 * method (docs/architecture-layers.md, decision 2).
 */
import type { SqliteDriver } from '../driver/SqliteDriver'

export class LocalStorage {
  constructor(private readonly driver: SqliteDriver) {}

  async get(key: string): Promise<string | null> {
    const rows = await this.driver.query(
      'select "value" from "local_storage" where "key" is ?',
      [key],
    )
    const value = rows[0]?.['value']
    return typeof value === 'string' ? value : null
  }

  async set(key: string, value: string): Promise<void> {
    await this.driver.execute(
      'insert or replace into "local_storage" ("key", "value") values (?, ?)',
      [key, value],
    )
  }

  async remove(key: string): Promise<void> {
    await this.driver.execute('delete from "local_storage" where "key" is ?', [
      key,
    ])
  }
}
