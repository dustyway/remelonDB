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
applies; the push envelope only checks shape and usable ids. Setup is in
the [package README](../../packages/nestjs/README.md); without NestJS,
the engine's handlers bind to any HTTP server in a few lines (the
[example server](../../examples/todo-sync/backend/server.ts) is the
whole thing).

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
