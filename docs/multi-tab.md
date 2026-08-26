# Multi-tab (design)

Status: implemented behind the opt-in `{ shared: true }` driver option —
transport, refcounted opens, write arbitration, change broadcast, and
sync-lease ownership all ship, covered by the browser suites on
Chromium, Firefox, WebKit, and Safari, plus the forced-fallback run and
the todo-sync example's two-tab e2e (deployed at todo.dustyway.org).
The remaining gate before shared becomes the default is the open
questions below. The single-owner behavior — fail fast when another tab
holds the database, opt-in takeover — remains the default and the
no-`SharedWorker` fallback.

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

## Design: a SharedWorker brokers, a tab hosts the compute

A `SharedWorker` is instantiated once per origin; every tab that asks
for it connects to the same instance over its own `MessagePort`. Its
lifetime is exactly the coordination semantics we want: it starts with
the first tab and dies with the last. Coordination is a fact of the
platform, not a protocol we run — there is no election and no
frozen-coordinator case, because no tab hosts the broker.

**Why the broker cannot run or spawn SQLite itself.** OPFS sync-access
handles exist only in dedicated workers, and Chromium's
`SharedWorkerGlobalScope` has no `Worker` constructor at all
(`typeof Worker === 'undefined'` there; WebKit behaves the same,
Firefox does expose it) — verified empirically after a first
implementation attempt hung silently on exactly this. So the
SharedWorker can neither host the SAH pool nor spawn the worker that
does.

**Structure: tabs → SharedWorker (broker) ⇄ compute worker hosted by a
tab.** The broker owns all coordination state: routing, id namespacing,
open refcounts, write arbitration. When it first needs SQLite it asks a
connected tab to spawn the existing `worker.ts` (pages can always spawn
dedicated workers); the tab creates a `MessageChannel`, hands one port
to the broker and the other into the spawned worker. The broker then
talks to SQLite over a direct channel — no per-message hop through the
host tab.

**Host death.** The host tab dying takes the compute worker with it,
but never the state: the broker survives, detects the loss passively
(a request unanswered past a timeout — no heartbeats), asks another
connected tab to spawn a fresh worker, reopens the held names, and
fails in-flight requests loudly, the same error surface takeover has
today. This is the one fragment of the leader design that survives;
election, lock ceremony, and follower re-pointing do not, because
identity never moves.

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
interleave. The SharedWorker arbitrates: a plain FIFO queue of
write-block tokens (`acquireSlot`/`releaseSlot`), exclusive granted one
at a time, `db.read` consistency windows granted shared. In-process
code, no cross-context locks. Single-tab behavior is unchanged: an
uncontended grant is immediate.

**The ordering invariant (do not refactor this away).** Core acquires
the slot BEFORE entering its local work queue, not inside it. While a
context waits for its grant, its queue stays free to apply change
broadcasts from the other contexts — and because a holder publishes its
changes before it releases, per-port FIFO delivery guarantees the grant
response arrives after every broadcast committed before it. A block
therefore always reads a cache that includes everything serialized
ahead of it. The first implementation acquired the slot inside the
queue; broadcasts then parked behind the waiting block, whose reads
trusted a stale cache and overwrote another tab's committed increment —
a storage-level lost update, caught by the convergence test the moment
broadcast existed. Serializing blocks is not enough; blocks must also
happen-after what they were serialized behind, and the transport's
message ordering is what provides that for free.

**Change propagation.** After each committed batch, core hands the
batch's change set to the driver (`publishChanges`, best-effort and
fire-and-forget — a lost notification is a stale cache until the next
one, never data loss); the driver relays it to the broker, which fans
it out to every OTHER port holding that database — never back to the
sender, whose commit already updated its own cache (self-echo would
loop). The receiving driver hands the set to core
(`onExternalChanges`), which routes it into
`database.applyExternalChanges`: cached raws updated in place exactly
as batch commit does, then the collection and database change buses
notified. Observers behave as if the write were local. The doorway is
a new entry point sharing the commit path's cache-and-notify tail (a
provenance flag on `batch` was considered and rejected: the broadcast
arrives in the commit path's OUTPUT shape and must skip the writer
assertion and driver encoding).

