# @remelondb/server

The sync backend engine for
[remelonDB](https://github.com/dustyway/remelonDB): the
[wire protocol](../../docs/sync-wire.md) implemented once, above a small
storage seam — the server-side repetition of the client's core move
(see [reference/backend.md](../../docs/reference/backend.md)).

```ts
import { createMemoryStore, createSyncEngine } from '@remelondb/server';

const engine = createSyncEngine({
  store: createMemoryStore(), // or your adapter
  tables: {
    tasks: { validate: (row) => row.name !== '' },
  },
});

const handlers = engine.as(userId); // { pull(args), push(args) }
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

Prove an adapter with the `@remelondb/server/conformance` suite: run it
against `engine.as(...)` over your store — this package's own test does
exactly that with the memory store.

The engine answers requests; it never initiates. If clients should learn
about changes without asking, publish a signal from your route handler
after a push returns without a conflict, and let the client respond by
calling `synchronize`. The signal carries no data — the cursor stays the
only path — and it is worth building only when changes arrive faster than
sessions do:
[when to sync](https://github.com/dustyway/remelonDB/blob/main/docs/sync-triggering.md).

## License

[MIT](https://github.com/dustyway/remelonDB/blob/main/LICENSE)
