import { Database } from '@remelondb/core'
import { WebSqliteDriver } from '@remelondb/driver-web'
import { schema, TodoModel } from 'example-todo-sync/schema'

let opened: Promise<Database> | undefined

// One database per tab — the OPFS pool is single-connection.
export const openDb = (): Promise<Database> =>
  (opened ??= Database.open({
    driver: new WebSqliteDriver(),
    schema,
    modelClasses: [TodoModel],
    name: 'todo-sync.db',
  }))
