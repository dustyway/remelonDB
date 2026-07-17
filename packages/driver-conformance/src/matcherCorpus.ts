/**
 * The "one authoritative engine" rule, executable: every query the
 * in-memory matcher accepts must return exactly the same records as the
 * compiled SQL run by this driver's engine. One corpus, two engines.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  appSchema,
  column,
  canEncodeMatcher,
  encodeMatcher,
  encodeQuery,
  encodeSchema,
  Q,
  sanitizedRaw,
  table,
  type Clause,
  type RawRecord,
  type SqliteDriver,
} from '@remelondb/core'
import type { ResolvedOptions } from './index'

const itemsTable = table('items', {
  name: column.string(),
  position: column.number(),
  is_done: column.boolean(),
  project_id: column.string().optional(),
  score: column.number().optional(),
})
const schema = appSchema({ version: 1, tables: [itemsTable] })

//                 id     name          pos  done   project  score  status
const FIXTURES = [
  ['i1', 'Alpha', 1, true, 'p1', 10, 'synced'],
  ['i2', 'ALPHA', 2, false, null, null, 'synced'],
  ['i3', 'ålpha', 3, false, 'p2', 5, 'synced'],
  ['i4', '100%_done', 4, true, 'p1', null, 'synced'],
  ['i5', '', 5, false, null, 0, 'synced'],
  ['i6', 'Ålpha', 6, false, 'p2', 2, 'synced'],
  ['i7', '42', 7, true, 'p3', 100, 'synced'],
  ['i8', 'deleted row', 8, true, 'p1', 1, 'deleted'],
] as const

const CORPUS: { label: string; clauses: Clause[] }[] = [
  { label: 'match all', clauses: [] },
  { label: 'eq true', clauses: [Q.where('is_done', true)] },
  { label: 'eq 1 on boolean column', clauses: [Q.where('is_done', 1)] },
  { label: 'eq null', clauses: [Q.where('project_id', null)] },
  { label: 'eq across types', clauses: [Q.where('name', 42)] },
  { label: 'notEq null', clauses: [Q.where('project_id', Q.notEq(null))] },
  { label: 'notEq value (null matches)', clauses: [Q.where('project_id', Q.notEq('p1'))] },
  { label: 'gt number', clauses: [Q.where('position', Q.gt(3))] },
  { label: 'gte/lte range', clauses: [Q.where('position', Q.gte(2)), Q.where('position', Q.lte(5))] },
  { label: 'lt on nullable column', clauses: [Q.where('score', Q.lt(6))] },
  { label: 'gt mixed types (text sorts above numbers)', clauses: [Q.where('name', Q.gt(5))] },
  { label: 'lt string', clauses: [Q.where('name', Q.lt('Alpha'))] },
  { label: 'between', clauses: [Q.where('position', Q.between(2, 4))] },
  { label: 'oneOf', clauses: [Q.where('project_id', Q.oneOf(['p1', 'p2']))] },
  { label: 'oneOf empty', clauses: [Q.where('project_id', Q.oneOf([]))] },
  { label: 'oneOf booleans', clauses: [Q.where('is_done', Q.oneOf([true]))] },
  { label: 'notIn', clauses: [Q.where('project_id', Q.notIn(['p1']))] },
  { label: 'notIn empty (matches all, even null)', clauses: [Q.where('project_id', Q.notIn([]))] },
  { label: 'like ascii case-insensitive', clauses: [Q.where('name', Q.like('a%'))] },
  { label: 'like no unicode case folding', clauses: [Q.where('name', Q.like('å%'))] },
  { label: 'like single-char wildcard', clauses: [Q.where('name', Q.like('_lpha'))] },
  { label: 'like escaped wildcard', clauses: [Q.where('name', Q.like(`%${Q.escapeLike('100%')}%`))] },
  { label: 'notLike', clauses: [Q.where('name', Q.notLike('a%'))] },
  { label: 'includes', clauses: [Q.where('name', Q.includes('0%'))] },
  { label: 'column comparison with nulls', clauses: [Q.where('score', Q.gt(Q.column('position')))] },
  { label: 'column eq (null is null)', clauses: [Q.where('project_id', Q.eq(Q.column('project_id')))] },
  {
    label: 'nested and/or',
    clauses: [
      Q.or(
        Q.and(Q.where('is_done', true), Q.where('position', Q.lte(4))),
        Q.where('project_id', null),
      ),
    ],
  },
]

export function matcherCorpusSuite(options: ResolvedOptions): void {
  describe('matcher/SQL agreement: one corpus, two engines', () => {
    let driver: SqliteDriver
    let allRaws: RawRecord[] = []

    beforeAll(async () => {
      driver = await options.createDriver()
      await driver.open(options.ephemeralName())
      await driver.executeBatch(encodeSchema(schema).map((sql) => [sql, [[]]]))
      await driver.executeBatch([
        [
          'insert into items ("id", "name", "position", "is_done", "project_id", "score", "_status", "_changed") values (?, ?, ?, ?, ?, ?, ?, ?)',
          FIXTURES.map((f) => [...f, ''] as const),
        ],
      ])
      const rows = await driver.query('select * from items', [])
      allRaws = rows.map((row) => sanitizedRaw(row, itemsTable))
      expect(allRaws).toHaveLength(FIXTURES.length)
    })

    afterAll(async () => {
      await driver.destroy().catch(() => {})
    })

    it.each(CORPUS)('$label', async ({ clauses }) => {
      const description = Q.buildQueryDescription(clauses)
      expect(canEncodeMatcher(description)).toBe(true)

      const [sql, args] = encodeQuery({ table: 'items', description })
      const sqlIds = (await driver.query(sql, args)).map((row) => row['id']).sort()

      const matcher = encodeMatcher(description)
      const matcherIds = allRaws
        .filter(matcher)
        .map((raw) => raw.id)
        .sort()

      expect(matcherIds).toEqual(sqlIds)
    })
  })
}
