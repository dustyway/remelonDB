// The drizzle store's packed declarations: config shape and the
// SyncStore it produces stay compatible with the packed server engine.
import { createSyncEngine } from '@remelondb/server'
import { createDrizzleStore, drizzleSyncTable } from '@remelondb/store-drizzle'
import { pgTable, text, bigint, timestamp } from 'drizzle-orm/pg-core'

const decks = pgTable('decks', {
  id: text('id').primaryKey(),
  user_id: text('user_id').notNull(),
  title: text('title').notNull(),
  rev: bigint('rev', { mode: 'number' }).notNull(),
  deleted_at: timestamp('deleted_at'),
})

declare const db: Parameters<typeof createDrizzleStore>[0]['db']

const store = createDrizzleStore<string>({
  db,
  tables: {
    decks: drizzleSyncTable({
      table: decks,
      id: decks.id,
      rev: decks.rev,
      deletedAt: decks.deleted_at,
      scope: decks.user_id,
      scrub: { title: '' },
      insertOnly: ['id'],
    }),
  },
})

// the packed store satisfies the packed engine's store slot
void createSyncEngine({ store, tables: { decks: {} } })

export {}
