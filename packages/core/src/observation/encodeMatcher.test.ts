import { describe, expect, it } from 'vitest'
import * as Q from '../query/Q'
import type { Clause } from '../query/ast'
import type { RawRecord } from '../rawRecord/index'
import { canEncodeMatcher, encodeMatcher, likeToRegexp } from './encodeMatcher'

const raw = (fields: Record<string, unknown>): RawRecord =>
  ({ id: 'r1', _status: 'synced', _changed: '', ...fields }) as RawRecord

const matcher = (clauses: Clause[]) =>
  encodeMatcher(Q.buildQueryDescription(clauses))

describe('canEncodeMatcher', () => {
  it('accepts flat single-table queries', () => {
    expect(canEncodeMatcher(Q.buildQueryDescription([]))).toBe(true)
    expect(
      canEncodeMatcher(
        Q.buildQueryDescription([
          Q.where('a', 1),
          Q.or(Q.where('b', 2), Q.where('c', Q.gt(3))),
        ]),
      ),
    ).toBe(true)
  })

  it('rejects joins, sorting, pagination and raw SQL', () => {
    const cases: Clause[][] = [
      [Q.on('projects', 'a', 1)],
      [Q.joinTables(['projects'])],
      [Q.nestedJoin('projects', 'teams')],
      [Q.sortBy('a')],
      [Q.take(5)],
      [Q.unsafeSqlQuery('select 1')],
      [Q.unsafeSqlExpr('1 = 1')],
      [Q.and(Q.unsafeSqlExpr('1 = 1'))], // nested raw SQL
      [Q.joinTables(['p']), Q.or(Q.where('a', 1), Q.on('p', 'b', 2))], // nested on
    ]
    for (const clauses of cases) {
      const description = Q.buildQueryDescription(clauses)
      expect(canEncodeMatcher(description)).toBe(false)
      expect(() => encodeMatcher(description)).toThrow('cannot be matched')
    }
  })
})

describe('encodeMatcher', () => {
  it('matches like SQL IS semantics', () => {
    const m = matcher([Q.where('project_id', Q.notEq('p1'))])
    expect(m(raw({ project_id: 'p2' }))).toBe(true)
    expect(m(raw({ project_id: null }))).toBe(true) // IS NOT: null matches
    expect(m(raw({ project_id: 'p1' }))).toBe(false)
  })

  it('normalizes booleans to storage representation on both sides', () => {
    const m = matcher([Q.where('is_done', true)])
    expect(m(raw({ is_done: true }))).toBe(true)
    expect(m(raw({ is_done: 1 }))).toBe(true) // unsanitized DB shape
    expect(m(raw({ is_done: false }))).toBe(false)
    expect(matcher([Q.where('is_done', 1)])(raw({ is_done: true }))).toBe(true)
  })

  it('never equates values across types', () => {
    expect(matcher([Q.where('name', '42')])(raw({ name: 42 }))).toBe(false)
    expect(matcher([Q.where('name', 42)])(raw({ name: '42' }))).toBe(false)
  })

  it('filters deleted records unless disabled', () => {
    const description = Q.buildQueryDescription([])
    expect(encodeMatcher(description)(raw({ _status: 'deleted' }))).toBe(false)
    expect(
      encodeMatcher(description, { filterDeleted: false })(
        raw({ _status: 'deleted' }),
      ),
    ).toBe(true)
  })

  it('treats missing fields as null', () => {
    expect(matcher([Q.where('ghost', null)])(raw({}))).toBe(true)
    expect(matcher([Q.where('ghost', Q.gt(0))])(raw({}))).toBe(false)
  })
})

describe('likeToRegexp', () => {
  it('is ASCII-case-insensitive only, like SQLite', () => {
    expect(likeToRegexp('a%').test('Alpha')).toBe(true)
    expect(likeToRegexp('a%').test('ALPHA')).toBe(true)
    expect(likeToRegexp('å%').test('Ålpha')).toBe(false) // no unicode folding
    expect(likeToRegexp('å%').test('ålpha')).toBe(true)
  })

  it('handles wildcards, escapes and regex specials', () => {
    expect(likeToRegexp('_lpha').test('Alpha')).toBe(true)
    expect(likeToRegexp('_lpha').test('Alphas')).toBe(false)
    expect(likeToRegexp(`%${Q.escapeLike('100%')}%`).test('a 100% b')).toBe(true)
    expect(likeToRegexp(`%${Q.escapeLike('100%')}%`).test('a 1000 b')).toBe(false)
    expect(likeToRegexp('(a)+.b%').test('(a)+.bcd')).toBe(true)
    expect(likeToRegexp('(a)+.b%').test('aaab')).toBe(false)
  })
})
