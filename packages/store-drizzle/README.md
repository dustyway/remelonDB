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
import { z } from 'zod'
import { syncSchemas } from '@remelondb/core/zod'
import { createSyncEngine } from '@remelondb/server'
import { createDrizzleStore } from '@remelondb/store-drizzle'
import { decks } from './schema'

// one Zod object per table: the client derives its local schema from it
// (zodTable), the server validates rows with it — see docs/zod-adapter.md
const Deck = z.object({
  name: z.string().min(1),
  source_lang: z.string(),
  target_lang: z.string(),
})
const wire = syncSchemas({ decks: Deck })

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

const engine = createSyncEngine({
  store,
  tables: {
    decks: { validate: (row) => wire.rows.decks.safeParse(row).success },
  },
})
```

With NestJS, [`@remelondb/nestjs`](../nestjs/README.md) does the engine and
validation wiring — hand it the store and the Zod objects.

Two bookkeeping objects belong in a migration: the revision sequence and the
one-row meta table holding the gc floor (names configurable via `revSequence`
and `metaTable`):

```sql
CREATE SEQUENCE IF NOT EXISTS remelon_rev;
CREATE TABLE IF NOT EXISTS remelon_sync_meta (key text PRIMARY KEY, value bigint NOT NULL);
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

## Erasure (GDPR) and GC

These are different jobs. **Erasure** comes from scrubbing: give a table
`scrub` values (drizzle property keys) and they are applied in the same UPDATE
that tombstones the row —

```ts
tables: {
  cards: { /* columns */, scrub: { content: '{}' } },
}
```

The wire never ships a tombstone's columns, so scrubbed content is immediately
gone for every device; deletion still syncs as an id. Full account erasure
needs no tombstones at all: hard-`DELETE` the scope's rows — a deleted account
can never pull again, so nothing needs to learn about the absence.

**GC** bounds storage. `store.gc(floor)` prunes tombstones with `rev <= floor`
and persists the floor (never lowered); a cursor below the floor answers
`resyncRequired` and the client rebuilds from a full pull. The caller picks the
floor — retention policy stays the app's (for "keep 90 days", record the
current max rev periodically and pass the one from 90 days ago). Until the
first `gc` call the floor is 0 and every cursor is served.
