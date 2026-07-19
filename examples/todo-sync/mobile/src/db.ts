import { Database } from '@remelondb/core'
import { RnSqliteDriver } from '@remelondb/driver-rn'
import { schema, TodoModel } from 'example-todo-sync/schema'

let opened: Promise<Database> | undefined

export const openDb = (): Promise<Database> =>
  (opened ??= Database.open({
    driver: new RnSqliteDriver(),
    schema,
    modelClasses: [TodoModel],
    name: 'todo-sync.db',
  }))
