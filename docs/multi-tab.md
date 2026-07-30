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

## Design: a SharedWorker owns the database

A `SharedWorker` is instantiated once per origin; every tab that asks
for it connects to the same instance over its own `MessagePort`. Its
lifetime is exactly the ownership semantics we want: it starts with the
first tab and dies with the last. Ownership is a fact of the platform,
not a protocol we run — there is no election, no handoff on tab death,
and no frozen-owner case, because no tab hosts the owner.

**Structure: tabs → SharedWorker → dedicated worker.** OPFS
sync-access handles exist only in dedicated workers, so the
SharedWorker cannot run SQLite itself. It spawns the existing
`worker.ts` as a nested dedicated worker and routes to it. The
SharedWorker is owner, router, and write arbiter; SQLite and the SAH
pool stay where they are.

**Tab driver = the same protocol over a different transport.** The web
driver already speaks a postMessage RPC (`protocol.ts`) of
structured-clonable plain data through an `Endpoint` abstraction. A
tab's `WebSqliteDriver` gets an endpoint whose transport is its
`SharedWorker` port; the SharedWorker forwards requests to the nested
worker and routes responses back by port. No new protocol — the seam
was built for exactly this substitution.

**Write serialization across tabs.** Statements from all tabs flow
through the one connection, which serializes them — but a `db.write`
block is multiple statements, and two tabs' blocks must not
interleave. The SharedWorker arbitrates: a plain queue of write-block
tokens, granted one at a time, `db.read` consistency windows granted
shared. In-process code, no cross-context locks. Single-tab behavior
is unchanged: an uncontended grant is immediate.

**Change propagation.** After each committed batch, the SharedWorker
broadcasts the batch's change sets to every connected port — raw-level
records keyed by table, the shape the change buses already deliver.
Every other tab applies them through a new core doorway (working name
`database.applyExternalChanges(changes)`): update cached raws in place
exactly as batch commit does, then notify the collection and database
change buses. Observers then behave as if the write were local —
including content-only re-emissions on reloading queries. The doorway
is the only core change this design needs; everything else lives in
the web driver package.

**Sync stays single-owner.** Only the SharedWorker runs `synchronize`
and holds the autosync loop; it broadcasts sync status alongside
change sets. Tab-initiated sync requests are forwarded, not run
locally.

**Fallback without `SharedWorker`.** Feature-detect. Where it is
missing (Chrome for Android), the driver behaves as it ships today:
single owner per origin, fail fast or takeover. Degraded, not broken —
and Android is served by the native RN drivers, not the mobile web.

The fallback is a contract, not an accident: the tab-side API is
identical in both modes — same driver options, same errors, same
`onTakenOver` semantics — so application code never branches on which
mode it got. An app written for multi-tab runs unchanged in fallback
mode; its takeover UI simply becomes reachable again.

## Browser support

`SharedWorker`: Chrome and Edge desktop, Firefox, Safari 16+ (desktop
and iOS). Missing on Chrome for Android and Android WebView. Nested
dedicated workers are required for the SQLite worker; Chrome and
Firefox have them long-standing, Safari gained them recently — the
verification suite checks this first, it is the design's riskiest
platform assumption.

## What does not change

The wire protocol, the server packages, and the Node/RN drivers are
untouched. So is the single-tab path: one tab means one port and no
contention; the only addition is the SharedWorker hop between tab and
SQLite worker.

## Verification plan

A dedicated browser suite in `@remelondb/driver-web`, same style as
the existing conformance runs: nested-worker spawn works on every
target browser; N tabs connect and resolve to one owner; a write in
any tab is observed in every tab (list membership and content changes
both); closing the last tab and reopening finds the data (owner
teardown released the pool); the write arbiter prevents interleaved
write blocks (two tabs racing read-modify-write converge correctly);
sync runs exactly once across tabs. The fallback path is part of the
suite, not an assumption: a run with `SharedWorker` forcibly disabled
(an option the driver exposes for exactly this) must reproduce
today's single-owner conformance results. The todo-sync example then
drops the "use a private window" caveat and demonstrates two real
tabs.

## Open questions

- Whether `applyExternalChanges` is a new entry point or a provenance
  flag on the existing batch-commit path (skip the driver writes, keep
  the cache update and notifications).
- Backpressure on forwarded statements from a very chatty tab.
- The SharedWorker's error story when the nested worker dies: restart
  it transparently (retrying like takeover does today) or surface the
  error to every tab.
- Debugging ergonomics: SharedWorkers are inspected via
  `chrome://inspect/#workers`, not the page devtools — worth a note in
  the driver README when this ships.
