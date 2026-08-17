// The web driver's packed declarations: driver class, availability
// probe, and the worker-server side stay importable and typed.
import type { SqliteDriver } from '@remelondb/core'
import {
  WebSqliteDriver,
  probeOpfs,
  serveSqliteWorker,
} from '@remelondb/driver-web'

declare const driver: WebSqliteDriver
driver satisfies SqliteDriver
void (probeOpfs(undefined) satisfies Promise<void>)
void serveSqliteWorker

export {}
