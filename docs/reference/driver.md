# Driver contract reference

The `SqliteDriver` interface is the project's portability seam
([architecture-layers.md](../architecture-layers.md)): a deliberately dumb
SQL executor. A driver knows nothing about queries, records, schemas,
tombstones, or sync — all of that is core code emitting SQL. Implementing a
new platform means implementing these seven methods and passing the
conformance suites.

```ts
interface SqliteDriver {
  open(name: string): Promise<{ userVersion: number }>
  close(): Promise<void>
  query(sql: string, args: SqlArgs): Promise<Row[]>
  execute(sql: string, args: SqlArgs): Promise<void>
  executeBatch(statements: readonly BatchStatement[]): Promise<void>
  setUserVersion(version: number): Promise<void>
  destroy(): Promise<void>
}
```

## Why the seam is async

The web driver must live in a Worker: OPFS `FileSystemSyncAccessHandle` —
the only fast persistent file API SQLite-WASM can build on — is exposed
*only* in dedicated workers, and the main thread can reach a worker only
asynchronously (`postMessage`; `Atomics.wait` is forbidden on the main
thread). A seam that assumed synchronous results would make web a
second-class platform permanently.

Consequences for implementers and for core:

- Drivers **may** resolve synchronously under the hood (the Node driver
  does; the future RN JSI driver will). Core must never depend on same-tick
  resolution for correctness.
- If profiling ever shows microtask latency hurting native hot paths, a
  synchronous fast path can be added as an optional driver *capability* —
  an optimization, never a semantic requirement.

## Method obligations

**`open(name)`** — open or create the database and report
`PRAGMA user_version`. No schema knowledge: core reads the version and
decides fresh-setup / migrate / ready (see
[schema.md](schema.md#setup-flow-two-phase-init)). Opening an already-open
driver is an error.

**`query(sql, args)`** — run a SELECT, return all rows as
column-name-keyed objects. Values are storage representation (booleans come
back as `0`/`1`; core sanitizes — see [records.md](records.md)).

**`execute(sql, args)`** — one non-SELECT statement (DDL, PRAGMAs).
One statement per call: drivers prepare single statements, so
multi-statement strings are invalid everywhere.

**`executeBatch(statements)`** — THE mutation path. Each entry is
`[sql, argSets[]]`: prepare once, run per arg set. The whole batch is one
transaction: **all statements commit or none do**, including across entries.
On failure, reject and leave the database untouched — core relies on this
to apply record-cache changes and change notifications only after the batch
resolves (the batch failure contract upstream never had).

**`setUserVersion(v)`** — set `PRAGMA user_version`. Called by core after
successful setup or migration.

**`close()`** — release the handle; subsequent calls must fail loudly.

**`destroy()`** — delete the database *and its sidecar files* (`-wal`,
`-shm`). Used by database reset; must leave nothing that would resurrect
state on the next `open`.

## Value conventions

- `SqlValue = string | number | boolean | null` is the entire vocabulary
  crossing the seam, both directions. No `undefined`, no objects, no
  `Date`s — core guarantees this on the way in.
- **Booleans**: accepted as bind args, stored as `0`/`1` (SQLite has no
  boolean storage class). Drivers own the write-side conversion.
- `SqlArgs` is `readonly` — drivers must never mutate argument arrays.
- Errors: reject the Promise with a real `Error`. No error-as-return-value
  conventions (a lesson from upstream's Android JSI layer).

## Implementing a new driver

1. Implement the seven methods over your platform's SQLite.
2. Recommended pragmas: `journal_mode = WAL` for file-backed databases
   (the Node driver does this; skip for `:memory:`).
3. Prepared-statement caching is a driver-internal concern (keyed by SQL
   text) — invisible at the seam.
4. Run the conformance suites against it. They currently live in
   `packages/driver-node/src/*Conformance.test.ts` and are written against
   the seam interface — extracting them into a shared reusable package is
   planned alongside the second driver. Until then: copy the suite files
   and swap the driver import; everything else is seam-only.

The suites are the real contract: query semantics
(`queryConformance`), matcher agreement (`matcherConformance`), DDL and
migrations (`schemaConformance`), sanitization round-trip
(`rawRecordConformance`), plus the driver basics in
`NodeSqliteDriver.test.ts` (batch atomicity and rollback, user_version
persistence, destroy removing sidecars, boolean binding).

## Existing drivers

| Driver | Package | Notes |
| --- | --- | --- |
| Node | `@watermelon-rewrite/driver-node` | better-sqlite3; synchronous underneath; WAL for file DBs; `:memory:` supported. Powers all tests. |
| React Native | `@watermelon-rewrite/driver-rn` | Pure C++ TurboModule, bundled sqlite3 amalgamation, prefab JSI linkage. Codegen + syntax verified locally; device build pending (see its README). |
| Web | `@watermelon-rewrite/driver-web` | SQLite-WASM + OPFS SAH pool in a dedicated Worker. Full contract verified against real sqlite-wasm in-process; OPFS persistence needs a browser run (see its README). |
