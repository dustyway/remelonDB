import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { bigint, boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { createSyncEngine } from '@remelondb/server'
import { registerServerConformance } from '@remelondb/server/conformance'
import { createDrizzleStore } from './store'
import type { DrizzleDb } from './store'

// The drizzle store over real Postgres (pglite, in-process) must pass
// the full backend contract, engine included — the same registration as
// the memory store's. Item 4 (write during a pull) needs two
// interleaved connections and pglite has one; it reports as skipped.
const tasks = pgTable('tasks', {
  id: text('id').primaryKey(),
  rev: bigint('rev', { mode: 'number' }).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  owner: text('owner').notNull(),
  name: text('name').notNull(),
  done: boolean('done').notNull(),
})

let counter = 0
const newId = (): string => `row-${++counter}`

registerServerConformance({
  name: 'engine over DrizzleStore (pglite)',
  makeContext: async () => {
    const client = new PGlite()
    await client.exec(`
      create sequence remelon_rev;
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
        },
      },
    })
    const engine = createSyncEngine({
      store,
      tables: {
        tasks: { validate: (row) => row['name'] !== '' },
      },
    })
    return { handlers: engine.as('scope-a'), secondUser: engine.as('scope-b') }
  },
  fixtures: {
    tasks: {
      validRow: () => ({ id: newId(), name: 'a task', done: false }),
      mutate: (row) => ({ ...row, name: `${String(row['name'])} (edited)` }),
      invalidRow: () => ({ id: newId(), name: '', done: false }),
    },
  },
})
