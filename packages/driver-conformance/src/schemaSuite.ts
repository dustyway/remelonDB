/** Schema DDL and migrations on the real engine. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addColumns,
  appSchema,
  createTable,
  encodeMigrationSteps,
  encodeQuery,
  encodeSchema,
  Q,
  schemaMigrations,
  stepsForMigration,
  tableSchema,
  type SqliteDriver,
} from '@watermelon-rewrite/core'
import type { ResolvedOptions } from './index'

const schemaV1 = appSchema({
  version: 1,
  tables: [
    tableSchema({
      name: 'tasks',
      columns: [
        { name: 'name', type: 'string' },
        { name: 'position', type: 'number', isIndexed: true },
      ],
    }),
  ],
})

const migrations = schemaMigrations({
  migrations: [
    {
      toVersion: 2,
      steps: [
        addColumns({
          table: 'tasks',
          columns: [
            { name: 'priority', type: 'number', isIndexed: true },
            { name: 'note', type: 'string', isOptional: true },
          ],
        }),
      ],
    },
    {
      toVersion: 3,
      steps: [createTable({ name: 'tags', columns: [{ name: 'label', type: 'string' }] })],
    },
  ],
})

const asBatch = (statements: string[]) =>
  statements.map((sql) => [sql, [[]]] as const)

export function schemaSuite(options: ResolvedOptions): void {
  describe('schema DDL and migrations on the engine', () => {
    let driver: SqliteDriver

    beforeEach(async () => {
      driver = await options.createDriver()
      await driver.open(options.ephemeralName())
      await driver.executeBatch(asBatch(encodeSchema(schemaV1)))
      await driver.setUserVersion(schemaV1.version)
    })

    afterEach(async () => {
      await driver.destroy().catch(() => {})
    })

    it('creates tables, standard columns, local_storage and indices', async () => {
      const tables = await driver.query(
        `select name from sqlite_master where type = 'table' order by name`,
        [],
      )
      expect(tables.map((t) => t['name'])).toEqual(['local_storage', 'tasks'])

      const indices = await driver.query(
        `select name from sqlite_master where type = 'index' and name like 'tasks%' order by name`,
        [],
      )
      expect(indices.map((i) => i['name'])).toEqual(['tasks__status', 'tasks_position'])

      await driver.execute(
        'insert into tasks ("id", "_changed", "_status", "name", "position") values (?, ?, ?, ?, ?)',
        ['t1', '', 'synced', 'hello', 1],
      )
      const [sql, args] = encodeQuery({
        table: 'tasks',
        description: Q.buildQueryDescription([Q.where('name', 'hello')]),
      })
      expect(await driver.query(sql, args)).toEqual([
        { id: 't1', _changed: '', _status: 'synced', name: 'hello', position: 1 },
      ])
    })

    it('migrates with backfilled defaults', async () => {
      await driver.execute(
        'insert into tasks ("id", "_changed", "_status", "name", "position") values (?, ?, ?, ?, ?)',
        ['t1', '', 'synced', 'pre-migration', 1],
      )

      const steps = stepsForMigration(migrations, { from: 1, to: 3 })
      expect(steps).not.toBeNull()
      await driver.executeBatch(asBatch(encodeMigrationSteps(steps!)))
      await driver.setUserVersion(3)

      const rows = await driver.query('select * from tasks', [])
      expect(rows).toEqual([
        {
          id: 't1',
          _changed: '',
          _status: 'synced',
          name: 'pre-migration',
          position: 1,
          priority: 0,
          note: null,
        },
      ])

      const tags = await driver.query(
        `select name from sqlite_master where type = 'table' and name = 'tags'`,
        [],
      )
      expect(tags).toHaveLength(1)

      const priorityIndex = await driver.query(
        `select name from sqlite_master where type = 'index' and name = 'tasks_priority'`,
        [],
      )
      expect(priorityIndex).toHaveLength(1)
    })
  })
}
