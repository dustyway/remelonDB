import { describe, expect, it } from 'vitest'
import * as Q from './Q'
import { columnTag, comparisonTag } from './ast'

describe('comparisons', () => {
  it('Q.where with a raw value is shorthand for eq', () => {
    expect(Q.where('name', 'foo')).toEqual({
      type: 'where',
      left: 'name',
      comparison: { type: comparisonTag, operator: 'eq', right: { value: 'foo' } },
    })
    expect(Q.where('deleted_at', null).comparison.right).toEqual({ value: null })
  })

  it('builds explicit comparisons', () => {
    expect(Q.where('likes', Q.gt(10)).comparison).toEqual({
      type: comparisonTag,
      operator: 'gt',
      right: { value: 10 },
    })
    expect(Q.between(1, 5).right).toEqual({ values: [1, 5] })
    expect(Q.oneOf(['a', 'b']).right).toEqual({ values: ['a', 'b'] })
    expect(Q.notIn([1, 2]).right).toEqual({ values: [1, 2] })
    expect(Q.like('foo%').right).toEqual({ value: 'foo%' })
    expect(Q.includes('needle').right).toEqual({ value: 'needle' })
  })

  it('supports column-to-column comparisons', () => {
    expect(Q.where('updated_at', Q.gt(Q.column('created_at'))).comparison).toEqual({
      type: comparisonTag,
      operator: 'gt',
      right: { column: 'created_at' },
    })
    expect(Q.column('foo')).toEqual({ type: columnTag, column: 'foo' })
  })

  it('rejects invalid values', () => {
    expect(() => Q.where('a', undefined as never)).toThrow('did you mean null')
    expect(() => Q.eq({} as never)).toThrow('primitive')
    expect(() => Q.gt(null as never)).toThrow('null')
    expect(() => Q.gt(NaN)).toThrow('NaN')
    expect(() => Q.oneOf(['a', null as never])).toThrow('null')
    expect(() => Q.between('1' as never, 2)).toThrow('two numbers')
    expect(() => Q.like(7 as never)).toThrow('string')
  })

  it('rejects unsafe identifiers', () => {
    expect(() => Q.where('na me', 1)).toThrow('Invalid column name')
    expect(() => Q.where('"a"; drop table t;--', 1)).toThrow('Invalid column name')
    expect(() => Q.column('a-b')).toThrow('Invalid column name')
    expect(() => Q.on('bad table', 'a', 1)).toThrow('Invalid table name')
    expect(() => Q.sortBy('bad col')).toThrow('Invalid column name')
  })

  it('escapeLike neutralizes LIKE wildcards', () => {
    expect(Q.escapeLike('100%_done\\')).toBe('100\\%\\_done\\\\')
    expect(Q.escapeLike('plain')).toBe('plain')
  })
})

describe('condition trees', () => {
  it('builds and/or/on trees', () => {
    const tree = Q.and(
      Q.where('a', 1),
      Q.or(Q.where('b', true), Q.on('projects', 'is_archived', false)),
    )
    expect(tree.type).toBe('and')
    expect(tree.conditions).toHaveLength(2)
  })

  it('Q.on supports shorthand and condition-list forms', () => {
    const shorthand = Q.on('projects', 'team_id', 'abc')
    expect(shorthand).toEqual({
      type: 'on',
      table: 'projects',
      conditions: [Q.where('team_id', 'abc')],
    })

    const list = Q.on('projects', Q.where('a', 1), Q.where('b', 2))
    expect(list.conditions).toHaveLength(2)

    expect(() =>
      Q.on('projects', Q.where('a', 1), Q.eq(2) as never),
    ).toThrow('invalid condition')
    expect(() => Q.on('projects', 'a' as never)).toThrow('shorthand form')
  })

  it('rejects junk in condition positions', () => {
    expect(() => Q.and({ evil: true } as never)).toThrow('invalid condition')
    expect(() => Q.or()).toThrow('at least one condition')
    expect(() => Q.and(Q.sortBy('a') as never)).toThrow('invalid condition')
  })
})

describe('buildQueryDescription', () => {
  it('folds clauses into a description', () => {
    const description = Q.buildQueryDescription([
      Q.where('is_done', false),
      Q.on('projects', 'is_archived', false),
      Q.sortBy('position', Q.desc),
      Q.take(10),
      Q.skip(20),
    ])
    expect(description.where).toHaveLength(2)
    expect(description.joinTables).toEqual(['projects'])
    expect(description.sortBy).toEqual([
      { type: 'sortBy', sortColumn: 'position', sortOrder: 'desc' },
    ])
    expect(description.take).toBe(10)
    expect(description.skip).toBe(20)
    expect(description.sql).toBeUndefined()
  })

  it('collects and dedupes join tables', () => {
    const description = Q.buildQueryDescription([
      Q.joinTables(['projects', 'teams']),
      Q.on('projects', 'a', 1),
      Q.nestedJoin('projects', 'teams'),
    ])
    expect(description.joinTables).toEqual(['projects', 'teams'])
    expect(description.nestedJoinTables).toEqual([
      { type: 'nestedJoinTable', from: 'projects', to: 'teams' },
    ])
  })

  it('enforces clause invariants', () => {
    expect(() => Q.buildQueryDescription([Q.skip(5)])).toThrow(
      'Q.skip requires Q.take',
    )
    expect(() => Q.buildQueryDescription([Q.take(1), Q.take(2)])).toThrow(
      'duplicate',
    )
    expect(() =>
      Q.buildQueryDescription([Q.unsafeSqlQuery('select 1'), Q.where('a', 1)]),
    ).toThrow('replaces the whole query')
  })

  it('allows unsafeSqlQuery with join declarations only', () => {
    const description = Q.buildQueryDescription([
      Q.joinTables(['projects']),
      Q.unsafeSqlQuery('select tasks.* from tasks, projects where x = ?', [1]),
    ])
    expect(description.sql?.values).toEqual([1])
  })

  it('freezes the description outside production', () => {
    const description = Q.buildQueryDescription([Q.where('a', 1)])
    expect(Object.isFrozen(description)).toBe(true)
    expect(Object.isFrozen(description.where[0])).toBe(true)
  })

  it('descriptions are plain serializable data', () => {
    const description = Q.buildQueryDescription([
      Q.where('a', Q.oneOf([1, 2])),
      Q.sortBy('b'),
      Q.take(5),
    ])
    expect(JSON.parse(JSON.stringify(description))).toMatchObject({
      where: [{ type: 'where', left: 'a' }],
      sortBy: [{ sortColumn: 'b' }],
      take: 5,
    })
  })
})
