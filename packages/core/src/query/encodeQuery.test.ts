import { describe, expect, it } from 'vitest'
import * as Q from './Q'
import { encodeQuery, type QueryAssociation } from './encodeQuery'
import type { Clause } from './ast'

const tasks = (clauses: Clause[], associations?: QueryAssociation[]) => ({
  table: 'tasks',
  description: Q.buildQueryDescription(clauses),
  ...(associations ? { associations } : {}),
})

const belongsToProjects: QueryAssociation = {
  from: 'tasks',
  to: 'projects',
  info: { type: 'belongs_to', key: 'project_id' },
}
const hasManyComments: QueryAssociation = {
  from: 'tasks',
  to: 'comments',
  info: { type: 'has_many', foreignKey: 'task_id' },
}

describe('encodeQuery', () => {
  it('compiles an empty query with the deleted filter', () => {
    expect(encodeQuery(tasks([]))).toEqual([
      `select "tasks".* from "tasks" where "tasks"."_status" is not 'deleted'`,
      [],
    ])
  })

  it('omits the deleted filter when disabled', () => {
    expect(encodeQuery(tasks([]), { filterDeleted: false })).toEqual([
      'select "tasks".* from "tasks"',
      [],
    ])
  })

  it('compiles eq/notEq to is / is not with placeholders', () => {
    expect(encodeQuery(tasks([Q.where('is_done', true)]))).toEqual([
      `select "tasks".* from "tasks" where "tasks"."is_done" is ? and "tasks"."_status" is not 'deleted'`,
      [true],
    ])
    expect(
      encodeQuery(tasks([Q.where('project_id', Q.notEq(null))]))[1],
    ).toEqual([null])
  })

  it('compiles nested and/or trees with args in order', () => {
    const [sql, args] = encodeQuery(
      tasks([
        Q.or(
          Q.where('a', 1),
          Q.and(Q.where('b', Q.gt(2)), Q.where('c', Q.oneOf([3, 4]))),
        ),
      ]),
    )
    expect(sql).toBe(
      `select "tasks".* from "tasks" where ("tasks"."a" is ? or ("tasks"."b" > ? and "tasks"."c" in (?, ?))) and "tasks"."_status" is not 'deleted'`,
    )
    expect(args).toEqual([1, 2, 3, 4])
  })

  it('compiles between, notIn, like, includes and column comparisons', () => {
    expect(encodeQuery(tasks([Q.where('p', Q.between(1, 5))]))[0]).toContain(
      '"tasks"."p" between ? and ?',
    )
    expect(encodeQuery(tasks([Q.where('p', Q.notIn(['x']))]))[0]).toContain(
      '"tasks"."p" not in (?)',
    )
    expect(encodeQuery(tasks([Q.where('p', Q.oneOf([]))]))[0]).toContain(
      '"tasks"."p" in ()',
    )
    expect(encodeQuery(tasks([Q.where('name', Q.like('a%'))]))[0]).toContain(
      `"tasks"."name" like ? escape '\\'`,
    )
    expect(encodeQuery(tasks([Q.where('name', Q.includes('x'))]))[0]).toContain(
      'instr("tasks"."name", ?) > 0',
    )
    expect(
      encodeQuery(tasks([Q.where('updated_at', Q.gt(Q.column('created_at')))]))[0],
    ).toContain('"tasks"."updated_at" > "tasks"."created_at"')
  })

  it('compiles sort, take and skip', () => {
    const [sql, args] = encodeQuery(
      tasks([Q.sortBy('position', Q.desc), Q.sortBy('id'), Q.take(10), Q.skip(20)]),
    )
    expect(sql).toBe(
      `select "tasks".* from "tasks" where "tasks"."_status" is not 'deleted' order by "tasks"."position" desc, "tasks"."id" asc limit ? offset ?`,
    )
    expect(args).toEqual([10, 20])
  })

  it('compiles Q.on to a left join with the deleted filter in the join condition', () => {
    expect(
      encodeQuery(tasks([Q.on('projects', 'is_archived', false)], [belongsToProjects])),
    ).toEqual([
      `select "tasks".* from "tasks" left join "projects" on "projects"."id" = "tasks"."project_id" and "projects"."_status" is not 'deleted' where "projects"."is_archived" is ? and "tasks"."_status" is not 'deleted'`,
      [false],
    ])
  })

  it('uses distinct for has_many joins, in select and count', () => {
    const query = tasks([Q.on('comments', 'body', Q.notEq(null))], [hasManyComments])
    expect(encodeQuery(query)[0]).toContain('select distinct "tasks".*')
    expect(encodeQuery(query, { mode: 'count' })[0]).toContain(
      'select count(distinct "tasks"."id") as "count"',
    )
  })

  it('compiles count mode without to-many joins as count(*)', () => {
    expect(encodeQuery(tasks([Q.where('a', 1)]), { mode: 'count' })[0]).toBe(
      `select count(*) as "count" from "tasks" where "tasks"."a" is ? and "tasks"."_status" is not 'deleted'`,
    )
  })

  it('passes unsafeSqlQuery through with its bound values', () => {
    expect(
      encodeQuery(tasks([Q.unsafeSqlQuery('select * from tasks where x = ?', [1])])),
    ).toEqual(['select * from tasks where x = ?', [1]])
  })

  it('rejects invalid combinations', () => {
    expect(() =>
      encodeQuery(tasks([Q.take(1), Q.where('a', 1)]), { mode: 'count' }),
    ).toThrow('not supported in count mode')
    expect(() =>
      encodeQuery(tasks([Q.unsafeSqlQuery('select 1')]), { mode: 'count' }),
    ).toThrow('cannot count')
    expect(() => encodeQuery(tasks([Q.on('projects', 'a', 1)]))).toThrow(
      "no association from 'tasks' to 'projects'",
    )
    expect(() =>
      encodeQuery(tasks([Q.and(Q.on('projects', 'a', 1))], [belongsToProjects])),
    ).toThrow("nested Q.on('projects') requires")
    expect(() =>
      encodeQuery(tasks([Q.nestedJoin('projects', 'teams')])),
    ).toThrow("nested join from 'projects' — table is not itself joined")
  })

  it('allows nested Q.on when the join is declared', () => {
    const [sql, args] = encodeQuery(
      tasks(
        [
          Q.joinTables(['projects']),
          Q.or(Q.where('is_done', true), Q.on('projects', 'is_archived', false)),
        ],
        [belongsToProjects],
      ),
    )
    expect(sql).toContain('left join "projects"')
    expect(sql).toContain(
      '("tasks"."is_done" is ? or "projects"."is_archived" is ?)',
    )
    expect(args).toEqual([true, false])
  })
})
