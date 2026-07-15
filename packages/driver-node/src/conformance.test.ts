import { tmpdir } from 'node:os'
import { registerDriverConformance } from '@remelondb/driver-conformance'
import { NodeSqliteDriver } from './NodeSqliteDriver'

let counter = 0

registerDriverConformance({
  name: 'node (better-sqlite3)',
  createDriver: () => new NodeSqliteDriver(),
  persistence: {
    databaseName: () =>
      `${tmpdir()}/wm-conformance-${process.pid}-${counter++}.db`,
  },
})
