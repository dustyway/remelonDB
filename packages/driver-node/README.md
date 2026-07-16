# @remelondb/driver-node

The Node `SqliteDriver` for [remelonDB](https://github.com/dustyway/remelonDB),
backed by [better-sqlite3](https://github.com/WiseLibs/better-sqlite3).
Everything is synchronous underneath; the Promise-shaped driver contract
exists for the platforms that need it (workers, native modules).

## Usage

```ts
import { Database } from '@remelondb/core'
import { NodeSqliteDriver } from '@remelondb/driver-node'

const db = await Database.open({
  driver: new NodeSqliteDriver(),
  schema,
  migrations,
  modelClasses: [Task],
  name: 'app.db', // a filesystem path, or ':memory:' for a throwaway database
})
```

- File-backed databases run in WAL journal mode.
- `destroy()` removes the database file and its WAL/SHM sidecars.

## Role in the project

This is also remelonDB's reference driver: the full driver
[conformance suite](https://www.npmjs.com/package/@remelondb/driver-conformance)
and the core integration suites (database, models, sync) run against it on
real SQLite in ordinary vitest, so most semantics are pinned down here before
the web and React Native drivers re-verify them.

## License

[MIT](https://github.com/dustyway/remelonDB/blob/main/LICENSE)
