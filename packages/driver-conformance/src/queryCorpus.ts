/** Compiled-SQL semantics on the real engine: nulls, joins, LIKE, fan-out. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  encodeQuery,
  Q,
  type Clause,
  type EncodeQueryOptions,
  type QueryAssociation,
  type SqliteDriver,
} from '@remelondb/core'
import type { ResolvedOptions } from './index'

const associations: QueryAssociation[] = [
  { from: 'tasks', to: 'projects', info: { type: 'belongs_to', key: 'project_id' } },
  { from: 'tasks', to: 'comments', info: { type: 'has_many', foreignKey: 'task_id' } },
]

export function queryCorpusSuite(options: ResolvedOptions): void {
  describe('query semantics on the engine', () => {
    let driver: SqliteDriver

    const taskIds = async (clauses: Clause[], encode?: EncodeQueryOptions) => {
      const [sql, args] = encodeQuery(
        { table: 'tasks', description: Q.buildQueryDescription(clauses), associations },
        encode,
      )
      return (await driver.query(sql, args)).map((row) => row['id'])
    }

    const taskCount = async (clauses: Clause[]) => {
      const [sql, args] = encodeQuery(
        { table: 'tasks', description: Q.buildQueryDescription(clauses), associations },
        { mode: 'count' },
      )
      return (await driver.query(sql, args))[0]?.['count']
    }

    beforeEach(async () => {
      driver = await options.createDriver()
      await driver.open(options.ephemeralName())
      await driver.execute(
        'create table projects ("id" primary key, "name", "is_archived", "_status")',
        [],
      )
      await driver.execute(
        'create table tasks ("id" primary key, "name", "position", "is_done", "project_id", "created_at", "updated_at", "_status")',
        [],
      )
      await driver.execute(
        'create table comments ("id" primary key, "task_id", "body", "_status")',
        [],
      )
      await driver.executeBatch([
        [
          'insert into projects values (?, ?, ?, ?)',
          [
            ['p1', 'active project', false, 'synced'],
            ['p2', 'archived project', true, 'synced'],
            ['p3', 'deleted project', false, 'deleted'],
          ],
        ],
        [
          'insert into tasks values (?, ?, ?, ?, ?, ?, ?, ?)',
          [
            ['t1', '100% done', 1, true, 'p1', 5, 5, 'synced'],
            ['t2', '100 percent', 2, false, 'p1', 5, 10, 'synced'],
            ['t3', 'in archived', 3, false, 'p2', 0, 0, 'synced'],
            ['t4', 'orphan', 4, false, null, 0, 0, 'synced'],
            ['t5', 'in deleted project', 5, true, 'p3', 0, 0, 'synced'],
            ['t6', 'locally deleted', 6, false, 'p1', 0, 0, 'deleted'],
          ],
        ],
        [
          'insert into comments values (?, ?, ?, ?)',
          [
            ['c1', 't1', 'first', 'synced'],
            ['c2', 't1', 'second', 'synced'],
            ['c3', 't2', 'third', 'synced'],
          ],
        ],
      ])
    })

    afterEach(async () => {
      await driver.destroy().catch(() => {})
    })

    it('never returns deleted records, unless the filter is disabled', async () => {
      expect(await taskIds([Q.sortBy('position')])).toEqual([
        't1', 't2', 't3', 't4', 't5',
      ])
      expect(
        await taskIds([Q.sortBy('position')], { filterDeleted: false }),
      ).toEqual(['t1', 't2', 't3', 't4', 't5', 't6'])
    })

    it('eq matches booleans and null', async () => {
      expect(
        await taskIds([Q.where('is_done', true), Q.sortBy('position')]),
      ).toEqual(['t1', 't5'])
      expect(await taskIds([Q.where('project_id', null)])).toEqual(['t4'])
    })

    it('notEq matches null columns (IS NOT semantics)', async () => {
      expect(
        await taskIds([Q.where('project_id', Q.notEq('p1')), Q.sortBy('position')]),
      ).toEqual(['t3', 't4', 't5'])
    })

    it('oneOf with an empty list matches nothing', async () => {
      expect(await taskIds([Q.where('project_id', Q.oneOf([]))])).toEqual([])
      expect(
        await taskIds([
          Q.where('project_id', Q.oneOf(['p1', 'p2'])),
          Q.sortBy('position'),
        ]),
      ).toEqual(['t1', 't2', 't3'])
    })

    it('notIn excludes null columns (SQL null semantics)', async () => {
      expect(
        await taskIds([Q.where('project_id', Q.notIn(['p1'])), Q.sortBy('position')]),
      ).toEqual(['t3', 't5'])
    })

    it('notIn with an empty list matches everything, even null', async () => {
      expect(
        await taskIds([Q.where('project_id', Q.notIn([])), Q.sortBy('position')]),
      ).toEqual(['t1', 't2', 't3', 't4', 't5'])
    })

    it('between is inclusive', async () => {
      expect(
        await taskIds([Q.where('position', Q.between(2, 4)), Q.sortBy('position')]),
      ).toEqual(['t2', 't3', 't4'])
    })

    it('comparisons follow sqlite storage-class ordering (text above numbers)', async () => {
      expect(
        await taskIds([Q.where('name', Q.gt(999)), Q.sortBy('position')]),
      ).toEqual(['t1', 't2', 't3', 't4', 't5'])
      expect(await taskIds([Q.where('position', Q.gt(''))])).toEqual([])
    })

    it('like is case-insensitive for ascii letters only', async () => {
      await driver.execute('insert into tasks values (?, ?, ?, ?, ?, ?, ?, ?)', [
        't7', 'Ålpha', 7, false, null, 0, 0, 'synced',
      ])
      expect(await taskIds([Q.where('name', Q.like('ORPHAN'))])).toEqual(['t4'])
      expect(await taskIds([Q.where('name', Q.like('_rphan'))])).toEqual(['t4'])
      expect(await taskIds([Q.where('name', Q.like('å%'))])).toEqual([])
      expect(await taskIds([Q.where('name', Q.like('Å%'))])).toEqual(['t7'])
    })

    it('nested and/or', async () => {
      expect(
        await taskIds([
          Q.or(
            Q.and(Q.where('is_done', true), Q.where('position', Q.lte(1))),
            Q.where('project_id', null),
          ),
          Q.sortBy('position'),
        ]),
      ).toEqual(['t1', 't4'])
    })

    it('escapeLike makes wildcards literal', async () => {
      expect(
        await taskIds([Q.where('name', Q.like('%100%%')), Q.sortBy('position')]),
      ).toEqual(['t1', 't2'])
      expect(
        await taskIds([Q.where('name', Q.like(`%${Q.escapeLike('100%')}%`))]),
      ).toEqual(['t1'])
      expect(
        await taskIds([Q.where('name', Q.like(`%${Q.escapeLike('100x')}%`))]),
      ).toEqual([])
    })

    it('includes does literal substring matching', async () => {
      expect(await taskIds([Q.where('name', Q.includes('0%'))])).toEqual(['t1'])
    })

    it('compares columns to columns', async () => {
      expect(
        await taskIds([Q.where('updated_at', Q.gt(Q.column('created_at')))]),
      ).toEqual(['t2'])
    })

    it('sorts and paginates', async () => {
      expect(
        await taskIds([Q.sortBy('position', Q.desc), Q.take(2), Q.skip(1)]),
      ).toEqual(['t4', 't3'])
    })

    it('left join + IS semantics: notEq matches tasks with no (or deleted) project', async () => {
      expect(
        await taskIds([
          Q.on('projects', 'is_archived', Q.notEq(true)),
          Q.sortBy('position'),
        ]),
      ).toEqual(['t1', 't2', 't4', 't5'])
    })

    it('join eq only matches tasks with a live matching project', async () => {
      expect(
        await taskIds([Q.on('projects', 'is_archived', false), Q.sortBy('position')]),
      ).toEqual(['t1', 't2'])
    })

    it('has_many joins deduplicate fanned-out rows, in select and count', async () => {
      expect(
        await taskIds([Q.on('comments', 'body', Q.notEq(null)), Q.sortBy('position')]),
      ).toEqual(['t1', 't2'])
      expect(await taskCount([Q.on('comments', 'body', Q.notEq(null))])).toBe(2)
    })

    it('counts without joins', async () => {
      expect(await taskCount([Q.where('is_done', false)])).toBe(3)
    })
  })
}
