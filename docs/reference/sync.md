# Sync reference

How to *use* the sync engine. The protocol's design and rationale — the
opaque commit-ordered cursor, why push responds like a pull, the backend
MUSTs — live in [../sync-design.md](../sync-design.md); read that first if
you're implementing a backend.

## Calling synchronize

```ts
import { synchronize } from '@watermelon-rewrite/core'

await synchronize({
  database: db,

  pullChanges: async ({ cursor, schemaVersion, migration }) => {
    const response = await fetch(`/sync/pull`, {
      method: 'POST',
      body: JSON.stringify({ cursor, schemaVersion, migration }),
    })
    if (response.status === 410) return { resyncRequired: true }
    return response.json() // { changes, cursor }
  },

  pushChanges: async ({ changes, cursor }) => {
    const response = await fetch(`/sync/push`, {
      method: 'POST',
      body: JSON.stringify({ changes, cursor }),
    })
    if (response.status === 409) return { conflict: true }
    return response.json() // { cursor, changes, rejected? }
  },
})
```

Transport is entirely yours — the engine only sees the two functions.
`pushChanges` is optional (pull-only replicas). Also exported:
`hasUnsyncedChanges(db)`, and the lower-level phases
(`fetchLocalChanges`, `applyRemoteChanges`, `markLocalChangesAsSynced`)
for building custom flows.

## The wire shapes

```ts
// changesets, both directions
{ [table]: { created: [record], updated: [record], deleted: [id] } }

// records: user columns + id. _status/_changed NEVER cross the wire.
// pull response:  { changes, cursor }  or  { resyncRequired: true }
// push response:  { cursor, changes, rejected? }  or  { conflict: true }
```

The cursor is an opaque string; store-and-echo. In the push response,
`cursor` + `changes` come **as a package** — a cursor without the
interleaved foreign changes is rejected as a backend bug (it would
reintroduce the lost-write race). Degraded backends return
`cursor: null, changes: null`: correct, but the client's own writes echo
back on the next pull (and are absorbed).

## What a sync run does

1. **Pull**: `pullChanges(cursor)` → apply inside one write block →
   store the new cursor. Before applying, the stored cursor is re-checked;
   if another `synchronize()` committed meanwhile, this one aborts with an
   error (call it again).
2. **Push** (if configured and there are local changes): snapshot dirty
   records → `pushChanges` → mark records synced, destroy pushed
   tombstones, adopt the push cursor and apply interleaved changes.
3. **Conflict loop**: a `{ conflict: true }` push response loops back to
   step 1 (the pull merges the server's version), bounded by
   `conflictRetries` (default 5), then throws.

Sync never blocks the app: reads and writes work throughout; only the
apply/mark commits hold the writer queue briefly.

## Conflict semantics (client-resolved)

- **Per-column, client-wins**: the merged record is the server version
  with the locally-changed columns (`_changed`) laid on top; it stays
  dirty so the merge is pushed back. Override per record with
  `conflictResolver(table, local, remote, resolved)`.
- **Remote delete beats local edits**; **local delete beats remote
  edits** (the tombstone is pushed next).
- **Equality gate**: a record modified while the push was in flight is
  not marked synced — it stays dirty for the next run. Rejected ids
  (`rejected`) likewise.

## Resync

When the server answers `resyncRequired` (pruned history, expired
cursor), the engine re-pulls from `cursor: null` and applies in
*replacement* mode: matching records reconciled, missing ones created,
**local synced records absent from the snapshot destroyed** — while dirty
records survive and push afterwards.

## Migration pulls

If your schema evolves, pass `migrationsEnabledAtVersion` (the schema
version you first shipped sync with). After a local migration, the next
pull includes `migration: { from, tables, columns }` so the backend can
send full records for newly tracked tables/columns. The engine tracks the
last-synced schema version in local storage automatically.

## Testing a backend

`packages/driver-node/src/syncIntegration.test.ts` contains a minimal
*conforming* fake backend (rev cursor, per-record conflict detection,
push-returns-cursor+changes) — a useful template for what your server
must do, and the test scenarios double as an executable spec of client
behavior.
