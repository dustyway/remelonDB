/**
 * The Model layer end to end: declare-field accessors, update builders,
 * identity, relations, observation, timestamps, and interplay with sync.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appSchema,
  Database,
  Model,
  Q,
  synchronize,
  tableSchema,
  type AssociationsMap,
  type SyncPullArgs,
  type SyncPullResult,
} from '@watermelon-rewrite/core'
import { NodeSqliteDriver } from './NodeSqliteDriver'

const schema = appSchema({
  version: 1,
  tables: [
    tableSchema({
      name: 'tasks',
      columns: [
        { name: 'name', type: 'string' },
        { name: 'is_done', type: 'boolean' },
        { name: 'project_id', type: 'string', isOptional: true },
        { name: 'created_at', type: 'number' },
        { name: 'updated_at', type: 'number' },
      ],
    }),
    tableSchema({
      name: 'projects',
      columns: [{ name: 'name', type: 'string' }],
    }),
  ],
})

class Task extends Model {
  static override readonly table = 'tasks'
  static override readonly associations = {
    projects: { type: 'belongs_to', key: 'project_id' },
  } satisfies AssociationsMap

  declare name: string
  declare is_done: boolean
  declare project_id: string | null
  declare created_at: number
  declare updated_at: number
}

class Project extends Model {
  static override readonly table = 'projects'
  static override readonly associations = {
    tasks: { type: 'has_many', foreignKey: 'project_id' },
  } satisfies AssociationsMap

  declare name: string
}

describe('Model layer', () => {
  let driver: NodeSqliteDriver
  let db: Database

  beforeEach(async () => {
    driver = new NodeSqliteDriver()
    db = await Database.open({
      driver,
      schema,
      modelClasses: [Task, Project],
      name: ':memory:',
    })
  })

  afterEach(async () => {
    await driver.destroy().catch(() => {})
  })

  it('creates typed models with generated accessors and timestamps', async () => {
    const before = Date.now()
    const task = await db.write(() =>
      db.get<Task>('tasks').create({ name: 'write models', is_done: false }),
    )
    expect(task).toBeInstanceOf(Task)
    expect(task.name).toBe('write models')
    expect(task.is_done).toBe(false)
    expect(task.created_at).toBeGreaterThanOrEqual(before)
    expect(task.updated_at).toBe(task.created_at)
    expect(task.syncStatus).toBe('created')
  })

  it('maintains model identity across find/query/create', async () => {
    const created = await db.write(() =>
      db.get<Task>('tasks').create({ id: 't1', name: 'a' }),
    )
    const found = await db.get<Task>('tasks').find('t1')
    const [queried] = await db.get<Task>('tasks').query().fetch()
    expect(found).toBe(created)
    expect(queried).toBe(created)
  })

  it('records are read-only outside update()', async () => {
    const task = await db.write(() => db.get<Task>('tasks').create({ name: 'x' }))
    expect(() => {
      task.name = 'nope'
    }).toThrow("outside of update()")
  })

  it('update() builder writes through sanitize + dirty tracking and touches updated_at', async () => {
    const task = await db.write(() =>
      db.get<Task>('tasks').create({ id: 't1', name: 'v1' }),
    )
    const createdAt = task.updated_at
    await new Promise((resolve) => setTimeout(resolve, 5))

    await db.write(() =>
      task.update(() => {
        task.name = 'v2'
        expect(task.name).toBe('v2') // builder sees pending value
      }),
    )
    expect(task.name).toBe('v2')
    expect(task.updated_at).toBeGreaterThan(createdAt)

    const rows = await driver.query('select "name" from tasks', [])
    expect(rows[0]?.['name']).toBe('v2')
  })

  it('builder writes are sanitized like any other write', async () => {
    const task = await db.write(() => db.get<Task>('tasks').create({ name: 'x' }))
    await db.write(() =>
      task.update(() => {
        task.is_done = 1 as never // storage representation in…
      }),
    )
    expect(task.is_done).toBe(true) // …real boolean out
  })

  it('navigates belongs_to and has_many associations', async () => {
    const { project, task, orphan } = await db.write(async () => {
      const project = await db.get<Project>('projects').create({ id: 'p1', name: 'proj' })
      const task = await db
        .get<Task>('tasks')
        .create({ id: 't1', name: 'a', project_id: 'p1' })
      const orphan = await db.get<Task>('tasks').create({ id: 't2', name: 'b' })
      return { project, task, orphan }
    })

    expect(await task.related<Project>('projects')).toBe(project)
    expect(await orphan.related<Project>('projects')).toBeNull()

    const children = await project.children<Task>('tasks').fetch()
    expect(children).toEqual([task])

    // model associations feed the query compiler too
    const viaJoin = await db
      .get<Task>('tasks')
      .query(Q.on('projects', 'name', 'proj'))
      .fetch()
    expect(viaJoin).toEqual([task])
  })

  it('observes a single record until deletion', async () => {
    const task = await db.write(() => db.get<Task>('tasks').create({ id: 't1' }))
    const emissions: (Task | null)[] = []
    const unsubscribe = task.observe((record) => emissions.push(record))
    expect(emissions).toEqual([task])

    await db.write(() => task.update(() => (task.name = 'renamed')))
    expect(emissions).toEqual([task, task])

    await db.write(() => task.markAsDeleted())
    expect(emissions).toEqual([task, task, null])
    unsubscribe()
  })

  it('query.observe emits model instances', async () => {
    const emissions: Task[][] = []
    const unsubscribe = db
      .get<Task>('tasks')
      .query(Q.where('is_done', false))
      .observe((records) => emissions.push(records))
    await new Promise((resolve) => setTimeout(resolve, 10))

    const task = await db.write(() =>
      db.get<Task>('tasks').create({ is_done: false }),
    )
    expect(emissions).toEqual([[], [task]])
    expect(emissions[1]?.[0]).toBeInstanceOf(Task)
    unsubscribe()
  })

  it('rejects model classes whose columns collide with the Model API', async () => {
    const badSchema = appSchema({
      version: 1,
      tables: [
        tableSchema({ name: 'bads', columns: [{ name: 'update', type: 'string' }] }),
      ],
    })
    class Bad extends Model {
      static override readonly table = 'bads'
    }
    const d = new NodeSqliteDriver()
    await expect(
      Database.open({ driver: d, schema: badSchema, modelClasses: [Bad], name: ':memory:' }),
    ).rejects.toThrow("conflicts with a property")
    await d.destroy().catch(() => {})
  })

  it('sync updates flow into existing model instances', async () => {
    const task = await db.write(() =>
      db.get<Task>('tasks').create({ id: 't1', name: 'local', is_done: false }),
    )
    const pullChanges = async (_args: SyncPullArgs): Promise<SyncPullResult> => ({
      changes: {
        tasks: {
          created: [],
          updated: [
            { id: 't1', name: 'from server', is_done: true, project_id: null, created_at: 1, updated_at: 2 },
          ],
          deleted: [],
        },
      },
      cursor: '1',
    })
    // record is dirty (created) — but first sync: push marks it synced
    await synchronize({
      database: db,
      pullChanges,
      pushChanges: async () => ({ cursor: null, changes: null }),
    })
    await synchronize({ database: db, pullChanges })

    expect(task.name).toBe('from server') // same instance, server value
    expect(task.is_done).toBe(true)
  })
})
