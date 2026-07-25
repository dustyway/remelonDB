# Building a sync backend

The server side of remelonDB is three layers, each its own package, each
replaceable:

```
transport   @remelondb/nestjs     HTTP routes, request validation, auth seam
engine      @remelondb/server     every protocol semantic (cursors, conflicts…)
store       @remelondb/store-drizzle   rows and revisions in Postgres
```

The engine is the fixed center; transports and stores plug into it. A
backend without NestJS binds the engine's handlers to any HTTP server
(the [example server](../../examples/todo-sync/backend/server.ts) does it
in ~50 lines); a backend without Postgres uses `createMemoryStore` (demos,
tests).

## One Zod object per table

Declare each synced table once, as a Zod object in a package both client
and server import:

```ts
export const Task = z.object({ name: z.string().min(1), done: z.boolean() })
```

Everything derives from it: the client's local schema and record types
(`zodTable`, [zod-adapter.md](../zod-adapter.md)), the wire validators for
both directions (`syncSchemas`), and the server's per-record validation —
`@remelondb/nestjs` takes the same objects directly.

## The Postgres tables

Each synced table carries four machinery columns next to its Zod keys:

| column | type | role |
| --- | --- | --- |
| `id` | `text` primary key | client-minted record id — never a server default |
| `rev` | `bigint` | revision stamp |
| `deleted_at` | `timestamptz` null | tombstone marker; deletes are never `DELETE` |
| owner | any | the sync scope (user, team, workspace) |

Index `(owner, rev)` — every incremental pull filters on exactly that
pair. Give child tables (a card under a deck) their own owner column
rather than deriving ownership through a join: denormalizing keeps every
table config-only ([store-drizzle README](../../packages/store-drizzle/README.md)
covers the override path if you keep the join).

Column names should match the Zod keys; then the store needs no mapping
code, and any drift between Postgres and the shared schema fails loudly
in the client's strict wire validation instead of corrupting silently.

Two bookkeeping objects belong in a migration:

```sql
CREATE SEQUENCE IF NOT EXISTS remelon_rev;
CREATE TABLE IF NOT EXISTS remelon_sync_meta (key text PRIMARY KEY, value bigint NOT NULL);
```

## The store

```ts
import { createDrizzleStore } from '@remelondb/store-drizzle'

const store = createDrizzleStore<string>({
  db,
  tables: {
    tasks: { table: tasks, id: tasks.id, rev: tasks.rev, deletedAt: tasks.deletedAt, scope: tasks.owner },
  },
})
```

Pushes serialize per scope with an advisory lock, pulls run in one
repeatable-read snapshot, tombstones never resurrect. Retention is
`store.gc(floor)` — prune tombstones, persist the floor, degrade
below-floor cursors to resync — and a per-table `scrub` blanks chosen
columns in the same UPDATE that tombstones a row.

## The endpoints

```ts
RemelonSyncModule.forRootAsync({
  imports: [DbModule],
  inject: [DRIZZLE],
  useFactory: (db: Db) => ({
    store: createDrizzleStore<string>({ db, tables: { /* … */ } }),
    tables: { tasks: Task },
    scopeFrom: async (request) => {
      const session = await auth.api.getSession({ headers: (request as Request).headers })
      return session?.user.id ?? null
    },
  }),
})
```

`POST /sync/pull` and `POST /sync/push`, the canonical binding of
[sync-wire.md](../sync-wire.md) §6: every protocol outcome is HTTP 200
with the variant in the body; 400 is a malformed request, 401 an
unauthenticated one. Auth stays yours — `scopeFrom` maps a request to
its scope (a session lookup, a JWT claim); null answers 401. An invalid
record is rejected **by id** while the rest of the push applies; the
push envelope only checks shape and usable ids.

## Proving it

Every layer is conformance-tested, and custom pieces should be too:
`registerServerConformance` from `@remelondb/server/conformance` runs
the wire spec's checklist against any pull/push handlers — in-process,
or through real HTTP behind a fetch wrapper. The exported `pulled` and
`accepted` helpers narrow protocol results in your own tests.

## Client side

The client needs only a base URL for the two routes:
[reference/sync.md](sync.md) covers `synchronize`, cursors, conflicts,
and resync behavior; the [tutorial](../tutorial.md) ends with a working
sync loop.
