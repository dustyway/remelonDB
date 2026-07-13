# Architecture layers and the driver seam

Builds on `q-dsl-and-one-engine.md` (queries are data; SQLite is the single
engine) and `upstream-study.md` (what upstream does and where it hurts).

## The core idea: move the seam down

Upstream's portability seam is the `DatabaseAdapter` interface — 17 methods
that speak ORM concepts: serialized queries, record caching, tombstones
(`getDeletedRecords`), KV local storage (`getLocal`), sync JSON. Every adapter
(SQLite native, SQLite Node, LokiJS) had to reimplement those concepts, which
is how the project ended up with two engines and drifting semantics.

Since we committed to one engine, the seam can sit much lower: a **SQLite
driver** that executes SQL and knows nothing about queries, records, sync, or
schemas. Everything above it is written once, in TypeScript, and is identical
on every platform.

```
┌─────────────────────────────────────────────────────────────┐
│ Public API: Model, Collection, Query (Q DSL), observation,  │
│ sync                                                        │
├─────────────────────────────────────────────────────────────┤
│ Core (one implementation, pure TS):                         │
│  • Q → SQL compiler (parameterized, single pure function)   │
│  • schema DDL + migration-step compiler                     │
│  • RecordCache (identity map — sole owner of caching)       │
│  • writer/reader queue, change-notification bus             │
│  • in-memory matcher (gated, conformance-tested vs SQLite)  │
│  • sync engine (rev-cursor protocol)                        │
│  • tombstones + local storage = ordinary SQL over the driver│
├──────────────────── SqliteDriver seam ──────────────────────┤
│ react-native driver │ web driver          │ node driver     │
│ C++ TurboModule +   │ SQLite-WASM + OPFS  │ better-sqlite3  │
│ bundled sqlite3,    │ in a Worker         │ (tests, tooling,│
│ New-Arch/bridgeless │ (deferred, but seam │  conformance    │
│                     │  designed for now)  │  suite)         │
└─────────────────────────────────────────────────────────────┘
```

What upstream got right and we keep: **SQL is compiled in JS before crossing
the boundary.** The driver never sees a query AST. What changes: the driver
also never sees records, caches, tombstones, or sync — those become core code
running plain SQL.

## The SqliteDriver interface (sketch)

Deliberately dumb. Target: ~7 methods, all parameterized, no callbacks
(Promises), no per-driver semantics.

```ts
type SqlValue = string | number | boolean | null
type SqlArgs = SqlValue[]

interface SqliteDriver {
  /** Open (creating if needed) and return the current PRAGMA user_version. */
  open(name: string, opts?: DriverOptions): Promise<{ userVersion: number }>
  close(): Promise<void>

  /** SELECT. Rows come back column-name-keyed (or columnar — see perf note). */
  query(sql: string, args: SqlArgs): Promise<Row[]>

  /** Single non-SELECT statement (DDL during setup, PRAGMAs). */
  execute(sql: string, args: SqlArgs): Promise<void>

  /**
   * Atomic write transaction: all statements commit or none do.
   * The sole mutation path for records, tombstones, local storage.
   */
  executeBatch(statements: Array<[sql: string, argSets: SqlArgs[]]>): Promise<void>

  setUserVersion(version: number): Promise<void>

  /** Delete the database file(s). Used by unsafeResetDatabase. */
  destroy(): Promise<void>
}
```

Notes:

- **Async at the seam, always.** The web driver lives in a Worker (OPFS
  sync-access handles require it), so the seam must be Promise-shaped or web
  becomes a second-class citizen — exactly what we promised not to do. The RN
  JSI driver may resolve everything synchronously under the hood; core must
  never depend on same-tick resolution for correctness. If benchmarks later
  show microtask latency hurting hot paths, we can add an optional sync fast
  path as a driver *capability* — an optimization, not a semantic.
- **Parameterized SQL end to end.** Upstream inlines query values via string
  escaping (its own code flags this as wrong). Our compiler emits `?`
  placeholders everywhere; `SqlValue` is the entire value vocabulary crossing
  the seam.
- **`executeBatch` is the transaction primitive.** Upstream's batch opcode
  format (with its cache-behavior flags) collapses to "statements + arg sets,
  atomically". Grouping arg-sets under one SQL string keeps the
  prepare-once-run-many optimization upstream's encodeBatch does.
