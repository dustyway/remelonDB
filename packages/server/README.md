# @remelondb/server

The sync backend engine for
[remelonDB](https://github.com/dustyway/remelonDB): the
[wire protocol](../../docs/sync-wire.md) implemented once, above a small
storage seam — the server-side repetition of the client's core move
(see [server-design.md](../../docs/server-design.md)).

```ts
import { createMemoryStore, createSyncEngine } from '@remelondb/server'

const engine = createSyncEngine({
  store: createMemoryStore(), // or your adapter
  tables: {
    tasks: { validate: (row) => row.name !== '' },
  },
})

const handlers = engine.as(userId) // { pull(args), push(args) }
// wire them to routes: every protocol outcome is a returned value,
// so a route handler is res.json(await handlers.push(req.body))
```

The engine owns every protocol semantic: cursor encoding and floor
checks, ownership-before-staleness ordering, whole-push conflict,
per-record rejection (plus `crossValidate` for referential checks), the
cursor+interleave package rule, and the mandatory degrade below the
retention floor. A `SyncStore` owns rows, revisions, and scopes — eight
methods, wire-ready rows out, no knowledge of cursors or conflicts. The
two obligations an adapter must earn (the memory store gets them for
free by being single-threaded): snapshot-consistent transactions, and
per-scope serialization of pushes so revisions commit in order.

Prove an adapter with
[`@remelondb/server-conformance`](../server-conformance): run the suite
against `engine.as(...)` over your store — this package's own test does
exactly that with the memory store.

## License

[MIT](https://github.com/dustyway/remelonDB/blob/main/LICENSE)
