# Building a sync backend

The server side of remelonDB is three layers, each its own package, each
replaceable:

```
transport   @remelondb/nestjs     HTTP routes, request validation, auth seam
engine      @remelondb/server     every protocol semantic (cursors, conflicts…)
store       @remelondb/store-drizzle   rows and revisions in Postgres
```

The engine is the fixed center; transports and stores plug into it. The
hands-on path is the [backend tutorial](../backend-tutorial.md) — every
code block there is executed by CI, so this page repeats none of it and
holds what a tutorial can't: the contract and the corners.

## The engine/store split

Every protocol semantic — cursor encoding, conflict detection,
per-record rejection, the interleave fast path and its degrade rule —
lives once in the engine, above a small storage seam (`SyncStore`, the
server-side sibling of `SqliteDriver`). A store knows rows, revisions,
and scopes; it knows nothing about cursors, conflicts, or the wire.
The wire spec ([sync-wire.md](../sync-wire.md)) binds the whole server;
the seam splits its obligations:

| Obligation | Owner |
| --- | --- |
| Consistent snapshot per operation | store (`transaction`) |
| Commit-ordered revisions | store: revisions assigned so that pushes for one scope commit in revision order (`transaction(scope, 'push', …)` MUST serialize per scope — the advisory-lock obligation) |
| Cursor encoding, opacity, floor checks | engine (revision-based reference mechanism) |
| Conflict detection and ordering vs rejection | engine (ownership rejections first — foreign revisions are incomparable to a scope's cursor — then whole-push conflict) |
| Per-record validation | engine, via per-table `validate`/`appendOnly` + optional `crossValidateChanges` (referential checks over the full change set, deletions included) |
| Tombstoned-write rejection | engine, via the store's `tombstonedIds` |
| Storage refusals surfaced as rejections | store: `upsert` may return ids the database itself refused (unique/FK constraints); the engine folds them into `rejected` |
| Upsert discipline (never touch creation stamps, never resurrect tombstones), tombstoning, retention | store |
| Interleave computation, the both-or-neither package rule, mandatory degrade below the floor | engine |

The seam is not an ORM adapter: `changedSince` returns wire-ready rows
(the store owns column mapping), and the engine never constructs
queries. It is not a transport either: the engine produces
`SyncHandlers` (`pull`/`push` as plain async functions) that a route
handler, an RPC layer, or a test calls directly. Scope is a type
parameter — a user id, a tenant key, whatever partitions the data.

## The table contract

Each synced table carries four machinery columns next to its columns
from the shared Zod object:

| column | type | role |
| --- | --- | --- |
| `id` | `text` primary key | client-minted record id — never a server default |
| `rev` | `bigint` | revision stamp |
| `deleted_at` | `timestamptz` null | tombstone marker; deletes are never `DELETE` |
| owner | any | the sync scope (user, team, workspace) |

Index `(owner, rev)` — every incremental pull filters on exactly that
pair. Two bookkeeping objects (the revision sequence, the one-row meta
table) belong in the same migration; the
[store README](../../packages/store-drizzle/README.md) has the SQL and
the [tutorial](../backend-tutorial.md) runs it.

Column names should match the Zod keys; then the store needs no mapping
code, and any drift between Postgres and the shared schema fails loudly
in the client's strict wire validation instead of corrupting silently.
The same Zod objects drive everything else — client schema, wire
validators, server-side validation ([zod-adapter.md](../zod-adapter.md)).

## Derived scope

A child table scoped through its parent (a card owned via its deck) has
no scope column of its own. Either denormalize the scope column onto the
child — the config-only path, and the friendlier one for scope queries —
or omit `scope` and supply `overrides` implementing the scoped queries
(`changedSince`, `currentRevs`, `foreignIds`, `maxRev`) with the join;
the store enforces this at construction.

## Retention and scrub

Tombstones accumulate until `store.gc(floor)`: prune everything dead at
or below the floor, persist the floor (never lowered), and cursors below
it degrade to `resyncRequired` — the client rebuilds from a full pull.
The caller picks the floor; retention policy stays the app's (for "keep
90 days", record the current max rev periodically and pass the one from
90 days ago). Until the first `gc` call the floor is 0 and every cursor
is served.

A per-table `scrub` blanks chosen columns in the same UPDATE that
tombstones a row. The wire never ships a tombstone's columns, so
scrubbed content is immediately gone for every device while the deletion
still syncs as an id.

## Transports

`@remelondb/nestjs` is the canonical HTTP binding
([sync-wire.md](../sync-wire.md) §6) as a module: protocol outcomes are
HTTP 200 with the variant in the body, 400 is a malformed request, 401
an unauthenticated one. Auth stays the app's — `scopeFrom` maps a
request to its scope (a session lookup, a JWT claim); null answers 401.
An invalid record is rejected **by id** while the rest of the push
applies; the push envelope only checks shape and usable ids. Engine
table config beyond validation goes through `tableOptions` (e.g.
`tableOptions: { review_events: { appendOnly: true } }`): the module
builds its own engine, so config not passed here does not exist on the
served endpoints. Setup is in
the [package README](../../packages/nestjs/README.md); without NestJS,
the engine's handlers bind to any HTTP server in a few lines (the
[example server](../../examples/todo-sync/backend/server.ts) is the
whole thing).

## Certifying a backend

The wire spec's checklist ([sync-wire.md §7](../sync-wire.md)) is
executable: `registerServerConformance` from
`@remelondb/server/conformance` runs every case against any pull/push
handlers — in-process, or through real HTTP behind a fetch wrapper.
Passing it is what "implements the protocol" means.

```ts
import { registerServerConformance } from '@remelondb/server/conformance'

registerServerConformance({
  name: 'engine over MyStore',
  // fresh context per test: clean state, authenticated handlers
  makeContext: async () => {
    const engine = createSyncEngine({ store: myStore(), tables })
    return { handlers: engine.as('user-a'), secondUser: engine.as('user-b') }
  },
  fixtures: {
    tasks: {
      validRow: () => ({ id: nextId(), name: 'a task', done: false }),
      mutate: (row) => ({ ...row, name: 'edited' }),
      invalidRow: () => ({ id: nextId(), name: '', done: false }),
    },
  },
})
```

Three properties make the suite portable. `makeContext` returns
handlers, not internals, so it tests exactly what a client experiences
and can wrap anything from an in-memory store to a full HTTP app.
Fixtures abstract the schema, so the suite does not care what your
tables are called. And optional capabilities let cases that need extra
powers skip visibly instead of being faked:

| Capability | Enables |
| --- | --- |
| `secondUser` | scoping cases (10, 14) |
| `concurrently` | the write-during-a-pull commit-order case (4) |
| `invalidRow` in a fixture | per-record validation rejection (7) |
| `appendOnly` | the append-only refusal case (13) |
| `uniqueColumn` | storage constraint refusals as rejections (14) |

The suite runs against five registrations in this repository — the
memory store, the reference server, the drizzle store over pglite, the
NestJS transport, and downstream apps register their production stores
the same way — so a new obligation added to the checklist binds every
implementation on its next test run. The exported `pulled` and
`accepted` helpers narrow protocol results in your own tests.

## Client side

The client needs only a base URL for the two routes:
[reference/sync.md](sync.md) covers `synchronize`, cursors, conflicts,
and resync behavior; the [tutorial](../tutorial.md) ends with a working
sync loop.
