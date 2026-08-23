import { createDatabaseManager, Database } from '@remelondb/core';
import { WebSqliteDriver } from '@remelondb/driver-web';
import { schema, TodoModel } from 'example-todo-sync/schema';

// The manager owns the lifecycle: one shared open, retryable failure,
// takeover bookkeeping. `shared: true` puts every tab live on one
// database — open the app in two tabs and watch them mirror. Where
// SharedWorker is unavailable, the driver falls back to single-owner
// semantics and the takeover callback becomes reachable again.
export const manager = createDatabaseManager({
  open: (onTakenOver) =>
    Database.open({
      driver: new WebSqliteDriver({
        shared: true,
        takeover: true,
        onTakenOver,
      }),
      schema,
      modelClasses: [TodoModel],
      name: 'todo-sync.db',
    }),
});
