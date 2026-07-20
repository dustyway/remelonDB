# Sync design: protocol and client engine

How remelonDB keeps devices in sync, and why the protocol looks the
way it does. This is a generic reimplementation of
[WatermelonDB](https://github.com/Nozbe/WatermelonDB)'s sync protocol:
its shape is kept where it's sound, and its two contract-level flaws
are fixed at the protocol level. No specific backend is a design
input. The normative wire contract lives in
[sync-wire.md](sync-wire.md); this doc is the rationale.

## How it works, in short

Every device keeps a full local copy of its data and works against it
directly — offline is the normal case, not an error. Each local write
also records *that* the record changed (`_status`: created, updated,
or deleted) and *which columns* changed (`_changed`). Nothing else is
needed later: the dirty flags are the entire sync state.

A sync is two phases, always in this order:

1. **Pull** — ask the server "what changed since my cursor?", apply
   those changes locally, store the new cursor.
2. **Push** — send everything locally dirty to the server, and mark it
   clean once accepted.

The *cursor* is an opaque token the server hands out; the client just
stores it and echoes it back. The server is the master copy, but it
never merges: when both sides changed the same record, the **client**
resolves the conflict, column by column — the merged record is the
remote version, with the locally-changed columns laid back on top. If
two devices edited *different* columns, both edits survive. If they
edited the *same* column, the later pusher wins. A `conflictResolver`
hook can override this per record.

Changesets on the wire are per-table groups:
`{ [table]: { created: [...], updated: [...], deleted: [ids] } }`.
The engine calls injected `pullChanges`/`pushChanges` functions —
HTTP, WebSocket, in-process: not the protocol's concern.

## The two flaws in upstream's contract

Both flaws are silent in small tests and fatal at scale. Fixing them
is the reason this protocol exists as a rewrite rather than a copy.

### Flaw 1: the lost-write race

Upstream's pull contract is "give me rows with
`last_modified > lastPulledAt`", with a server timestamp. Here is how
that loses data: a write starts at 10:00:00.000 but its transaction
commits a moment *after* a concurrent pull already ran. The pull's
cursor says 10:00:00.050. The committed write's timestamp (10:00:00.000)
is *before* the cursor — so no future pull ever returns it. The
devices now disagree forever, and nothing reports an error. Any
timestamp assigned at write time (not commit time) has this race, and
upstream delegates the problem to backend discipline in prose.

**The fix: the cursor becomes opaque, with a commit-ordered contract.**
The client never inspects or compares cursors. The server must
guarantee one invariant:

> `pull(c)` returns changes drawn from **one consistent snapshot** `S`
> and a cursor `c'` identifying `S`. Every change committed after `S`
> — including changes concurrent with the pull that commit later —
> MUST be returned by some future `pull(c')`.

Visibility is ordered by *commit*, not by write time. Wall-clock
timestamps cannot satisfy this; a revision sequence assigned in commit
order, a transaction-horizon watermark, or a single-writer change log
all can (see [Backend obligations](#backend-obligations)).

### Flaw 2: the push echo

In upstream, the client re-downloads its own pushed changes on the
next pull. Equality checks absorb them, but they are transmitted and
diffed every time — under active use, no pull is ever empty. Upstream's
own limitations doc names the fix; this protocol adopts it:

**The fix: a push responds like a pull.** The push response carries a
new cursor plus whatever *other* clients committed in between
(`changes`), excluding the push's own records. The client applies
those foreign changes, marks its pushed records synced, and adopts the
cursor — its own writes never echo back.

Two rules keep this safe:

- **Degraded mode is legal.** A backend that can't compute the
  interleaved changes returns `cursor: null, changes: null`; the client
  keeps its old cursor and the next pull re-delivers the echo, which
  the apply engine absorbs. Correct either way; the fast path is
  opt-in per backend.
- **Cursor and changes are a package: both or neither.** Adopting a
  cursor while skipping the foreign changes committed under it would
  reintroduce the lost-write race through the back door.

## Protocol at a glance

```
pull(cursor | null, schemaVersion, migration | null)
  → { changes, cursor }            // normal
  → { resyncRequired: true }       // cursor unknown or expired

push(changes, cursor)
  → { cursor, changes, rejected? } // accepted (possibly degraded nulls)
  → { conflict: true }             // something changed server-side after
                                   // `cursor` — pull, re-merge, push again
```

- **First sync**: `cursor = null`; the server returns everything.
- **Conflict loop**: on `conflict`, the client pulls, re-merges, and
  pushes again, a bounded number of times (default 5), then surfaces
  an error to the app.
- **Resync**: on `resyncRequired`, the client re-pulls from `null` and
  reconciles against the full server state (update matching ids,
  create missing ones, destroy local *synced* records absent from the
  snapshot — local dirty records are merged and pushed as usual). This
  exists so servers can prune tombstones and change logs after a
  bounded retention window instead of keeping them forever.
- **Full records on the wire**: user columns plus `id`, nothing else.
  `_status`/`_changed` never cross the wire (a protocol rule, not a
  convention), and every record is complete — a sparse record would
  silently clobber local values with schema defaults, so clients
  reject it loudly.
- **Migration pulls**: after a local schema migration, the client
  sends `migration = { from, tables, columns }` so the server includes
  full records for newly tracked tables and columns.

### The cursor, and how it expires

Why is there a cursor at all? It is the minimal state that makes both
halves of the protocol work. On pull, it tells the server where the
client stopped, so sync can be incremental instead of a full download
every time. On push, it is the conflict horizon — "reject my edits if
anything I touched changed after this point" — without which the
server could not know what state an edit was based on, and conflict
detection would be impossible. That is also why pull always precedes
push: a push carries the cursor of the pull before it. The client's
entire obligation is: store the string, echo it back.

A cursor is also a promise the server makes: "I can still tell you
everything that changed after this snapshot." Keeping that promise
costs storage — above all, the server must remember every deletion
committed after the snapshot (tombstones, or a change log) — and no
server keeps it forever. Expiry is the server withdrawing the
promise, not a timeout: after a retention window of its choosing it
prunes old tombstones and, in the same stroke, raises the *floor* —
the oldest revision it can still serve completely (`gcFloor` in the
storage seam; the shipped store's `gc(floor)` raises it). Any pull
whose cursor lies below the floor is answered `resyncRequired`: the
server no longer knows everything it would need to send, and
answering with silently incomplete data is forbidden (obligation 3).
A cursor the server never issued — garbage, or a token from another
deployment — gets the same answer. "Expired" therefore always means
the client stayed away longer than the server's retention window, and
the cost is a full re-download, never wrong data.

## Backend obligations

A conforming backend MUST:

1. Serve each pull from one consistent snapshot (no per-table queries
   at different points in time).
2. Issue commit-ordered cursors: no change committed after a cursor's
   snapshot may ever be invisible to pulls from that cursor.
3. Retain deletions (tombstones or a change log) long enough to serve
   any cursor it hasn't declared expired; answer expired cursors with
   `resyncRequired`, never with silently incomplete data.
4. Apply each push atomically, and reject the whole push (`conflict`)
   if any pushed record was modified on the server after the push's
   cursor. The server never merges.
5. Never return a push cursor without the interleaved foreign changes.

Known-good cursor mechanisms (guidance, not mandate): a global
revision sequence assigned in commit order (serialized commit path or
advisory lock); a transaction-horizon watermark; an append-only change
log with a single writer. Wall-clock `last_modified` alone is
explicitly non-conforming.

You normally don't implement any of this by hand: the backend engine
ships as [`@remelondb/server`](../packages/server) (the protocol over
a small storage seam), and its `@remelondb/server/conformance` suite is
the executable version of this contract.

## Client engine notes

- The engine is core code: it reads and writes records through the
  same compiled-SQL path as everything else; tombstones and the cursor
  live in ordinary tables (`local_storage` for the cursor and
  last-synced schema version).
- Applying a pulled changeset follows upstream's decision tree, kept
  as-is: remote `created` that already exists locally → treat as
  update (logged anomaly); remote `updated` missing locally → create;
  remote update vs. local delete → the local delete wins and is pushed
  later; remote delete → always destroys, even over local changes.
  All overridable per record via `conflictResolver`.
- `fetchLocalChanges` strips `_status`/`_changed` at the boundary and
  snapshots raws; `markLocalChangesAsSynced` re-checks equality so a
  write that raced the push stays dirty and goes out next sync.
- The surface matches upstream (`synchronize()`,
  `hasUnsyncedChanges()`, logging hooks), minus turbo sync (deferred)
  and `_unsafeBatchPerCollection`.

## Trade-offs this design accepts

The fixes above close the *contract* flaws. What remains are deliberate
trade-offs — know them before building on the sync layer:

- **Last-writer-wins per column.** When two devices edit the same
  column offline, one value survives and the other is silently
  replaced. There is no operational merging (no CRDTs, no counters,
  no list unions) — `conflictResolver` is the escape hatch for tables
  that need smarter rules.
- **Merges are per column, invariants often aren't.** If an invariant
  spans columns (`start < end`, quantity vs. total), a merge can
  produce a record neither device wrote. The protocol guarantees
  convergence, not domain validity.
- **Deletes are blunt.** A remote delete destroys the record even over
  local unpushed edits; there is no trash-can semantics at the
  protocol level.
- **Resync is a full re-download.** Past the server's retention
  window, the only recovery is pulling everything. That's the price of
  letting servers prune tombstones.
- **One cursor, whole database.** No per-table or partial sync in v1
  (see open questions).

## Open questions

1. **Sparse updates** (`updated` as changed-columns-only): halves
   payloads for wide tables but complicates apply and server storage.
   Keep full records in v1; reserve a capability flag.
2. **`changedColumns` hint client→server**: would enable per-column
   server conflict detection. Omit in v1 — per-record reject-and-merge
   is simpler and provably convergent.
3. **Cursor scope**: single cursor vs. per-table cursors. Per-table
   enables partial/priority sync but multiplies every invariant.
   Single cursor in v1.
