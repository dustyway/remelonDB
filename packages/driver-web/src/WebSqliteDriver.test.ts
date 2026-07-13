/**
 * The web driver against REAL sqlite-wasm, in-process: the same
 * SqliteWorkerServer that runs inside a browser Worker is wired to the
 * driver through an in-memory endpoint pair. This verifies the full
 * driver → RPC → wasm-SQLite path; only OPFS persistence itself is
 * browser-only (see README checklist).
 */
import { describe, expect, it } from 'vitest'
import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import {
  appSchema,
  Database,
  Model,
  Q,
  synchronize,
  tableSchema,
  encodeSchema,
} from '@watermelon-rewrite/core'
import type { Endpoint } from './protocol'
import { serveSqliteWorker } from './server'
import { WebSqliteDriver } from './WebSqliteDriver'

/** Paired endpoints delivering messages asynchronously, like postMessage. */
function createChannel(): [Endpoint, Endpoint] {
  const make = (peers: Array<(message: unknown) => void>): Endpoint => ({
    postMessage: (message) =>
      queueMicrotask(() => peers.forEach((listener) => listener(message))),
    addMessageListener: () => {
      throw new Error('wired below')
    },
  })
  const aListeners: Array<(m: unknown) => void> = []
  const bListeners: Array<(m: unknown) => void> = []
  const a = make(bListeners)
  const b = make(aListeners)
  return [
    { postMessage: a.postMessage, addMessageListener: (l) => aListeners.push(l) },
    { postMessage: b.postMessage, addMessageListener: (l) => bListeners.push(l) },
  ]
}

const init = sqlite3InitModule as (options?: {
  print?: (message: string) => void
  printErr?: (message: string) => void
}) => ReturnType<typeof sqlite3InitModule>
const sqlite3 = init({ print: () => {}, printErr: () => {} })

function createDriver(): WebSqliteDriver {
  const [driverSide, serverSide] = createChannel()
  serveSqliteWorker(serverSide, () => sqlite3)
  return new WebSqliteDriver({
    storage: 'memory', // OPFS needs a real browser worker
    createEndpoint: () => driverSide,
  })
}

describe('WebSqliteDriver on real sqlite-wasm', () => {
  it('opens a fresh database with user_version 0 and round-trips rows', async () => {
    const driver = createDriver()
    const { userVersion } = await driver.open('test.db')
    expect(userVersion).toBe(0)

    await driver.execute(
      'create table tasks ("id" primary key, "name", "is_done", "position")',
      [],
    )
    await driver.executeBatch([
      [
        'insert into tasks values (?, ?, ?, ?)',
        [
          ['t1', 'hello', true, 1.5],
          ['t2', null, false, 2],
        ],
      ],
    ])
    const rows = await driver.query(
      'select * from tasks where "is_done" is ? order by "position"',
      [true],
    )
    expect(rows).toEqual([{ id: 't1', name: 'hello', is_done: 1, position: 1.5 }])
    await driver.destroy()
  })

  it('rolls back the whole batch when one statement fails', async () => {
    const driver = createDriver()
    await driver.open('rollback.db')
    await driver.execute('create table t ("id" primary key)', [])
    await expect(
      driver.executeBatch([
        ['insert into t values (?)', [['a'], ['b']]],
        ['insert into t values (?)', [['a']]], // PK violation
      ]),
    ).rejects.toThrow()
    expect(await driver.query('select * from t', [])).toEqual([])
    await driver.destroy()
  })

  it('tracks user_version', async () => {
    const driver = createDriver()
    await driver.open('version.db')
    await driver.setUserVersion(7)
    expect(await driver.query('pragma user_version', [])).toEqual([
      { user_version: 7 },
    ])
    await driver.destroy()
  })

  it('rejects operations when not open and double-opens', async () => {
    const driver = createDriver()
    await expect(driver.query('select 1', [])).rejects.toThrow('not open')
    await driver.open('x.db')
    await expect(driver.open('y.db')).rejects.toThrow('already open')
    await driver.destroy()
  })

  it('refuses OPFS storage loudly when unavailable (no silent downgrade)', async () => {
    const [driverSide, serverSide] = createChannel()
    serveSqliteWorker(serverSide, () => sqlite3)
    const driver = new WebSqliteDriver({ createEndpoint: () => driverSide })
    await expect(driver.open('app.db')).rejects.toThrow(/OPFS storage is unavailable/)
  })
})

describe('full stack on the web driver', () => {
  const schema = appSchema({
    version: 1,
    tables: [
      tableSchema({
        name: 'tasks',
        columns: [
          { name: 'name', type: 'string' },
          { name: 'is_done', type: 'boolean' },
        ],
      }),
    ],
  })

  class Task extends Model {
    static override readonly table = 'tasks'
    declare name: string
    declare is_done: boolean
  }

  it('Database + models + observation + sync work end to end', async () => {
    const db = await Database.open({
      driver: createDriver(),
      schema,
      modelClasses: [Task],
      name: 'app.db',
    })

    const emissions: Task[][] = []
    db.get<Task>('tasks')
      .query(Q.where('is_done', false))
      .observe((records) => emissions.push(records))
    await new Promise((resolve) => setTimeout(resolve, 20)) // initial fetch

    const task = await db.write(() =>
      db.get<Task>('tasks').create({ id: 't1', name: 'web works', is_done: false }),
    )
    expect(task.name).toBe('web works')
    await db.write(() => task.update(() => (task.is_done = true)))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(emissions.map((records) => records.length)).toEqual([0, 1, 0])

    // sync: push the created record to a trivial backend
    let pushed: unknown
    await synchronize({
      database: db,
      pullChanges: async () => ({
        changes: {},
        cursor: '1',
      }),
      pushChanges: async ({ changes }) => {
        pushed = changes['tasks']?.created[0]
        return { cursor: '2', changes: {} }
      },
    })
    expect(pushed).toEqual({ id: 't1', name: 'web works', is_done: true })
    expect(task.syncStatus).toBe('synced')
  })

  it('schema DDL from encodeSchema runs on wasm SQLite', async () => {
    const driver = createDriver()
    await driver.open('ddl.db')
    await driver.executeBatch(encodeSchema(schema).map((sql) => [sql, [[]]]))
    const tables = await driver.query(
      `select name from sqlite_master where type = 'table' order by name`,
      [],
    )
    expect(tables.map((t) => t['name'])).toEqual(['local_storage', 'tasks'])
    await driver.destroy()
  })
})
