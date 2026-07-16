# Sync design: protocol and client engine

Builds on `upstream-study.md` (sync section) and `architecture-layers.md`
(sync is core logic over the SqliteDriver seam). This is a **generic**
reimplementation of WatermelonDB's sync protocol: no specific backend is a
design input. Upstream's shape is kept where it's sound; its two documented
contract flaws are fixed at the protocol level.

## What we keep from upstream

The overall model is unchanged, because it's good:

- **Two-phase sync**: pull (apply remote changes) then push (send local
  changes). Server is the master copy; client resolves conflicts.
- **Content-based dirty tracking**: `_status ∈ {synced, created, updated,
  deleted}` plus `_changed` (set of dirty column names), maintained on every
  local write.
- **Per-column client-wins merge**: resolved = remote record, overwritten by
  the local values of columns in `_changed`; record stays dirty so those
  columns are pushed next sync. Optional `conflictResolver` hook on top.
- **Changeset wire shape**: `{ [table]: { created: RawRecord[], updated:
  RawRecord[], deleted: RecordId[] } }`.
- **Transport agnosticism**: the engine calls injected `pullChanges` /
  `pushChanges` functions; HTTP, WebSocket, whatever — not our concern.
- **Concurrency guards**: apply and mark-synced each run in a single writer
  block; cursor re-checked before applying (two-sync collision); a record
  modified between fetch-local and mark-synced fails its `areRecordsEqual`
  check, stays dirty, and goes out with the next push. Idempotent apply.

## The two contract flaws, and the fixes

### Flaw 1: the lost-write race → opaque commit-ordered cursor

Upstream's pull contract is `last_modified > lastPulledAt` with a
server-chosen timestamp. If any write lands during the pull window with a
timestamp ≤ the returned cursor (out-of-order commits, clock granularity,
per-table queries without a shared snapshot), it is never pulled again: a
silent lost write. Upstream delegates this entirely to backend discipline in
prose.

**Fix — the cursor becomes an opaque token with a precise contract:**

- The client never inspects, compares, or arithmetics the cursor. It stores
  the token (an arbitrary JSON string) and echoes it back. No client code
  depends on it being a timestamp, a number, or ordered.
- The server contract (the invariant everything rests on):

  > `pull(c)` returns a changeset drawn from **one consistent snapshot** `S`
  > and a cursor `c'` identifying `S`. Every change committed after `S`
  > (including changes concurrent with the pull that commit later) MUST be
  > returned by some future `pull(c')`.

  Equivalently: change visibility must be **commit-ordered** with respect to
  cursors, not write-time-ordered. Wall-clock timestamps assigned at write
  time cannot satisfy this; a monotonic revision assigned at commit order, a
  transaction-horizon watermark, or a single-writer change log all can. The
  protocol doc mandates the invariant rather than the mechanism; the backend
  guide (below) sketches known-good mechanisms.

### Flaw 2: push-echo → push responds like a pull

Upstream's client re-downloads its own pushed changes on the next pull;
they're absorbed by equality checks but transmitted, diffed, and, worse,
they force the *next* pull to be non-empty forever under active use.
Upstream's own limitations doc names the fix; we adopt it:

**Fix — the push response carries a cursor and any interleaved changes:**

```
pushResponse = {
  cursor:  Cursor | null,   // covers the push transaction's snapshot
  changes: Changes | null,  // committed between request cursor and push
                            // snapshot, EXCLUDING the pushed changes
  rejected?: { [table]: RecordId[] }  // per-record rejections (optional)
}
```

- Server applies the push in one transaction, computes the new cursor in
  that same transaction, and returns changes other clients committed in
  between (its own push excluded). Client applies `changes`, marks pushed
  records synced, adopts `cursor`. The client's own writes never echo.
- **Degraded mode is legal**: a backend that can't compute interleaved
  changes returns `cursor: null, changes: null`; the client keeps its old
  cursor and the next pull re-delivers the echo, which the apply engine
  absorbs exactly as upstream does (`requiresUpdate` equality check). Sound
  either way; the fast path is opt-in per backend, invisible to app code.
- A cursor MUST NOT be returned without the interleaved changes: adopting a
  cursor while skipping foreign changes committed under it would be the
  lost-write race reintroduced by the back door. `cursor` and `changes` are
  a package: both or neither.

## Protocol summary

