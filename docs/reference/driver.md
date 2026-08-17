# Driver contract reference

The `SqliteDriver` interface is the project's portability seam
([layers.md](../layers.md)): a deliberately dumb
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

**`acquireWorkSlot(exclusive)?`** — optional, for drivers whose storage
is shared between contexts (browser tabs behind one broker, see
docs/multi-tab.md). Core calls it around every `database.write` block
(`exclusive: true`) and `database.read` consistency window
(`exclusive: false`); the returned function releases the slot. The
contract is the classic readers-writer discipline: an exclusive slot
excludes everything, shared slots coexist, grants are FIFO so writers
cannot starve. Core acquires the slot before entering its local queue,
so a waiting context keeps applying external changes and a grant
happens-after every change committed before it. Drivers with exclusive
storage (Node, React Native, the web driver outside shared mode) omit
it — the in-process work queue already serializes locally and core
skips the hook entirely.

**`requestSyncTurn()?`** — optional, for shared-storage drivers: asked
by `synchronize` at entry; answer false and the run becomes a cheap
no-op. Implemented as a broker lease on the web (renewed by asking,
inherited on expiry when the holder disappears). Drivers with
exclusive storage omit it — they always own sync.

**`publishChanges(changes)?` / `onExternalChanges(handler)?`** —
optional, the two halves of change propagation for shared-storage
drivers (docs/multi-tab.md). Core calls `publishChanges` after every
committed batch with the batch's change set (best-effort,
fire-and-forget: a lost notification is a stale cache elsewhere until
the next one, never data loss). The driver invokes the
`onExternalChanges` handler with change sets committed by other
contexts; core routes them into `database.applyExternalChanges`, which
updates the record cache in place and notifies observers. A driver
implements both members or neither.

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
4. Run the shared conformance suite against it —
   `@remelondb/core/conformance`:

   ```ts
   registerDriverConformance({
     name: 'my driver',
     createDriver: () => new MyDriver(),
     persistence: { databaseName: () => uniqueName() }, // or false
   })
   ```

The suite is the real contract: driver method obligations (lifecycle,
round-trip, batch atomicity and rollback, user_version, error surfaces,
persistence when supported), the full query-semantics corpus, schema
DDL + migrations, and the sanitization round-trip. Both existing
drivers run it verbatim.

## Existing drivers

| Driver | Package | Notes |
| --- | --- | --- |
| Node | `@remelondb/driver-node` | better-sqlite3; synchronous underneath; WAL for file DBs; `:memory:` supported. Powers all tests. |
| React Native | `@remelondb/driver-rn` | Thin adapter over `expo-sqlite`; the default, and runs in Expo Go with no native build of its own. |
| React Native (no expo) | `@remelondb/driver-rn-cpp` | Pure C++ TurboModule, bundled sqlite3 amalgamation, prefab JSI linkage. Requires a development build; see its README for when to choose it. |
| Web | `@remelondb/driver-web` | SQLite-WASM + OPFS SAH pool in a dedicated Worker. Full contract verified against real sqlite-wasm in-process, and OPFS suites run in CI on real Chromium, Firefox, and WebKit. |
