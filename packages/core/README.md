# @remelondb/core

The platform-independent whole of [remelonDB](https://github.com/dustyway/remelonDB),
a reactive, offline-first, syncable database layer rebuilt from
[WatermelonDB](https://github.com/Nozbe/WatermelonDB)'s best ideas on one
engine: SQLite everywhere.

This package contains everything except the platform driver: the `Q` query
DSL and its SQL compiler, schema and migrations, the `Database`/`Collection`/
`Model` layer, reactive observation, and the sync engine. It talks to SQLite
through a ~7-method `SqliteDriver` interface; pick the driver for your
platform:

| Platform | Driver package |
| --- | --- |
| Node | [`@remelondb/driver-node`](https://www.npmjs.com/package/@remelondb/driver-node) (better-sqlite3) |
| Browser | [`@remelondb/driver-web`](https://www.npmjs.com/package/@remelondb/driver-web) (SQLite-WASM + OPFS in a Worker) |
| React Native | [`@remelondb/driver-rn`](https://www.npmjs.com/package/@remelondb/driver-rn) (C++ TurboModule, bundled SQLite) |

Because every driver is real SQLite and passes the same
[conformance suite](https://www.npmjs.com/package/@remelondb/driver-conformance),
code written against core behaves identically on all of them.

## Example

```ts
import {
  appSchema, tableSchema, Database, Model, Q, synchronize,
  type AssociationsMap,
} from '@remelondb/core'
import { NodeSqliteDriver } from '@remelondb/driver-node'

const schema = appSchema({
  version: 1,
  tables: [
    tableSchema({
      name: 'tasks',
      columns: [
        { name: 'name', type: 'string' },
        { name: 'position', type: 'number', isIndexed: true },
        { name: 'is_done', type: 'boolean' },
      ],
    }),
  ],
})

class Task extends Model {
  static override readonly table = 'tasks'
  declare name: string        // type-only; accessors are schema-generated
  declare position: number
  declare is_done: boolean
}

const db = await Database.open({
  driver: new NodeSqliteDriver(),
  schema,
  modelClasses: [Task],
  name: 'app.db',
})

const task = await db.write(() =>
  db.get<Task>('tasks').create({ name: 'try it', position: 1 }),
)
await db.write(() => task.update(() => { task.is_done = true }))

const unsubscribe = db
  .get<Task>('tasks')
  .query(Q.where('is_done', false), Q.sortBy('position'))
  .observe((open) => console.log('open tasks:', open.length))

await synchronize({ database: db, pullChanges, pushChanges }) // your backend
```

## Documentation

- [Tutorial](https://github.com/dustyway/remelonDB/blob/main/docs/tutorial.md):
  a flashcard app's data layer, end to end
- Reference:
  [database & observation](https://github.com/dustyway/remelonDB/blob/main/docs/reference/database.md) ·
  [models](https://github.com/dustyway/remelonDB/blob/main/docs/reference/models.md) ·
  [queries](https://github.com/dustyway/remelonDB/blob/main/docs/reference/queries.md) ·
  [sync](https://github.com/dustyway/remelonDB/blob/main/docs/reference/sync.md) ·
  [schema & migrations](https://github.com/dustyway/remelonDB/blob/main/docs/reference/schema.md) ·
  [records](https://github.com/dustyway/remelonDB/blob/main/docs/reference/records.md) ·
  [the driver contract](https://github.com/dustyway/remelonDB/blob/main/docs/reference/driver.md)
- Design:
  [architecture layers](https://github.com/dustyway/remelonDB/blob/main/docs/architecture-layers.md) ·
  [queries as data, one engine](https://github.com/dustyway/remelonDB/blob/main/docs/q-dsl-and-one-engine.md) ·
  [sync protocol](https://github.com/dustyway/remelonDB/blob/main/docs/sync-design.md)

## License and credits

[MIT](https://github.com/dustyway/remelonDB/blob/main/LICENSE). The design
owes its best ideas (queries as data, reactive observation, the offline-first
sync protocol) to [WatermelonDB](https://github.com/Nozbe/WatermelonDB) by
Nozbe and contributors (MIT); the code is written from scratch.
