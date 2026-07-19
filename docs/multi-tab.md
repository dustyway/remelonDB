# Multi-tab (design)

Status: designed, not implemented. The single-owner half — fail fast
when another tab holds the database, opt-in takeover — ships in
`@remelondb/driver-web` (its README documents the API). This page
records the design for the full goal: every tab live at once, all
observing and writing the same database.

## The problem has two layers

1. **Storage access.** The OPFS SAH-pool VFS acquires exclusive file
   handles: one pool owner per origin. A second tab cannot open the
   same database at all.
2. **Change propagation.** Each tab runs its own `Database`, record
   cache, and observers. The record cache is authoritative by design:
   a refetch returns the cached instance and ignores fresh row content
   for known ids. Even with shared storage, a write committed by tab A
   is invisible to tab B — B's cache would keep serving the old values.

Layer 2 is the deeper one. Any solution that only shares the file
(for example, switching to the original `opfs` VFS, which supports
concurrent connections at the cost of COOP/COEP headers and lower
throughput) still leaves every other tab blind to changes. That route
is rejected: it pays a real cost and solves the wrong half.

## Design: one leader, forwarding followers

**Election.** Tabs contend for a Web Lock (`remelondb:<name>:leader`).
The winner opens the real driver; the rest become followers. Web Locks
are origin-scoped, released automatically on tab death, and available
everywhere the driver runs — including Chrome for Android, which has no
`SharedWorker` (that is why a SharedWorker owner is not the mainline
design, though the leader role could optionally live in one where
available).

**Follower driver = the same protocol over a different transport.**
The web driver already speaks a postMessage RPC (`protocol.ts`) of
structured-clonable plain data through an `Endpoint` abstraction. A
follower's `WebSqliteDriver` gets an endpoint whose transport is a
`MessagePort` to the leader page instead of a worker; the leader
forwards requests to its worker and routes responses back. No new
protocol — the seam was built for exactly this substitution.
(`BroadcastChannel` carries discovery and announcements; per-pair
`MessagePort`s, handed over via the channel, carry the RPC.)

**Write serialization across tabs.** Statements from all tabs flow
through the leader's single connection, which serializes them — but a
`db.write` block is multiple statements, and two tabs' blocks must not
interleave. The writer queue therefore takes a second Web Lock
(`remelondb:<name>:writer`, exclusive) for the duration of a write
block; `db.read` consistency windows take the same lock in `shared`
mode. Single-tab behavior is unchanged: an uncontended Web Lock is
cheap, and the in-process queue already serializes locally.

**Change propagation.** After each committed batch, the leader
broadcasts the batch's change sets — raw-level records keyed by table,
the shape the change buses already deliver. Every other tab applies
them through a new core doorway (working name
`database.applyExternalChanges(changes)`): update cached raws in place
exactly as batch commit does, then notify the collection and database
change buses. Observers then behave as if the write were local —
including content-only re-emissions on reloading queries. The doorway
is the only core change this design needs; everything else lives in the
web driver package.

**Leader handoff.** When the leader tab dies, its locks release. A
follower wins the next election, opens the driver (retrying while the
old worker's handles come free), and announces itself; followers
re-point their endpoints. In-flight requests at the moment of handoff
fail and surface as errors — write blocks are transactions, so a
half-forwarded block rolls back rather than half-applying. A frozen
(background-suspended) leader still holds its lock; followers detect
staleness by heartbeat over the channel and steal after a timeout.

**Sync stays single-owner.** Only the leader runs `synchronize` and
holds the autosync loop; it broadcasts sync status alongside change
sets. Follower-initiated sync requests are forwarded, not run locally.

## What does not change

The wire protocol, the server packages, and the Node/RN drivers are
untouched. So is the single-tab path: with one tab, the leader is
elected instantly, no forwarding happens, and the only addition is one
uncontended lock per write block.

## Verification plan

A dedicated browser suite in `@remelondb/driver-web`, same style as the
existing conformance runs: election with N contenders resolves to one
leader; a write in any tab is observed in every tab (list membership
and content changes both); leader death promotes a follower with no
data loss; the writer lock prevents interleaved write blocks (two tabs
racing read-modify-write converge correctly); sync runs exactly once
across tabs. The todo-sync example then drops the "use a private
window" caveat and demonstrates two real tabs.

## Open questions

- Whether `applyExternalChanges` is a new entry point or a provenance
  flag on the existing batch-commit path (skip the driver writes, keep
  the cache update and notifications).
- Exact `MessagePort` handshake and its behavior when a follower
  connects mid-handoff.
- Backpressure on forwarded statements from a very chatty follower.
- Whether the leader should downgrade gracefully when its tab is
  bfcached rather than relying on heartbeat timeout alone.