**Sync runs on one tab at a time, via a lease.** `synchronize`
consults the driver's `requestSyncTurn` at entry; in shared mode that
asks the broker for the sync lease (`syncTurn`). The broker grants the
asker that already holds it (each tick renews), or a free or expired
lease; everyone else's tick returns early without touching the
network. A lease rather than a lock, deliberately: the holder's
periodic ticks are its heartbeat, so a closed tab simply stops
renewing and another tab inherits within the lease duration — no
death detection, self-healing. Apps change nothing: a naive
sync-interval in every tab becomes correct because only the holder's
`synchronize` actually runs.

One bounded edge: the lease gates the START of a run, it does not
cancel one in flight. A sync outlasting the lease (default 10s) lets
another tab inherit mid-run and sync concurrently for one round — the
protocol resolves that like any device-vs-device race, so the cost is
a conflict retry, not corruption. Keep `syncLeaseMs` comfortably above
the worst-case sync duration.

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
workers inside a SharedWorker are NOT part of the design: Chromium and
WebKit do not expose `Worker` in `SharedWorkerGlobalScope` (Firefox
does), which is what forced the broker/port-handoff structure. The
compute worker is spawned by a page, where dedicated workers work
everywhere. `MessagePort` transfer into a SharedWorker — the one
capability the design leans on — is long-standing in all supported
browsers.

## What this cost in core

Three seams, all optional and inert without a sharing driver (the
original design hoped for one; arbitration and propagation each needed
their own):

- `database.applyExternalChanges(changes)` — the receiving doorway.
- `SqliteDriver.acquireWorkSlot?(exclusive)` — cross-context block
  arbitration, held by `write`/`read` around their blocks.
- `SqliteDriver.publishChanges?` / `onExternalChanges?` — the two
  halves of change propagation.

The protocol gained broker-only ops (`acquireSlot`, `releaseSlot`,
`publishChanges`), the `ping` probe, three broker-to-tab control messages, and
the tab-to-broker `adoptWorkerPort` handoff. The full op table lives in the
driver-web README, since the base protocol serves every mode, not just
multi-tab.

## What does not change

The sync wire protocol, the server packages, and the Node/RN drivers
are untouched (they simply don't implement the optional seams). So is
the single-tab dedicated path: no broker, no slots, no broadcasts —
bit-identical behavior to before this work.

## Verification plan

A dedicated browser suite in `@remelondb/driver-web`, same style as
the existing conformance runs: the spawn/port-handoff boot works on
every target browser; N tabs connect and resolve to one owner; a write in
any tab is observed in every tab (list membership and content changes
both); closing the last tab and reopening finds the data (owner
teardown released the pool); the write arbiter prevents interleaved
write blocks (two tabs racing read-modify-write converge correctly);
sync runs exactly once across tabs. The fallback path is part of the
suite, not an assumption: a dedicated run deletes the `SharedWorker`
constructor from the realm (no driver option needed) and proves
`{ shared: true }` reproduces the single-owner semantics — fail fast,
takeover with notification, coordination seams degrading to no-ops. The todo-sync example then
drops the "use a private window" caveat and demonstrates two real
tabs.

## Open questions

- A tab dying while HOLDING a write slot leaks it and stalls every
  writer: the broker's liveness probe covers dead compute, not dead
  slot holders. Two candidates: a deadline on held slots (the lease
  pattern that solved sync ownership), or a per-tab Web Lock the
  broker can test (`ifAvailable`) when a slot outlives a deadline.
- Backpressure on forwarded statements from a very chatty tab.
- Whether a frozen (not dead) host tab freezes its dedicated worker
  with it. If it does, passive detection covers it the same as death,
  since recruitment cannot distinguish the two anyway. A frozen tab is
  a silent candidate and gets passed over, and one that thaws and
  hands over a worker after another tab won is told to discard it.
  Verify empirically before relying on it.
- Whether the broker should proactively re-host when the host tab
  reports `pagehide`, rather than waiting for the ping to notice.
  Recruitment itself is settled. Candidates are asked one at a time
  with a deadline each, so a silent tab costs one deadline rather than
  the whole session (remelonDB#38).
- Debugging ergonomics: SharedWorkers are inspected via
  `chrome://inspect/#workers`, not the page devtools — worth a note in
  the driver README when this ships.
