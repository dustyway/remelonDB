/**
 * The sync engine end to end against a fake rev-cursor backend and real
 * SQLite: first sync, push/no-echo, per-column conflict resolution,
 * delete conflicts, the equality gate, conflict retries, rejections,
 * resync replacement, and the two-sync collision guard.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appSchema,
  Database,
  hasUnsyncedChanges,
  synchronize,
  tableSchema,
  CURSOR_KEY,
  type DirtyRaw,
  type SyncChanges,
  type SyncPullArgs,
  type SyncPullResult,
  type SyncPushArgs,
  type SyncPushResult,
} from '@watermelon-rewrite/core'
import { NodeSqliteDriver } from './NodeSqliteDriver'

const schema = appSchema({
  version: 1,
  tables: [
    tableSchema({
      name: 'tasks',
      columns: [
        { name: 'name', type: 'string' },
        { name: 'position', type: 'number' },
      ],
    }),
  ],
})

/** Minimal conforming backend: commit-ordered rev cursor, one table. */
class FakeServer {
  rev = 0
  docs = new Map<string, { fields: DirtyRaw; rev: number; deleted: boolean }>()
  pullCalls = 0
  pushCalls = 0

  seed(id: string, fields: DirtyRaw): void {
    this.docs.set(id, { fields: { ...fields, id }, rev: ++this.rev, deleted: false })
  }

  changesSince(cursor: number, exclude?: Set<string>): SyncChanges {
    const created: DirtyRaw[] = []
    const updated: DirtyRaw[] = []
    const deleted: string[] = []
    for (const [id, doc] of this.docs) {
      if (doc.rev <= cursor || exclude?.has(id)) {
        continue
      }
      if (doc.deleted) {
        deleted.push(id)
      } else if (cursor === 0) {
        created.push(doc.fields)
      } else {
        updated.push(doc.fields)
      }
    }
    return { tasks: { created, updated, deleted } }
  }

  pull = async (args: SyncPullArgs): Promise<SyncPullResult> => {
    this.pullCalls++
    const cursor = args.cursor === null ? 0 : Number(args.cursor)
    return { changes: this.changesSince(cursor), cursor: String(this.rev) }
  }

  push = async (args: SyncPushArgs): Promise<SyncPushResult> => {
    this.pushCalls++
    const cursor = Number(args.cursor)
    const table = args.changes['tasks']
    if (!table) {
      return { cursor: String(this.rev), changes: { tasks: { created: [], updated: [], deleted: [] } } }
    }
    // conflict detection: any pushed record modified after the cursor
    const pushedIds = [
      ...table.created.map((r) => r['id'] as string),
      ...table.updated.map((r) => r['id'] as string),
      ...table.deleted,
    ]
    for (const id of pushedIds) {
      const doc = this.docs.get(id)
      if (doc && doc.rev > cursor) {
        return { conflict: true }
      }
    }
    const interleaved = this.changesSince(cursor, new Set(pushedIds))
    for (const record of [...table.created, ...table.updated]) {
      const id = record['id'] as string
      this.docs.set(id, { fields: { ...record }, rev: ++this.rev, deleted: false })
    }
    for (const id of table.deleted) {
      this.docs.set(id, { fields: { id }, rev: ++this.rev, deleted: true })
    }
    return { cursor: String(this.rev), changes: interleaved }
  }
}

