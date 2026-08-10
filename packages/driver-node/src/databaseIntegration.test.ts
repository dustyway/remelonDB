/**
 * The Database core end to end on real SQLite: two-phase init and
 * migrations, writer-gated CRUD with dirty tracking, identity-map
 * semantics, the batch failure contract, both observation strategies,
 * and local storage.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addColumns,
  appSchema,
  Database,
  Q,
  schemaMigrations,
  column as c,
  table,
  type ObservationDiagnostic,
  type QueryAssociation,
  type RawRecord,
} from '@remelondb/core'
import { NodeSqliteDriver } from './NodeSqliteDriver'

const schema = appSchema({
  version: 1,
  tables: [
    table('tasks', {
      name: c.string(),
      position: c.number().indexed(),
      is_done: c.boolean(),
      project_id: c.string().optional(),
    }),
    table('projects', {
      name: c.string(),
    }),
  ],
})

const associations: QueryAssociation[] = [
  { from: 'tasks', to: 'projects', info: { type: 'belongs_to', key: 'project_id' } },
]

describe('Database core', () => {
  let driver: NodeSqliteDriver
  let db: Database
  let diagnostics: ObservationDiagnostic[]

  beforeEach(async () => {
    driver = new NodeSqliteDriver()
    diagnostics = []
    db = await Database.open({
      driver,
      schema,
      associations,
      name: ':memory:',
      onObservation: (event) => diagnostics.push(event),
    })
  })

  afterEach(async () => {
    await driver.destroy().catch(() => {})
  })

  describe('setup and migrations', () => {
    const filePath = `${import.meta.dirname}/.tmp-database-test.db`

    afterEach(async () => {
      const cleanup = new NodeSqliteDriver()
      await cleanup.open(filePath).catch(() => null)
      await cleanup.destroy().catch(() => {})
    })

    it('migrates an existing database on open', async () => {
      const first = new NodeSqliteDriver()
      const dbV1 = await Database.open({ driver: first, schema, name: filePath })
      await dbV1.write(async () => {
        await dbV1.get('tasks').create({ id: 't1', name: 'pre', position: 1 })
      })
      await first.close()

      // v2 schema declares the current shape (incl. the new column); the
      // migration transforms old databases to it
      const schemaV2 = appSchema({
        version: 2,
        tables: [
          table('tasks', {
            name: c.string(),
            position: c.number().indexed(),
            is_done: c.boolean(),
            project_id: c.string().optional(),
            priority: c.number(),
          }),
          schema.tables['projects']!,
          table('tags', { label: c.string() }),
        ],
      })
      const migrations = schemaMigrations({
        migrations: [
          {
            toVersion: 2,
            steps: [
              addColumns({
                table: 'tasks',
                columns: { priority: c.number() },
              }),
            ],
          },
        ],
      })

      const second = new NodeSqliteDriver()
      const dbV2 = await Database.open({
        driver: second,
        schema: schemaV2,
        migrations,
        name: filePath,
      })
      const task = await dbV2.get('tasks').find('t1')
      expect(task['priority']).toBe(0) // backfilled
      expect(task['name']).toBe('pre')
      await second.close()
    })

    it('refuses to open without a migration path', async () => {
      const first = new NodeSqliteDriver()
      await Database.open({ driver: first, schema, name: filePath })
      await first.close()

      const schemaV3 = appSchema({ version: 3, tables: Object.values(schema.tables) })
      const second = new NodeSqliteDriver()
      await expect(
        Database.open({ driver: second, schema: schemaV3, name: filePath }),
      ).rejects.toThrow('no migration path')
      await second.close().catch(() => {})
    })
  })

  describe('CRUD and identity', () => {
    it('gates mutations behind write()', async () => {
      await expect(db.get('tasks').create({ name: 'x' })).rejects.toThrow(
        'inside database.write',
      )
      const record = await db.write(() => db.get('tasks').create({ name: 'x' }))
      expect(record._status).toBe('created')
    })

    it('maintains one instance per record (identity map)', async () => {
      const created = await db.write(() =>
        db.get('tasks').create({ id: 't1', name: 'a', position: 1 }),
      )
      const found = await db.get('tasks').find('t1')
      const [queried] = await db.get('tasks').query(Q.where('id', 't1')).fetch()
      expect(found).toBe(created)
      expect(queried).toBe(created)
    })

    it('updates in place; created records stay created and untracked', async () => {
      const created = await db.write(() =>
        db.get('tasks').create({ id: 't1', name: 'a', position: 1 }),
      )
      await db.write(() => db.get('tasks').update('t1', { name: 'b' }))
      expect(created['name']).toBe('b') // same instance, updated in place
      expect(created._status).toBe('created')
      expect(created._changed).toBe('')

      const rows = await driver.query('select "name", "_status" from tasks', [])
      expect(rows[0]).toEqual({ name: 'b', _status: 'created' })
    })

    it('tracks changed columns on synced records', async () => {
      await db.write(() =>
        db.get('tasks').create({ id: 't1', name: 'a', position: 1 }),
      )
      // flip to synced directly in storage, then re-open cache state
      await driver.execute(
        `update tasks set "_status" = 'synced' where "id" is ?`,
        ['t1'],
      )
      const record = await db.get('tasks').find('t1')
      record._status = 'synced' // cache holds pre-flip state; align it

      await db.write(() => db.get('tasks').update('t1', { name: 'b', position: 1 }))
      expect(record._status).toBe('updated')
      expect(record._changed).toBe('name') // position was unchanged → untracked
    })

    it('rejects updates to unknown columns', async () => {
      await db.write(() => db.get('tasks').create({ id: 't1' }))
      await expect(
        db.write(() => db.get('tasks').update('t1', { nope: 1 })),
      ).rejects.toThrow("unknown column 'tasks.nope'")
    })

    it('markAsDeleted hides the record but keeps a tombstone', async () => {
      await db.write(() => db.get('tasks').create({ id: 't1', name: 'a' }))
      await db.write(() => db.get('tasks').markAsDeleted('t1'))

      await expect(db.get('tasks').find('t1')).rejects.toThrow('not found')
      expect(await db.get('tasks').query().fetch()).toEqual([])

      const rows = await driver.query('select "_status" from tasks', [])
      expect(rows).toEqual([{ _status: 'deleted' }]) // tombstone remains
    })

    it('destroyPermanently removes the row', async () => {
      await db.write(() => db.get('tasks').create({ id: 't1' }))
      await db.write(() => db.get('tasks').destroyPermanently('t1'))
      expect(await driver.query('select * from tasks', [])).toEqual([])
    })
  })

  describe('batch failure contract', () => {
    it('leaves cache and subscribers untouched when the driver batch fails', async () => {
      await db.write(() => db.get('tasks').create({ id: 't1', name: 'a' }))
      let notified = 0
      db.get('tasks').onChange(() => notified++)

      await expect(
        db.write(() =>
          db.batch([
            db.get('tasks').prepareCreate({ id: 't2', name: 'ok' }),
            db.get('tasks').prepareCreate({ id: 't1', name: 'dup' }), // PK violation
          ]),
        ),
      ).rejects.toThrow()

      expect(notified).toBe(0)
      expect(db.get('tasks').cache.get('t2')).toBeUndefined()
      const rows = await driver.query('select "id" from tasks', [])
      expect(rows).toEqual([{ id: 't1' }]) // nothing committed
    })
  })

  // #7 option 2: batch() is the atomic unit, and the delete operations
  // get prepared builders so multi-record cascades can commit as ONE
  // transaction instead of a partial-failure-prone sequence.
  describe('atomic delete cascades', () => {
    it('a failed batch rolls back its delete operations too', async () => {
      await db.write(async () => {
        await db.get('tasks').create({ id: 'parent', name: 'p' })
        await db.get('tasks').create({ id: 'child', name: 'c' })
      })

      await expect(
        db.write(async () =>
          db.batch([
            db.get('tasks').prepareMarkAsDeleted(
              await db.get('tasks').find('child'),
            ),
            db.get('tasks').prepareMarkAsDeleted(
              await db.get('tasks').find('parent'),
            ),
            db.get('tasks').prepareCreate({ id: 'parent', name: 'dup' }), // PK violation
          ]),
        ),
      ).rejects.toThrow(/unique|constraint/i)

      // neither delete survived the failed transaction
      expect((await db.get('tasks').find('parent'))._status).not.toBe('deleted')
      expect((await db.get('tasks').find('child'))._status).not.toBe('deleted')
    })

    it('a cascade commits as one batch: one notification, tombstones kept', async () => {
      await db.write(async () => {
        await db.get('tasks').create({ id: 'parent', name: 'p' })
        await db.get('tasks').create({ id: 'c1', name: 'one' })
        await db.get('tasks').create({ id: 'c2', name: 'two' })
      })
      let bursts = 0
      db.get('tasks').onChange(() => bursts++)

      const tasks = db.get('tasks')
      const parent = await tasks.find('parent')
      const c1 = await tasks.find('c1')
      const c2 = await tasks.find('c2')
      await db.write(() =>
        db.batch([
          tasks.prepareMarkAsDeleted(c1),
          tasks.prepareMarkAsDeleted(c2),
          tasks.prepareDestroyPermanently(parent),
        ]),
      )

      expect(bursts).toBe(1)
      // tombstones for sync, hard delete really gone
      const rows = await driver.query('select "id", "_status" from tasks', [])
      expect(rows).toEqual(
        expect.arrayContaining([
          { id: 'c1', _status: 'deleted' },
          { id: 'c2', _status: 'deleted' },
        ]),
      )
      expect(rows).toHaveLength(2)
    })
  })

  describe('observation', () => {
    const flush = () => new Promise((resolve) => setTimeout(resolve, 10))

    it('reports opt-in query diagnostics without changing observation', async () => {
      const unsubscribe = db.get('tasks').query().observe(() => {})
      await flush()
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]).toMatchObject({
        kind: 'records',
        trigger: 'initial',
        outcome: 'success',
        table: 'tasks',
        resultCount: 0,
      })
      expect(diagnostics[0]!.durationMs).toBeGreaterThanOrEqual(0)

      await db.write(() => db.get('tasks').create({ id: 't1' }))
      await flush()
      expect(diagnostics.at(-1)).toMatchObject({
        kind: 'records',
        trigger: 'change',
        outcome: 'success',
        resultCount: 1,
      })
      unsubscribe()
    })

    it('delivers query failures and reports them to diagnostics', async () => {
      const failure = new Error('read failed')
      driver.query = async () => {
        throw failure
      }
      const errors: Error[] = []

      const unsubscribe = db.get('tasks').query().observe(
        () => {},
        (error) => errors.push(error),
      )
      await flush()

      expect(errors).toEqual([failure])
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]).toMatchObject({
        kind: 'records',
        trigger: 'initial',
        outcome: 'error',
        table: 'tasks',
        error: failure,
      })
      unsubscribe()
    })

    it('a throwing subscriber is an app bug: loud, never delivered to onError', async () => {
      const boom = new Error('subscriber bug')
      const errors: Error[] = []
      const unhandled: unknown[] = []
      // The throw must surface as an unhandled rejection, not as a query
      // error; capture it so the assertion can see it without failing the run.
      const prior = process.listeners('unhandledRejection')
      process.removeAllListeners('unhandledRejection')
      process.on('unhandledRejection', (reason) => unhandled.push(reason))
      try {
        const unsubscribe = db.get('tasks').query().observe(
          () => {
            throw boom
          },
          (error) => errors.push(error),
        )
        await flush()
        unsubscribe()
        expect(errors).toEqual([]) // not mislabeled as a query error
        expect(unhandled).toEqual([boom]) // still loud
        // Diagnostics saw one successful fetch and no error report.
        expect(diagnostics.map((d) => d.outcome)).toEqual(['success'])
      } finally {
        process.removeAllListeners('unhandledRejection')
        for (const listener of prior) process.on('unhandledRejection', listener)
      }
    })

    it('flat queries: membership and content changes emit, others do not', async () => {
      const emissions: RawRecord[][] = []
      const unsubscribe = db
        .get('tasks')
        .query(Q.where('is_done', false))
        .observe((records) => emissions.push(records))
      await flush()
      expect(emissions).toHaveLength(1)
      expect(emissions[0]).toEqual([])

      const t1 = await db.write(() =>
        db.get('tasks').create({ id: 't1', is_done: false }),
      )
      await flush()
      expect(emissions).toHaveLength(2)
      expect(emissions[1]).toEqual([t1])

      // non-matching create → refetch happens, emission doesn't
      await db.write(() => db.get('tasks').create({ id: 't2', is_done: true }))
      await flush()
      expect(emissions).toHaveLength(2)

      // content edit of a member → emission (same membership)
      await db.write(() => db.get('tasks').update('t1', { name: 'renamed' }))
      await flush()
      expect(emissions).toHaveLength(3)

      // update out of membership → emission
      await db.write(() => db.get('tasks').update('t1', { is_done: true }))
      await flush()
      expect(emissions).toHaveLength(4)
      expect(emissions[3]).toEqual([])

      unsubscribe()
      await db.write(() => db.get('tasks').create({ id: 't3', is_done: false }))
      await flush()
      expect(emissions).toHaveLength(4)
    })

    it('sorted queries re-fetch on relevant changes only', async () => {
      const emissions: string[][] = []
      const unsubscribe = db
        .get('tasks')
        .query(Q.sortBy('position', Q.desc))
        .observe((records) => emissions.push(records.map((r) => r.id)))
      await flush()
      expect(emissions).toEqual([[]])

      await db.write(async () => {
        await db.get('tasks').create({ id: 't1', position: 1 })
        await db.get('tasks').create({ id: 't2', position: 2 })
      })
      await flush()
      expect(emissions[emissions.length - 1]).toEqual(['t2', 't1'])

      // unrelated table → no re-emission
      const count = emissions.length
      await db.write(() => db.get('projects').create({ name: 'p' }))
      await flush()
      expect(emissions).toHaveLength(count)

      unsubscribe()
    })

    it('content edits of members re-emit; no-op writes do not', async () => {
      await db.write(() =>
        db.get('tasks').create({ id: 't1', name: 'a', is_done: false }),
      )
      const emissions: string[][] = []
      const unsubscribe = db
        .get('tasks')
        .query(Q.sortBy('position', Q.desc))
        .observe((records) =>
          emissions.push(records.map((r) => `${r.id}:${String(r['name'])}`)),
        )
      await flush()
      expect(emissions).toEqual([['t1:a']])

      // same membership, same order — only content changed
      await db.write(() => db.get('tasks').update('t1', { name: 'b' }))
      await flush()
      expect(emissions).toEqual([['t1:a'], ['t1:b']])

      // a write changing nothing visible → refetch happens, emission doesn't
      await db.write(() => db.get('tasks').update('t1', { name: 'b' }))
      await flush()
      expect(emissions).toHaveLength(2)

      unsubscribe()
    })

    it('join queries reload when the joined table changes', async () => {
      await db.write(async () => {
        await db.get('projects').create({ id: 'p1', name: 'proj' })
        await db.get('tasks').create({ id: 't1', project_id: 'p1' })
      })
      const emissions: string[][] = []
      const unsubscribe = db
        .get('tasks')
        .query(Q.on('projects', 'name', 'proj'))
        .observe((records) => emissions.push(records.map((r) => r.id)))
      await flush()
      expect(emissions).toEqual([['t1']])

      await db.write(() => db.get('projects').update('p1', { name: 'renamed' }))
      await flush()
      expect(emissions[emissions.length - 1]).toEqual([])

      unsubscribe()
    })

    it('observeCount emits on changes only', async () => {
      const counts: number[] = []
      const unsubscribe = db
        .get('tasks')
        .query(Q.where('is_done', false))
        .observeCount((count) => counts.push(count))
      await flush()
      await db.write(() => db.get('tasks').create({ id: 't1', is_done: false }))
      await flush()
      await db.write(() => db.get('tasks').create({ id: 't2', is_done: true }))
      await flush()
      expect(counts).toEqual([0, 1]) // the non-matching create emitted nothing

      unsubscribe()
    })
  })

  describe('local storage', () => {
    it('gets, sets, overwrites and removes string values', async () => {
      expect(await db.localStorage.get('cursor')).toBeNull()
      await db.localStorage.set('cursor', 'abc')
      expect(await db.localStorage.get('cursor')).toBe('abc')
      await db.localStorage.set('cursor', 'def')
      expect(await db.localStorage.get('cursor')).toBe('def')
      await db.localStorage.remove('cursor')
      expect(await db.localStorage.get('cursor')).toBeNull()
    })
  })
})
