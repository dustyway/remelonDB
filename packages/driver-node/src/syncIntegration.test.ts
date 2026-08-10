/**
 * The sync engine end to end against a fake rev-cursor backend and real
 * SQLite: first sync, push/no-echo, per-column conflict resolution,
 * delete conflicts, the equality gate, conflict retries, rejections,
 * resync replacement, and the two-sync collision guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appSchema,
  Database,
  hasUnsyncedChanges,
  synchronize,
  column as c,
  table,
  CURSOR_KEY,
  type DirtyRaw,
  type SyncChanges,
  type SyncPullArgs,
  type SyncPullResult,
  type SyncPushArgs,
  type SyncPushResult,
} from '@remelondb/core'
import { NodeSqliteDriver } from './NodeSqliteDriver'

const schema = appSchema({
  version: 1,
  tables: [
    table('tasks', {
      name: c.string(),
      position: c.number(),
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

  // Multi-tab sync ownership (docs/multi-tab.md): when the driver
  // exposes requestSyncTurn, synchronize runs only for the lease
  // holder — denied contexts return without touching the server.
  it('skips the run when the driver denies the sync turn', async () => {
    const turns: boolean[] = [false, true]
    ;(driver as { requestSyncTurn?: () => Promise<boolean> }).requestSyncTurn =
      async () => turns.shift() ?? true
    const pull = vi.fn(server.pull)
    const push = vi.fn(server.push)

    await sync({ pullChanges: pull, pushChanges: push }) // denied: no traffic
    expect(pull).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()

    await sync({ pullChanges: pull, pushChanges: push }) // granted: normal run
    expect(pull).toHaveBeenCalled()
  })

  it('first sync pulls everything as synced records', async () => {
    server.seed('t1', { name: 'from server', position: 1 })
    await sync()

    const record = await db.get('tasks').find('t1')
    expect(record['name']).toBe('from server')
    expect(record._status).toBe('synced')
    expect(await db.localStorage.get(CURSOR_KEY)).toBe('1')
  })

  it('validates untrusted pull results before applying them', async () => {
    const invalid = { changes: 'not a change set', cursor: '1' }
    const validatePullResult = vi.fn(() => {
      throw new Error('invalid pull response')
    })

    await expect(sync({
      pullChanges: async () => invalid as never,
      validatePullResult,
    })).rejects.toThrow('invalid pull response')

    expect(validatePullResult).toHaveBeenCalledWith(invalid)
    expect(await db.localStorage.get(CURSOR_KEY)).toBeNull()
  })

  it('validates the resync re-pull, not just the initial pull', async () => {
    server.seed('keep', { name: 'kept', position: 1 })
    await sync()

    // the re-pull after resyncRequired is a fresh untrusted response and
    // must pass through the same validator; a bad one leaves local state
    // (including the pre-resync cursor) untouched
    const cursorBefore = await db.localStorage.get(CURSOR_KEY)
    const invalid = { changes: null, cursor: 'x' }
    const validatePullResult = vi.fn((value: unknown) => {
      if (value === invalid) throw new Error('invalid resync response')
      return value as never
    })
    let first = true
    await expect(sync({
      pullChanges: async (args) => {
        if (first && args.cursor !== null) {
          first = false
          return { resyncRequired: true }
        }
        return invalid as never
      },
      validatePullResult,
    })).rejects.toThrow('invalid resync response')

    expect(validatePullResult).toHaveBeenCalledWith(invalid)
    expect(await db.localStorage.get(CURSOR_KEY)).toBe(cursorBefore)
    expect((await db.get('tasks').find('keep'))._status).toBe('synced')
  })

  it('validates untrusted push results before adopting them', async () => {
    await db.write(() => db.get('tasks').create({ id: 't1', name: 'local' }))
    const invalid = { cursor: '1' }
    const validatePushResult = vi.fn(() => {
      throw new Error('invalid push response')
    })

    await expect(sync({
      pushChanges: async () => invalid as never,
      validatePushResult,
    })).rejects.toThrow('invalid push response')

    expect(validatePushResult).toHaveBeenCalledWith(invalid)
    expect((await db.get('tasks').find('t1'))._status).toBe('created')
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

  /**
   * Regression tests for flaws found by the external adversarial review
   * (docs/external-sync-review.md) — originally pinned as it.fails
   * repros, flipped when the fixes landed.
   */
  describe('fixed flaws (regression tests)', () => {
    it(
      'replacement resync preserves offline deletes (review: confirmed flaw)',
      async () => {
        server.seed('a', { name: 'a', position: 1 })
        await sync()
        // offline delete — tombstone awaiting push
        await db.write(() => db.get('tasks').markAsDeleted('a'))

        // server demands a resync; its snapshot still contains 'a'
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

        // the tombstone must survive the rebuild and the delete must push
        await expect(db.get('tasks').find('a')).rejects.toThrow('not found')
        expect(server.docs.get('a')?.deleted).toBe(true)
      },
    )

    it(
      'large pulls are chunked past SQLite bound-parameter limits',
      async () => {
        const many = Array.from({ length: 40_000 }, (_, i) => ({
          id: `r${i}`,
          name: `record ${i}`,
          position: i,
        }))
        await expect(
          synchronize({
            database: db,
            pullChanges: async () => ({
              changes: { tasks: { created: many, updated: [], deleted: [] } },
              cursor: '1',
            }),
          }),
        ).resolves.toMatchObject({ pulled: 40_000 })
        expect(await db.get('tasks').query().fetchCount()).toBe(40_000)
      },
    )

    it(
      'sparse records from a nonconforming server are rejected, not defaulted',
      async () => {
        server.seed('t1', { name: 'local truth', position: 7 })
        await sync()
        // nonconforming server omits 'position' from the updated record;
        // today apply silently fills it with the schema default (0),
        // clobbering the local value — it must reject instead
        await expect(
          synchronize({
            database: db,
            pullChanges: async () => ({
              changes: {
                tasks: {
                  created: [],
                  updated: [{ id: 't1', name: 'server' }],
                  deleted: [],
                },
              },
              cursor: '99',
            }),
          }),
        ).rejects.toThrow(/missing|sparse|full record/i)
        expect((await db.get('tasks').find('t1'))['position']).toBe(7)
      },
    )

    it(
      'concurrent synchronize() calls coalesce into one run',
      async () => {
        server.seed('t1', { name: 'x', position: 1 })
        const results = await Promise.allSettled([sync(), sync()])
        expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
        expect(server.pullCalls).toBe(1) // joined, not re-run
        expect((await db.get('tasks').find('t1'))['name']).toBe('x')
      },
    )
  })

  // #9: synchronize() reports what happened instead of resolving void;
  // callers stop parsing log lines for control flow.
  describe('structured result', () => {
    it('reports a denied sync lease explicitly', async () => {
      ;(driver as { requestSyncTurn?: () => Promise<boolean> }).requestSyncTurn =
        async () => false

      const result = await sync()
      expect(result).toEqual({
        lease: 'unavailable',
        resynced: false,
        pulled: 0,
        pushed: 0,
        rejected: 0,
        retryCount: 0,
      })
    })

    it('counts pulled and pushed rows on a normal run', async () => {
      server.seed('s1', { name: 'server one', position: 1 })
      server.seed('s2', { name: 'server two', position: 2 })
      await db.write(() => db.get('tasks').create({ id: 'l1', name: 'local' }))

      const result = await sync()
      expect(result).toEqual({
        lease: 'acquired',
        resynced: false,
        pulled: 2,
        pushed: 1,
        rejected: 0,
        retryCount: 0,
      })
    })

    it('flags a server-demanded resync', async () => {
      server.seed('s1', { name: 'seeded', position: 1 })
      await sync()

      const resyncOnce = vi
        .fn(server.pull)
        .mockResolvedValueOnce({ resyncRequired: true })
      const result = await sync({ pullChanges: resyncOnce })
      expect(result.resynced).toBe(true)
      expect(result.lease).toBe('acquired')
    })

    it('separates accepted from rejected rows', async () => {
      await db.write(async () => {
        await db.get('tasks').create({ id: 'ok', name: 'fine' })
        await db.get('tasks').create({ id: 'bad', name: 'rejected' })
      })

      const rejectingPush = async (args: SyncPushArgs): Promise<SyncPushResult> => {
        const result = await server.push(args)
        if ('conflict' in result) return result
        return { ...result, rejected: { tasks: ['bad'] } }
      }
      const result = await sync({ pushChanges: rejectingPush })
      expect(result.pushed).toBe(1)
      expect(result.rejected).toBe(1)
    })

    it('counts conflict retries', async () => {
      await db.write(() => db.get('tasks').create({ id: 't1', name: 'mine' }))

      let conflicts = 1
      const conflictOnce = async (args: SyncPushArgs): Promise<SyncPushResult> => {
        if (conflicts-- > 0) return { conflict: true }
        return server.push(args)
      }
      const result = await sync({ pushChanges: conflictOnce })
      expect(result.retryCount).toBe(1)
      expect(result.pushed).toBe(1)
    })

    it('a pull-only run reports zero pushed', async () => {
      server.seed('s1', { name: 'seeded', position: 1 })
      const result = await synchronize({
        database: db,
        pullChanges: server.pull,
      })
      expect(result.pulled).toBe(1)
      expect(result.pushed).toBe(0)
    })
  })
})
