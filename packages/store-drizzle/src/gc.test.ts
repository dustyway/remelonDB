import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { bigint, boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import type { SyncChanges, SyncPullResult } from '@remelondb/core'
import { createSyncEngine } from '@remelondb/server'
import { createDrizzleStore } from './store'
import type { DrizzleDb } from './store'

const tasks = pgTable('tasks', {
  id: text('id').primaryKey(),
  rev: bigint('rev', { mode: 'number' }).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  owner: text('owner').notNull(),
  name: text('name').notNull(),
  done: boolean('done').notNull(),
})

const ok = (result: SyncPullResult): { changes: SyncChanges; cursor: string } => {
  expect(result).not.toHaveProperty('resyncRequired')
  return result as { changes: SyncChanges; cursor: string }
}
const pullArgs = (cursor: string | null) => ({ cursor, schemaVersion: 1, migration: null })
const created = (rows: Record<string, unknown>[]): SyncChanges =>
  ({ tasks: { created: rows, updated: [], deleted: [] } }) as unknown as SyncChanges
const deleted = (ids: string[]): SyncChanges =>
  ({ tasks: { created: [], updated: [], deleted: ids } }) as unknown as SyncChanges

describe('gc and scrub', () => {
  it('scrubs tombstoned content, prunes below the floor, degrades old cursors', async () => {
    const client = new PGlite()
    await client.exec(`
      create sequence remelon_rev;
      create table remelon_sync_meta (key text primary key, value bigint not null);
      create table tasks (
        id text primary key,
        rev bigint not null,
        deleted_at timestamptz,
        owner text not null,
        name text not null,
        done boolean not null
      );
    `)
    const store = createDrizzleStore<string>({
      db: drizzle(client) as unknown as DrizzleDb,
      tables: {
        tasks: {
          table: tasks,
          id: tasks.id,
          rev: tasks.rev,
          deletedAt: tasks.deletedAt,
          scope: tasks.owner,
          scrub: { name: '' },
        },
      },
    })
    const engine = createSyncEngine({ store, tables: { tasks: {} } })
    const h = engine.as('scope-a')

    const empty = ok(await h.pull(pullArgs(null)))
    await h.push({
      changes: created([
        { id: 'keep', name: 'keep me', done: false },
        { id: 'gone', name: 'personal data', done: true },
      ]),
      cursor: empty.cursor,
    })
    const seeded = ok(await h.pull(pullArgs(null)))
    await h.push({ changes: deleted(['gone']), cursor: seeded.cursor })

    // erasure is immediate: content scrubbed in the same stroke as the tombstone
    const scrubbed = await client.query<{ name: string; deleted_at: unknown }>(
      `select name, deleted_at from tasks where id = 'gone'`,
    )
    expect(scrubbed.rows[0]!.name).toBe('')
    expect(scrubbed.rows[0]!.deleted_at).not.toBeNull()

    // the deletion still syncs before gc
    const synced = ok(await h.pull(pullArgs(seeded.cursor)))
    expect(synced.changes['tasks']?.deleted).toContain('gone')

    // gc prunes the tombstone and persists the floor
    await store.gc(Number(synced.cursor))
    const remaining = await client.query(`select id from tasks`)
    expect(remaining.rows.map((row) => (row as { id: string }).id)).toEqual(['keep'])

    // a cursor from before the floor degrades to resync...
    expect(await h.pull(pullArgs(seeded.cursor))).toHaveProperty('resyncRequired')
    // ...a cursor at the floor is still served incrementally
    ok(await h.pull(pullArgs(synced.cursor)))
    // ...and a full re-pull converges without the deleted record
    const rebuilt = ok(await h.pull(pullArgs(null)))
    const ids = [...(rebuilt.changes['tasks']?.created ?? []), ...(rebuilt.changes['tasks']?.updated ?? [])]
      .map((row) => String(row['id']))
    expect(ids).toEqual(['keep'])

    // the floor never lowers
    await store.gc(1)
    expect(await h.pull(pullArgs(seeded.cursor))).toHaveProperty('resyncRequired')
  }, 20_000)
})