```
pull(cursor | null, schemaVersion, migration | null)
  → { changes, cursor }                    // normal
  → { resyncRequired: true }               // cursor unknown/expired (tombstones
                                           // or change log pruned past it)

push(changes, cursor)
  → { cursor, changes, rejected? }         // accepted (possibly degraded nulls)
  → { conflict: true }                     // some pushed record changed on the
                                           // server after `cursor` — client must
                                           // pull, re-merge, push again
```

- **First sync**: `cursor = null`; server returns everything as `created`.
- **Resync**: on `resyncRequired`, the client re-pulls from `null` and
  applies with a *replacement* strategy (reconcile against the full server
  state: update matching ids, create missing, destroy local synced records
  absent from the snapshot; local dirty records are merged per-column, and
  push follows as usual). This gives servers a defined way to prune
  tombstones/change logs with a bounded retention window instead of forever.
- **Push conflict loop**: pull → merge → push is retried a bounded number of
  times (default 5, matching the spirit of upstream's re-sync guidance),
  then surfaces an error to the app.
- **Record shape on the wire**: user columns + `id` only. `_status` and
  `_changed` never cross the wire in either direction (upstream sends them
  client→server with an apologetic TODO; here it's a protocol rule).
  `created` carries full records; `updated` carries full records in v1
  (sparse updates are an open question below).
- **Migration pulls**: kept from upstream. After a local schema migration,
  the client sends `migration = { from, tables, columns }` (derived from
  migration steps since the last-synced schema version) so the server
  includes full records for newly tracked tables/columns. Cursor semantics
  are unaffected.

## Backend obligations (the contract, condensed)

A conforming backend MUST:

1. Serve each pull from one consistent snapshot (no per-table queries at
   different points in time).
2. Issue cursors that are commit-ordered: no change committed after a
   cursor's snapshot may ever be invisible to pulls from that cursor.
3. Retain deletions (tombstones or a change log) long enough to serve any
   cursor it hasn't declared expired; answer expired cursors with
   `resyncRequired`, never with silently incomplete data.
4. Apply each push atomically, and reject the push (`conflict`) if any
   pushed record was modified on the server after the push's cursor.
5. Never return a push cursor without the interleaved foreign changes.

Known-good cursor mechanisms (guidance, not mandate): a global revision
sequence where the revision is assigned in commit order (e.g. via a
serialized commit path or advisory lock); a transaction-horizon watermark
(cursor = oldest possibly-invisible transaction, pull returns everything
committed before it); an append-only change log with a single writer.
Wall-clock `last_modified` alone is explicitly non-conforming.

## Client engine notes

- The engine is core code: it reads/writes records through the same
  compiled-SQL path as everything else, and tombstones + the sync cursor
  live in ordinary tables (`local_storage` for the cursor and last-synced
  schema version), per `architecture-layers.md`.
- Apply classification is upstream's decision tree, kept: remote `created`
  that exists locally → treat as update (log anomaly); remote `updated`
  missing locally → create; remote update vs local delete → local delete
  wins (pushed later); remote delete → always destroys, even over local
  changes. All overridable per record via `conflictResolver`.
- `fetchLocalChanges` strips `_status`/`_changed` at the boundary and
  snapshots raws; `markLocalChangesAsSynced` keeps upstream's equality gate
  so writes racing the push stay dirty.
- The engine exposes the same surface as upstream (`synchronize()`,
  `hasUnsyncedChanges()`, logging hooks), minus turbo sync (deferred, see
  architecture doc) and minus `_unsafeBatchPerCollection` (apply batches are
  chunked internally as an implementation detail rather than API).

## Open questions

1. **Sparse updates** (`updated` as `{id, ...changedColumnsOnly}` instead of
   full records): halves payloads for wide tables, but complicates apply
   (merge must distinguish "column absent" from "column null") and server
   storage. Proposal: keep full records in v1; reserve a protocol capability
   flag so sparse can be added without a breaking change.
2. **`changedColumns` hint client→server**: would let servers do per-column
   conflict detection instead of per-record. Proposal: omit in v1; server
   conflict detection stays per-record (reject and let the client merge),
   which is simpler and provably convergent.
3. **Cursor scope**: one cursor for the whole database vs per-table cursors.
   Per-table enables partial/priority sync but multiplies every invariant.
   Proposal: single cursor in v1; partial sync is a future protocol
   extension rather than a v1 complication.