- **Two-phase init survives** as core logic: `open()` returns `userVersion`;
  core decides fresh-setup vs migration vs ready and sends the DDL itself.
  Upstream's silent destroy-on-missing-migration-path becomes an explicit
  error with an opt-in escape hatch.

## Decisions (and what they fix)

**1. Record cache lives only in JS.** Upstream splits cache ownership across
the boundary: native tracks which ids JS has seen and sends bare ids for
those; the two sides desync in production (RecordCache has a telemetry-
confirmed recovery path for it). We drop the protocol: drivers always return
full rows; core's RecordCache (the identity map) decides whether to reuse an
existing Model. One owner, no desync class. The serialization cost this
protocol saved is real but unproven on Hermes + JSI — if profiling shows it
matters, the fix is a columnar result format or a driver-side row filter
keyed by an explicit id-list argument, not a stateful shadow cache.

**2. Tombstones and local storage are core features, not driver methods.**
`_status='deleted'` rows and a `local_storage` table are ordinary SQL that
core issues through the driver. Sync reads tombstones with a compiled query
like any other. Removes 5 methods from the seam and makes the web driver
trivially sync-capable.

**3. The Q→SQL compiler is one pure function, tested by conformance.** Same
compiler output runs on all three drivers. A Node conformance suite runs the
same query corpus against better-sqlite3 (and later the WASM driver) and
asserts identical results; the in-memory matcher is tested against those same
SQLite results, not against its own reimplementation of the rules. Semantics
simplifications now that Loki is gone: LEFT JOIN always (no inner-join
heuristic), `LIKE` escaping via `ESCAPE` clause (not lossy character
replacement), drop `unsafeLokiExpr`/`lokiTransform`, keep `IS`/`IS NOT` null
behavior and document it as SQLite semantics. Deleted-record filtering
becomes a compiler flag, not a description-tree rewrite.

**4. React Native driver is a C++ TurboModule.** Bridgeless-compatible by
construction: codegen'd spec, C++ implementation shared across iOS/Android,
JSI under the hood without touching `RCTCxxBridge` or manual
`global.*` installs. Android links JSI via prefab (`ReactAndroid::jsi`) —
never compiles `jsi.cpp` (the RN 0.86 breakage). We bundle the sqlite3
amalgamation (predictable version, FTS5 on, 16KB-page-aligned `.so`, modern
NDK/AGP). Database work runs on the JS thread guarded by a mutex, matching
upstream's JSI mode; teardown hooks into the TurboModule invalidate lifecycle
instead of upstream's Catalyst-reflection hack.

**5. One notification mechanism, no RxJS.** Upstream's core is already
Rx-free behind a shim; it maintains parallel Rx and callback subscriber lists
with load-bearing ordering. We keep only the callback bus +
`SharedSubscribable`-style multicast; `observe()` returns a minimal
Observable-compatible object for ecosystem interop without the dependency.

**6. Keep the two-strategy observation with the same gate.** Flat
single-table queries → in-memory matcher; joins/sort/take/skip → re-query on
relevant table change. Upstream's `observeWithColumns` race machinery and the
knowingly-buggy count throttle are not carried over; with a single async seam
the observer state machine is written once, simply.

**7. Batch commit gets a real failure contract.** Upstream clears records'
prepared state before the adapter call and has a `TODO: What if this fails?`.
Here: driver `executeBatch` is atomic; core applies cache changes and
notifications only after it resolves; on rejection, records stay prepared and
the error propagates to the writer block.

## What this enables next

- The **conformance suite** can exist before any native code: core + node
  driver is a complete, testable database.
- The **sync engine** (rev-cursor, push-returns-cursor to kill the echo,
  server-side snapshot rules to kill the lost-write race) is pure core logic
  over the same seam — designed in its own doc.
- The **web driver** is an implementation task, not a design task: same SQL,
  same compiler, Worker + OPFS plumbing only.

## Open questions

1. **Result shape at the seam**: row objects (`Row[]`) vs columnar
   (`[columns, ...values]`). Columnar is faster to materialize across JSI and
   upstream measured wins on JSC; row objects are simpler everywhere.
   Proposal: start with row objects, keep the type opaque enough to switch
   after profiling.
2. **Prepared-statement caching**: driver-internal (transparent) vs explicit
   handles at the seam. Proposal: transparent, keyed by SQL text, per driver.
3. **Turbo first-sync path** (upstream's native JSON bulk-load): omit
   initially; the rev-based first sync can chunk through `executeBatch`.
   Revisit only if first-sync benchmarks demand it.
