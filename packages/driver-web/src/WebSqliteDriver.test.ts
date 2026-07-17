/**
 * Web-driver-specific behavior. The full driver contract, query corpus,
 * matcher agreement, schema and record suites run via conformance.test.ts
 * (@remelondb/driver-conformance) against the same in-process
 * real-sqlite-wasm setup.
 */
import { describe, expect, it } from 'vitest'
import {
  appSchema,
  Database,
  ModelFor,
  Q,
  synchronize,
  column as c,
  table,
} from '@remelondb/core'
import { serveSqliteWorker } from './server'
import { createChannel, createInProcessDriver } from './testing'
import { WebSqliteDriver } from './WebSqliteDriver'
import sqlite3InitModule from '@sqlite.org/sqlite-wasm'

describe('web driver specifics', () => {
  it('refuses OPFS storage loudly when unavailable (no silent downgrade)', async () => {
    const [driverSide, serverSide] = createChannel()
    serveSqliteWorker(serverSide, () => sqlite3InitModule())
    const driver = new WebSqliteDriver({ createEndpoint: () => driverSide })
    await expect(driver.open('app.db')).rejects.toThrow(/OPFS storage is unavailable/)
  })
})

describe('full stack on the web driver', () => {
  const tasksTable = table('tasks', {
    name: c.string(),
    is_done: c.boolean(),
  })
  const schema = appSchema({ version: 1, tables: [tasksTable] })

  class Task extends ModelFor(tasksTable) {}

  it('Database + models + observation + sync work end to end', async () => {
    const db = await Database.open({
      driver: createInProcessDriver(),
      schema,
      modelClasses: [Task],
      name: 'app.db',
    })

    const emissions: Task[][] = []
    db.get(Task)
      .query(Q.where('is_done', false))
      .observe((records) => emissions.push(records))
    await new Promise((resolve) => setTimeout(resolve, 20)) // initial fetch

    const task = await db.write(() =>
      db.get(Task).create({ id: 't1', name: 'web works', is_done: false }),
    )
    expect(task.name).toBe('web works')
    await db.write(() => task.update(() => (task.is_done = true)))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(emissions.map((records) => records.length)).toEqual([0, 1, 0])

    let pushed: unknown
    await synchronize({
      database: db,
      pullChanges: async () => ({ changes: {}, cursor: '1' }),
      pushChanges: async ({ changes }) => {
        pushed = changes['tasks']?.created[0]
        return { cursor: '2', changes: {} }
      },
    })
    expect(pushed).toEqual({ id: 't1', name: 'web works', is_done: true })
    expect(task.syncStatus).toBe('synced')
  })
})
