import { describe, expect, it } from 'vitest'
import { appSchema, column as c, table } from './index'
import {
  addColumns,
  createTable,
  schemaMigrations,
  stepsForMigration,
  unsafeExecuteSql,
} from './migrations'
import { encodeMigrationSteps, encodeSchema } from './encodeSchema'

const tasksTable = table('tasks', {
  name: c.string(),
  position: c.number().indexed(),
  project_id: c.string().optional(),
})

describe('schema construction', () => {
  it('builds and indexes tables', () => {
    expect(tasksTable.columns['position']?.isIndexed).toBe(true)
    expect(tasksTable.columns['project_id']?.isOptional).toBe(true)
    expect(tasksTable.columnArray.map((col) => col.name)).toEqual([
      'name',
      'position',
      'project_id',
    ])
    const schema = appSchema({ version: 1, tables: [tasksTable] })
    expect(schema.tables['tasks']).toBe(tasksTable)
    expect(Object.isFrozen(schema)).toBe(true)
  })

  it('column builders are immutable values', () => {
    const base = c.string()
    const optional = base.optional()
    expect(base.isOptional).toBe(false)
    expect(optional.isOptional).toBe(true)
    expect(optional.indexed()).not.toBe(optional)
    // one builder value can be reused across columns safely
    const t = table('t', { a: base, b: base })
    expect(t.columns['a']?.name).toBe('a')
    expect(t.columns['b']?.name).toBe('b')
  })

  it('rejects invalid schemas', () => {
    // duplicate columns are impossible by construction now (object keys);
    // reserved names and created_at/updated_at rules still throw
    expect(() => table('tasks', { id: c.string() })).toThrow('reserved')
    expect(() => table('tasks', { RowId: c.string() })).toThrow('reserved')
    expect(() => table('local_storage', {})).toThrow('reserved')
    expect(() => table('tasks', { created_at: c.string() })).toThrow(
      'non-optional number',
    )
    expect(() =>
      table('tasks', { created_at: c.number().optional() }),
    ).toThrow('non-optional number')
    expect(() => appSchema({ version: 0, tables: [] })).toThrow('positive integer')
    expect(() =>
      appSchema({ version: 1, tables: [tasksTable, tasksTable] }),
    ).toThrow('more than once')
  })

  it('encodes schema DDL with standard columns and indices', () => {
    const statements = encodeSchema(appSchema({ version: 1, tables: [tasksTable] }))
    expect(statements).toEqual([
      `create table "local_storage" ("key" primary key not null, "value")`,
      `create table "tasks" ("id" primary key, "_changed", "_status", "name", "position", "project_id")`,
      `create index if not exists "tasks_position" on "tasks" ("position")`,
      `create index if not exists "tasks__status" on "tasks" ("_status")`,
    ])
  })
})

describe('migrations', () => {
  const migrations = schemaMigrations({
    migrations: [
      {
        toVersion: 2,
        steps: [
          addColumns({
            table: 'tasks',
            columns: {
              priority: c.number(),
              note: c.string().optional(),
            },
          }),
        ],
      },
      {
        toVersion: 3,
        steps: [
          createTable({
            name: 'tags',
            columns: { label: c.string().indexed() },
          }),
          unsafeExecuteSql(`update "tasks" set "priority" = 1`),
        ],
      },
    ],
  })

  it('computes version bounds', () => {
    expect(migrations.minVersion).toBe(1)
    expect(migrations.maxVersion).toBe(3)
  })

  it('validates migration lists', () => {
    expect(() => schemaMigrations({ migrations: [] })).toThrow('at least one')
    expect(() =>
      schemaMigrations({ migrations: [{ toVersion: 1, steps: [] }] }),
    ).toThrow('>= 2')
    expect(() =>
      schemaMigrations({
        migrations: [
          { toVersion: 2, steps: [] },
          { toVersion: 4, steps: [] },
        ],
      }),
    ).toThrow('contiguous')
  })

  it('selects steps for a range, or null when uncovered', () => {
    expect(stepsForMigration(migrations, { from: 1, to: 3 })).toHaveLength(3)
    expect(stepsForMigration(migrations, { from: 2, to: 3 })).toHaveLength(2)
    expect(stepsForMigration(migrations, { from: 0, to: 3 })).toBeNull()
    expect(stepsForMigration(migrations, { from: 1, to: 4 })).toBeNull()
    expect(stepsForMigration(migrations, { from: 3, to: 3 })).toBeNull()
  })

  it('encodes migration steps to DDL', () => {
    const steps = stepsForMigration(migrations, { from: 1, to: 3 })!
    expect(encodeMigrationSteps(steps)).toEqual([
      `alter table "tasks" add "priority" default 0`,
      `alter table "tasks" add "note" default null`,
      `create table "tags" ("id" primary key, "_changed", "_status", "label")`,
      `create index if not exists "tags_label" on "tags" ("label")`,
      `create index if not exists "tags__status" on "tags" ("_status")`,
      `update "tasks" set "priority" = 1`,
    ])
  })
})
