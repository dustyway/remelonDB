import { createReferenceServer, registerServerConformance } from './index'

// The suite proven against its own reference implementation: a server
// known to satisfy the wire spec passes all ten scenarios.
let counter = 0
const newId = (): string => `row-${++counter}`

registerServerConformance({
  name: 'in-memory reference server',
  makeContext: async () => {
    const server = createReferenceServer({
      validate: { tasks: (row) => row['name'] !== '' },
    })
    return {
      handlers: server.as('user-a'),
      secondUser: server.as('user-b'),
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
