/**
 * Type-level pins for docs/schema-inferred-types.md: the three failure
 * modes the design eliminates must stay compile errors, and the inferred
 * shapes must stay exactly right. Runtime assertions here are minimal —
 * the point is that this file typechecks (and the @ts-expect-error lines
 * fail to compile if a regression re-allows them).
 */
import { describe, expect, it } from 'vitest'
import { column as c, table, type InferRecord } from './index'
import * as Q from '../query/Q'
import { ModelFor } from '../model/Model'

const tasks = table('tasks', {
  name: c.string(),
  position: c.number().indexed(),
  is_done: c.boolean(),
  project_id: c.string().optional(),
})

type TaskRecord = InferRecord<typeof tasks>

// Compile-time-only helpers
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B
  ? 1
  : 2
  ? true
  : false
const assertType = <_T extends true>(): void => undefined

describe('schema-inferred types', () => {
  it('infers exact field types from the table definition', () => {
    assertType<Equal<TaskRecord['name'], string>>()
    assertType<Equal<TaskRecord['position'], number>>()
    assertType<Equal<TaskRecord['is_done'], boolean>>()
    // optional column: | null, not | undefined
    assertType<Equal<TaskRecord['project_id'], string | null>>()
    assertType<Equal<TaskRecord['id'], string>>()
    // @ts-expect-error — _status is core-internal, not on app-facing records
    type Internal = TaskRecord['_status']
    expect(tasks.name).toBe('tasks')
  })

  it('model fields come from the schema, not declares', () => {
    class Task extends ModelFor(tasks) {}
    const t = null as unknown as Task
    assertType<Equal<typeof t.name, string>>()
    assertType<Equal<typeof t.project_id, string | null>>()
    const use = (): void => {
      // @ts-expect-error — misspelled/undeclared fields do not exist
      void t.nmae
    }
    void use
    expect(Task.table).toBe('tasks')
    expect(Task.schema).toBe(tasks)
  })

  it('typed collections reject misspelled Q columns', () => {
    // A stand-in for what db.get(tasks) produces; only types matter here
    type C = import('../database/Collection').Collection<
      TaskRecord,
      import('./index').ColumnName<typeof tasks>
    >
    const collection = null as unknown as C
    const use = (): void => {
      collection.query(Q.where('position', Q.gt(1)), Q.sortBy('name'))
      collection.query(Q.where('id', 'x'))
      // @ts-expect-error — 'nmae' is not a column of tasks
      collection.query(Q.where('nmae', 'x'))
      // @ts-expect-error — sortBy is checked too
      collection.query(Q.sortBy('positon'))
      // @ts-expect-error — and/or propagate column checking
      collection.query(Q.or(Q.where('name', 'a'), Q.where('nmae', 'b')))
    }
    void use
    expect(true).toBe(true)
  })
})
