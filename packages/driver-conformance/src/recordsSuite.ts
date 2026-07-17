/** Round-trip property: sanitizedRaw ∘ (driver write + read) = identity. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appSchema,
  encodeQuery,
  encodeSchema,
  Q,
  sanitizedRaw,
  column as c,
  table,
  type SqliteDriver,
} from '@remelondb/core'
import type { ResolvedOptions } from './index'

const tasksTable = table('tasks', {
  name: c.string(),
  position: c.number(),
  is_done: c.boolean(),
  project_id: c.string().optional(),
})
const schema = appSchema({ version: 1, tables: [tasksTable] })

export function recordsSuite(options: ResolvedOptions): void {
  describe('raw record round-trip through the engine', () => {
    let driver: SqliteDriver

    beforeEach(async () => {
      driver = await options.createDriver()
      await driver.open(options.ephemeralName())
      await driver.executeBatch(encodeSchema(schema).map((sql) => [sql, [[]]]))
    })

    afterEach(async () => {
      await driver.destroy().catch(() => {})
    })

    it('reads back exactly what was written', async () => {
      const raw = sanitizedRaw(
        {
          id: 't1',
          _status: 'synced',
          _changed: '',
          name: 'hello',
          position: 2.5,
          is_done: true,
          project_id: null,
        },
        tasksTable,
      )
      await driver.execute(
        'insert into tasks ("id", "_changed", "_status", "name", "position", "is_done", "project_id") values (?, ?, ?, ?, ?, ?, ?)',
        [
          raw.id,
          raw._changed,
          raw._status,
          raw['name'] ?? null,
          raw['position'] ?? null,
          raw['is_done'] ?? null,
          raw['project_id'] ?? null,
        ],
      )

      const [sql, args] = encodeQuery({
        table: 'tasks',
        description: Q.buildQueryDescription([Q.where('is_done', true)]),
      })
      const rows = await driver.query(sql, args)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.['is_done']).toBe(1) // stored representation
      expect(sanitizedRaw(rows[0]!, tasksTable)).toEqual(raw)
    })
  })
}
