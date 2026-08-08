import { createSyncEngine } from '@remelondb/server'
import { registerServerConformance } from '@remelondb/server/conformance'
import { events, freshDb, tasks } from './fixture'
import { createDrizzleStore } from './store'

// The drizzle store over real Postgres (pglite, in-process) must pass
// the full backend contract, engine included — the same registration as
// the memory store's. Item 4 (write during a pull) needs two
// interleaved connections and pglite has one; the deterministic
// construction in store.race.test.ts covers that property instead.
let counter = 0
const newId = (): string => `row-${++counter}`

registerServerConformance({
  name: 'engine over DrizzleStore (pglite)',
  makeContext: async () => {
    const { db } = await freshDb()
    const store = createDrizzleStore<string>({
      db,
      tables: {
        tasks: {
          table: tasks,
          id: tasks.id,
          rev: tasks.rev,
          deletedAt: tasks.deletedAt,
          scope: tasks.owner,
        },
        events: {
          table: events,
          id: events.id,
          rev: events.rev,
          deletedAt: events.deletedAt,
          scope: events.owner,
        },
      },
    })
    const engine = createSyncEngine({
      store,
      tables: {
        tasks: { validate: (row) => row['name'] !== '' },
        events: { validate: () => true, appendOnly: true },
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
  appendOnly: {
    table: 'events',
    fixture: {
      validRow: () => ({ id: newId(), note: 'happened' }),
      mutate: (row) => ({ ...row, note: 'rewritten' }),
    },
  },
})