describe('sync engine', () => {
  let driver: NodeSqliteDriver
  let db: Database
  let server: FakeServer

  const sync = (extra: Partial<Parameters<typeof synchronize>[0]> = {}) =>
    synchronize({
      database: db,
      pullChanges: server.pull,
      pushChanges: server.push,
      ...extra,
    })

  beforeEach(async () => {
    driver = new NodeSqliteDriver()
    db = await Database.open({ driver, schema, name: ':memory:' })
    server = new FakeServer()
  })

  afterEach(async () => {
    await driver.destroy().catch(() => {})
  })

  it('first sync pulls everything as synced records', async () => {
    server.seed('t1', { name: 'from server', position: 1 })
    await sync()

    const record = await db.get('tasks').find('t1')
    expect(record['name']).toBe('from server')
    expect(record._status).toBe('synced')
    expect(await db.localStorage.get(CURSOR_KEY)).toBe('1')
  })

  it('pushes local changes, marks them synced, and never re-receives its own writes', async () => {
    await db.write(() => db.get('tasks').create({ id: 't1', name: 'local' }))
    await sync()

    expect(server.docs.get('t1')?.fields['name']).toBe('local')
    const record = await db.get('tasks').find('t1')
    expect(record._status).toBe('synced')
    expect(record._changed).toBe('')
    // the push response advanced the cursor past our own write:
    expect(await db.localStorage.get(CURSOR_KEY)).toBe(String(server.rev))
    // …so the next pull is empty (no echo)
    const pulled = await server.pull({
      cursor: await db.localStorage.get(CURSOR_KEY),
      schemaVersion: 1,
      migration: null,
    })
    expect('changes' in pulled && pulled.changes['tasks']).toEqual({
      created: [],
      updated: [],
      deleted: [],
    })
  })

  it('wire records never contain _status/_changed', async () => {
    await db.write(() => db.get('tasks').create({ id: 't1', name: 'x' }))
    let pushed: DirtyRaw | undefined
    await sync({
      pushChanges: async (args) => {
        pushed = args.changes['tasks']?.created[0]
        return server.push(args)
      },
    })
    expect(pushed).toEqual({ id: 't1', name: 'x', position: 0 })
  })

  it('resolves conflicts per column: local wins for changed columns only', async () => {
    server.seed('t1', { name: 'server name', position: 1 })
    await sync()

    // local edit to name only
    await db.write(() => db.get('tasks').update('t1', { name: 'local name' }))
    // concurrent server edit to position (and name, which local should win)
    server.seed('t1', { name: 'server name 2', position: 99 })

    const record = await db.get('tasks').find('t1')
    await sync()
    expect(record['name']).toBe('local name') // locally changed → local wins
    expect(record['position']).toBe(99) // untouched locally → server wins
    // and the merged record was pushed back:
    expect(server.docs.get('t1')?.fields).toEqual({
      id: 't1',
      name: 'local name',
      position: 99,
    })
    expect(record._status).toBe('synced')
  })

  it('remote deletion wins over local changes; local deletion wins over remote update', async () => {
    server.seed('a', { name: 'a', position: 1 })
    server.seed('b', { name: 'b', position: 2 })
    await sync()

    await db.write(async () => {
      await db.get('tasks').update('a', { name: 'locally changed' })
      await db.get('tasks').markAsDeleted('b')
    })
    server.docs.set('a', { fields: { id: 'a' }, rev: ++server.rev, deleted: true })
    server.seed('b', { name: 'b updated remotely', position: 2 })

    await sync()
    // remote delete of 'a' destroyed it despite local changes
    await expect(db.get('tasks').find('a')).rejects.toThrow('not found')
    // local tombstone of 'b' survived the remote update and was pushed
    expect(server.docs.get('b')?.deleted).toBe(true)
    expect(await driver.query('select * from tasks', [])).toEqual([])
  })

  it('records modified during the push stay dirty (equality gate)', async () => {
    await db.write(() => db.get('tasks').create({ id: 't1', name: 'v1' }))
    await sync({
      pushChanges: async (args) => {
        const result = await server.push(args)
        // a write lands while the push response is in flight
        await db.write(() => db.get('tasks').update('t1', { name: 'v2' }))
        return result
      },
    })
    const record = await db.get('tasks').find('t1')
    expect(record._status).not.toBe('synced') // stayed dirty
    expect(await hasUnsyncedChanges(db)).toBe(true)

    await sync()
    expect(record._status).toBe('synced')
    expect(server.docs.get('t1')?.fields['name']).toBe('v2')
  })

  it('retries push conflicts by re-pulling, bounded', async () => {
    server.seed('t1', { name: 'server', position: 1 })
    await sync()
    await db.write(() => db.get('tasks').update('t1', { name: 'local' }))

    // a server-side write lands between our pull and our push → the first
    // push conflicts; the retry pulls it, merges, and pushes clean
    let seeded = false
    await sync({
      pullChanges: async (args) => {
        const result = await server.pull(args)
        if (!seeded) {
          seeded = true
          server.seed('t1', { name: 'server 2', position: 7 })
        }
        return result
      },
    })
    expect(server.pushCalls).toBe(2) // conflict, re-pull, merged push
    const record = await db.get('tasks').find('t1')
    expect(record['name']).toBe('local')
    expect(record['position']).toBe(7)
    expect(record._status).toBe('synced')
  })

  it('gives up after bounded conflict retries', async () => {
    await db.write(() => db.get('tasks').create({ id: 't1' }))
    await expect(
      sync({
        pushChanges: async () => ({ conflict: true }),
        conflictRetries: 2,
      }),
    ).rejects.toThrow('after 2 attempts')
  })

  it('rejected records stay dirty', async () => {
    await db.write(async () => {
      await db.get('tasks').create({ id: 'ok', name: 'fine' })
      await db.get('tasks').create({ id: 'bad', name: 'rejected' })
    })
    await sync({
      pushChanges: async (args) => {
        const result = await server.push(args)
        if ('conflict' in result) {
          return result
        }
        return { ...result, rejected: { tasks: ['bad'] } }
      },
    })
    expect((await db.get('tasks').find('ok'))._status).toBe('synced')
    expect((await db.get('tasks').find('bad'))._status).toBe('created')
  })

  it('resyncRequired re-pulls from scratch and reconciles (replacement)', async () => {
    server.seed('keep', { name: 'kept', position: 1 })
    server.seed('gone', { name: 'gone', position: 2 })
    await sync()
    await db.write(() => db.get('tasks').create({ id: 'dirty', name: 'local only' }))

    // server pruned its history: 'gone' disappeared entirely
    server.docs.delete('gone')
    let first = true
    await sync({
      pullChanges: async (args) => {
        if (first && args.cursor !== null) {
          first = false
          return { resyncRequired: true }
        }
        return server.pull(args)
      },
    })

    expect((await db.get('tasks').find('keep'))._status).toBe('synced')
    await expect(db.get('tasks').find('gone')).rejects.toThrow('not found') // synced+absent → destroyed
    expect(server.docs.get('dirty')?.fields['name']).toBe('local only') // dirty survived & pushed
  })

  it('aborts when another sync commits during the pull', async () => {
    server.seed('t1', { name: 'x', position: 1 })
    await expect(
      sync({
        pullChanges: async (args) => {
          // a competing sync finishes while our pull is in flight
          await db.localStorage.set(CURSOR_KEY, '999')
          return server.pull(args)
        },
        pushChanges: undefined as never,
      }),
    ).rejects.toThrow('another synchronize()')
  })

  it('degraded push (cursor: null) leaves the echo to be absorbed by the next pull', async () => {
    await db.write(() => db.get('tasks').create({ id: 't1', name: 'x' }))
    await sync({
      pushChanges: async (args) => {
        const result = await server.push(args)
        return { ...result, cursor: null, changes: null }
      },
    })
    expect((await db.get('tasks').find('t1'))._status).toBe('synced')
    // cursor was NOT advanced → next pull returns the echo…
    await sync()
    // …which apply absorbs without disturbing the record
    const record = await db.get('tasks').find('t1')
    expect(record._status).toBe('synced')
    expect(record['name']).toBe('x')
  })
})
