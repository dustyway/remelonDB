// The public conformance entry points stay importable and typed from
// the packed declarations: these are the APIs third-party backends and
// drivers build their own CI on.
import { registerDriverConformance } from '@remelondb/core/conformance'
import { registerServerConformance } from '@remelondb/server/conformance'
import type { SqliteDriver } from '@remelondb/core'

declare const makeDriver: () => SqliteDriver

registerDriverConformance({
  name: 'packed fixture',
  createDriver: makeDriver,
})

registerServerConformance({
  name: 'packed fixture',
  makeContext: async () => ({
    handlers: {
      pull: async () => ({ resyncRequired: true as const }),
      push: async () => ({ conflict: true as const }),
    },
  }),
  fixtures: {
    items: {
      validRow: () => ({ id: 'i1', name: 'x' }),
      mutate: (row) => ({ ...row, name: 'y' }),
    },
  },
})

export {}
