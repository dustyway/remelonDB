# Architecture: how the pieces fit

Orientation for people working on the library. It covers the shape of the
system, where each concern lives, and what happens end to end on a write, a
read, and a sync. It states structure and points elsewhere for detail: the
design decisions explain *why* each boundary is where it is, the reference
guides explain *what* each layer does, and the conformance suites are the
contract when prose and tests disagree.

Using remelonDB requires none of this. Start at [tutorial.md](tutorial.md)
for that.

## What the library is

An offline-first data layer. Applications read and write a local SQLite
database and never wait on a network; a separate sync process reconciles
that database with a server and with the user's other devices. The
responsiveness is the easy half. The hard half is that two devices can
change the same data while neither can see the other, and both must
converge without losing work.

Two commitments shape everything else.

**A query is data.** `Q.where('done', false)` builds a plain object. One
pure function compiles it to parameterized SQL. Nothing executes until a
query is fetched or observed.

**One engine.** SQLite everywhere, including in the observation path, which
re-queries rather than matching rows in memory. Query semantics are
inherited from the engine rather than reimplemented per platform, so they
cannot drift between platforms.

Both are argued in [q-dsl-and-one-engine.md](q-dsl-and-one-engine.md), with
the upstream context in [upstream-study.md](upstream-study.md).

## The shape

```
┌─────────────────────────────────────────────────────────────┐
│ Public API: Model, Collection, Query (Q DSL), observation,  │
│ sync                                                        │
├─────────────────────────────────────────────────────────────┤
│ Core (one implementation, pure TS)                          │
├──────────────────── SqliteDriver seam ──────────────────────┤
│ react-native driver │ web driver          │ node driver     │
└─────────────────────────────────────────────────────────────┘
```

Everything above the seam is written once and identical on every platform.
Everything below it is multiplied by the number of platforms, which is why
the seam is seven methods that speak only SQL. Roughly 4,300 of the
library's lines sit in `core`; the Node and React Native drivers are about
a hundred lines each.

The same move appears on the server: protocol semantics in an engine,
storage behind an eight-method seam. Two seams, both placed so that the
part which is easy to get wrong is written once.

## Where each concern lives

| Concern | Code | Reference |
| --- | --- | --- |
| Table and column definitions, migrations | `core/src/schema/` | [reference/schema.md](reference/schema.md) |
| Zod-derived tables and wire validators | `core/src/zod/` | [zod-adapter.md](zod-adapter.md) |
| Row representation, sanitization, dirty tracking | `core/src/rawRecord/` | [reference/records.md](reference/records.md) |
| Model classes and generated accessors | `core/src/model/` | [reference/models.md](reference/models.md) |
| Query AST, builders, SQL compiler | `core/src/query/` | [reference/queries.md](reference/queries.md) |
| Database, collections, work queue, cache, observation | `core/src/database/` | [reference/database.md](reference/database.md) |
| Client sync engine | `core/src/sync/` | [reference/sync.md](reference/sync.md) |
| The driver contract | `core/src/driver/`, `core/src/conformance/` | [reference/driver.md](reference/driver.md) |
| Server protocol engine and storage seam | `server/src/` | [reference/backend.md](reference/backend.md) |

Three things that look like they should be driver or store features are
deliberately not: tombstones are rows with `_status = 'deleted'`, local
storage is a `local_storage` table, and schema setup is ordinary DDL sent
through the same batch path as any write. Each is plain SQL issued by core,
which is what keeps the seam small enough to reimplement per platform
without risk.

## Life of a write

`db.write(() => collection.create({ ... }))`:

1. **Queue.** The block enters a strictly serial FIFO queue. One piece of
   work runs at a time, and the queue is not re-entrant.
2. **Sanitize.** Input passes `sanitizedRaw`, which produces a record that
   is valid by construction: every schema column present and type-correct,
   unknown keys dropped, sync fields well-formed.
3. **Compile.** Operations become SQL statements; consecutive operations
   with identical SQL are grouped so the statement is prepared once and run
   per argument set.
