/** Driver method obligations: lifecycle, round-trip, batch atomicity. */
import { afterEach, describe, expect, it } from 'vitest'
import type { SqliteDriver } from '@remelon/core'
import type { ResolvedOptions } from './index'

export function contractSuite(options: ResolvedOptions): void {
  describe('driver contract', () => {
    let driver: SqliteDriver | null = null

    const open = async (name = options.ephemeralName()) => {
      driver = await options.createDriver()
      return { driver, opened: await driver.open(name) }
    }

    afterEach(async () => {
      await driver?.destroy().catch(() => {})
      driver = null
    })

    it('opens a fresh database with user_version 0', async () => {
      const { opened } = await open()
      expect(opened.userVersion).toBe(0)
    })

    it('round-trips rows through execute, executeBatch, and query', async () => {
      const { driver } = await open()
      await driver.execute(
        'create table tasks ("id" primary key, "name", "position", "is_done")',
        [],
      )
      await driver.executeBatch([
        [
          'insert into tasks (id, name, position, is_done) values (?, ?, ?, ?)',
          [
            ['t1', 'write scaffolding', 1.5, false],
            ['t2', 'run tests', 2, true],
            ['t3', null, 3, false],
          ],
        ],
        ['update tasks set position = position + 10 where is_done = ?', [[true]]],
      ])

      const rows = await driver.query(
        'select id, name, position, is_done from tasks order by position',
        [],
      )
      expect(rows).toEqual([
        { id: 't1', name: 'write scaffolding', position: 1.5, is_done: 0 },
        { id: 't3', name: null, position: 3, is_done: 0 },
        { id: 't2', name: 'run tests', position: 12, is_done: 1 },
      ])

      const filtered = await driver.query(
        'select id from tasks where name like ?',
        ['write%'],
      )
      expect(filtered).toEqual([{ id: 't1' }])
    })

    it('rolls back the whole batch when one statement fails', async () => {
      const { driver } = await open()
      await driver.execute('create table t ("id" primary key)', [])
      await expect(
        driver.executeBatch([
          ['insert into t (id) values (?)', [['a'], ['b']]],
          ['insert into t (id) values (?)', [['a']]], // primary key violation
        ]),
      ).rejects.toThrow()
      expect(await driver.query('select id from t', [])).toEqual([])
    })

    it('sets and reports user_version', async () => {
      const { driver } = await open()
      await driver.setUserVersion(7)
      expect(await driver.query('pragma user_version', [])).toEqual([
        { user_version: 7 },
      ])
    })

    it('rejects operations when not open, and double-opens', async () => {
      driver = await options.createDriver()
      await expect(driver.query('select 1', [])).rejects.toThrow(/not open/)
      await driver.open(options.ephemeralName())
      await expect(driver.open(options.ephemeralName())).rejects.toThrow(
        /already open/,
      )
    })

    if (options.persistence) {
      const { databaseName } = options.persistence

      it('persists user_version and data across reopen', async () => {
        const name = databaseName()
        const { driver: first } = await open(name)
        await first.execute('create table t ("id")', [])
        await first.execute('insert into t values (?)', ['x'])
        await first.setUserVersion(7)
        await first.close()

        const second = await options.createDriver()
        driver = second
        const { userVersion } = await second.open(name)
        expect(userVersion).toBe(7)
        expect(await second.query('select * from t', [])).toEqual([{ id: 'x' }])
      })

      it('destroy removes the database', async () => {
        const name = databaseName()
        const { driver: first } = await open(name)
        await first.execute('create table t ("id")', [])
        await first.destroy()

        const second = await options.createDriver()
        driver = second
        const { userVersion } = await second.open(name)
        expect(userVersion).toBe(0)
        expect(
          await second.query(
            `select name from sqlite_master where type = 'table'`,
            [],
          ),
        ).toEqual([])
      })
    }
  })
}
