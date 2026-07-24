# @remelondb/store-drizzle

A [`SyncStore`](../server/README.md) for Postgres via
[drizzle-orm](https://orm.drizzle.team): the storage half of a remelonDB sync
backend, configured per table, with the store methods generated. Plug it into
`createSyncEngine` from `@remelondb/server` and the engine owns the protocol;
this package owns rows, revisions, and scopes.

## Table contract

Every synced table carries four machinery columns:

| column | type | role |
| --- | --- | --- |
| `id` | `text` primary key | client-minted record id |
| `rev` | `bigint` | revision stamp, indexed with the scope column |
| `deleted_at` | `timestamptz` null | tombstone marker; null = alive |
| scope | any | whose data this is (user, team, workspace) |

Deletes are tombstones, never `DELETE` — a removed row must still sync to other
devices. Upserts never resurrect a tombstone and never touch `insertOnly`
columns of existing rows.

All other columns pass through as the wire row. When column names match wire
names, the default mapping is identity and a table needs no mapper code.

## Usage

```ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { createSyncEngine } from '@remelondb/server'
import { createDrizzleStore } from '@remelondb/store-drizzle'
import { decks } from './schema'

const db = drizzle(process.env.DATABASE_URL!)

const store = createDrizzleStore<string>({
  db,
  tables: {
    decks: {
      table: decks,
      id: decks.id,
      rev: decks.rev,
      deletedAt: decks.deletedAt,
      scope: decks.ownerId,
    },
  },
})

const engine = createSyncEngine({ store, tables: { decks: {} } })
```

Revisions come from one Postgres sequence (`remelon_rev` by default); create it
in a migration:

```sql
CREATE SEQUENCE IF NOT EXISTS remelon_rev;
```

Pushes serialize per scope with `pg_advisory_xact_lock`, keyed by `lockKey`
(default: a 64-bit hash of the scope).

## Derived scope

A child table scoped through its parent (a card owned via its deck) has no
scope column of its own. Either denormalize the scope column onto the child —
the config-only path, and the friendlier one for scope queries — or omit
`scope` and supply `overrides` implementing the scoped queries
(`changedSince`, `currentRevs`, `foreignIds`, `maxRev`) with the join; the
store enforces this at construction.

## Not yet

`gcFloor()` is 0: every cursor is served and tombstones accumulate; pruning is
a future GC feature.
