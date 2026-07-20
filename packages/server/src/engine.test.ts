import { registerServerConformance } from './conformance/index'
import { createMemoryStore, createSyncEngine } from './index'

// The engine over the memory store must pass the full backend contract;
// a real adapter proves itself the same way, engine included.
let counter = 0
const newId = (): string => `row-${++counter}`

registerServerConformance({
  name: 'engine over MemoryStore',
  makeContext: async () => {
    const engine = createSyncEngine({
      store: createMemoryStore(),
      tables: {
        tasks: { validate: (row) => row['name'] !== '' },
      },
    })
    return {
      handlers: engine.as('scope-a'),
      secondUser: engine.as('scope-b'),
    }
  },
  fixtures: {
    tasks: {
      validRow: () => ({ id: newId(), name: 'a task', done: false }),
      mutate: (row) => ({ ...row, name: `${String(row['name'])} (edited)` }),
      invalidRow: () => ({ id: newId(), name: '', done: false }),
    },
  },
})