4. **Persist.** `driver.executeBatch` commits all statements or none. A
   rejection stops here, and in-memory state is untouched.
5. **Update caches.** Created and updated records land in the identity map;
   existing instances are mutated in place, so object identity is stable
   across updates.
6. **Notify.** Database-level subscribers whose tables were touched, then
   collection-level subscribers. Both run after every cache is current, so
   no subscriber sees a half-updated world.

Steps 4 through 6 are ordered so a failure at 4 leaves 5 and 6 unreached.
That ordering is the batch failure contract, decision 7 in
[layers.md](layers.md).

## Life of an observed read

`query.observe(callback)` emits immediately, then on every relevant change:

1. The query declares the tables it depends on, its own plus any joined.
2. A committed change to any of them triggers a re-fetch. There is no
   in-memory matcher deciding whether a changed row would match; the query
   simply runs again.
3. The new result list is compared against the previous emission by length,
   by per-position record identity, and by the content of visible columns.
   Bookkeeping columns are excluded, so sync marking records synced emits
   nothing.
4. If it differs, the subscriber receives the complete current answer, not a
   diff. A fresh array of canonical cached instances.

Because results are always complete, integrating with a UI framework is
trivial: the React hook in the example application is twelve lines that pipe
emissions into state.

Fetches are asynchronous, so each carries a generation number and a late
result from a superseded fetch is discarded.

## Life of a sync

Two phases, always in this order:

1. **Pull.** Send the stored cursor, apply what comes back, store the new
   cursor.
2. **Push.** Send every dirty record and tombstone, mark them clean once
   accepted.

The cursor is an opaque server-issued token. Clients store and echo it and
never inspect, compare, or order it. That opacity is what lets the server
guarantee commit-ordered visibility, which timestamps cannot; the race it
prevents is worked through in [sync-design.md](sync-design.md).

A push response is shaped like a pull response: a new cursor plus whatever
other clients committed in between, excluding the pushing client's own
records. That is what stops a client re-downloading its own writes forever.
The cursor and the changes travel together or not at all.

Conflicts are resolved on the client, per column. The merged record is the
remote version with locally-changed columns laid back on top, so two devices
editing different columns both keep their edits, and two editing the same
column resolve to the later pusher. Wall-clock time decides nothing.
[sync-basics.md](sync-basics.md) covers the behavior in plain language and
how to override the policy.

The protocol has a normative contract in [sync-wire.md](sync-wire.md) and a
formal model in [sync_model.qnt](sync_model.qnt), explained in
[formal-model.md](formal-model.md). The model found one obligation that
prose review missed.

## The two seams

|  | `SqliteDriver` | `SyncStore` |
| --- | --- | --- |
| Sits between | core and a platform's SQLite | the protocol engine and a database |
| Knows about | SQL strings, arguments, rows | rows, revisions, scopes |
| Does not know about | queries, records, schemas, sync | cursors, conflicts, the wire |
| Methods | 7 | 8 |
| Proven by | `@remelondb/core/conformance` | `@remelondb/server/conformance` |

Both are asynchronous throughout. For the driver that is forced by the web
platform, where SQLite runs in a Worker because the storage API requires it,
and core must therefore never depend on same-tick resolution.

Both carry obligations that types cannot express: the driver's batch must be
atomic, and the store's pushes must serialize per scope. Those are what the
conformance suites exist to check, and passing the suite is what
"conforming" means.

## Reading order

New to the codebase, in this order:

1. This document.
2. [tutorial.md](tutorial.md) — the API surface from the outside.
3. [q-dsl-and-one-engine.md](q-dsl-and-one-engine.md) and
   [layers.md](layers.md) — the two decisions
   everything else follows from.
4. The reference guide for whichever layer you are changing.
5. [sync-design.md](sync-design.md) before touching anything sync.

Changing the library, three habits are worth adopting. Pure layers get
exact-output unit tests; anything with semantics gets a conformance test
against real SQLite. Prefixing an API `unsafe` means it waives a guarantee
the rest of the system maintains, which makes those waivers greppable. And
when prose and tests disagree, the tests are the contract.
