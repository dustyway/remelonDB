import { createDatabaseManager, Database } from '@remelondb/core'
import { RnSqliteDriver } from '@remelondb/driver-rn'
import { schema, TodoModel } from 'example-todo-sync/schema'

// Same bootstrap as the web client (see frontend/src/db.ts). Native has
// no tabs, so the takeover callback the factory receives is unused and
// the taken-over state is unreachable — the manager still buys the
// deduplicated open, retryable failure, and the shared React hook.
export const manager = createDatabaseManager({
  open: () =>
    Database.open({
      driver: new RnSqliteDriver(),
      schema,
      modelClasses: [TodoModel],
      name: 'todo-sync.db',
    }),
})
