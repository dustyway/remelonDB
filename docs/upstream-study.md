# Upstream study notes (WatermelonDB, checkout in `watermelondb-upstream/`)

Condensed findings from a full read of upstream's adapter stack, query layer,
core ORM/reactivity, and sync. This is the factual basis for
`architecture-layers.md`. Paths are relative to `watermelondb-upstream/`.

## How upstream is layered

```
DatabaseAdapter (interface, src/adapters/type.js — 17 methods, callback-based)
  └─ SQLiteAdapter (src/adapters/sqlite/index.js)
       • compiles EVERYTHING to SQL in JS before crossing the boundary:
         encodeQuery / encodeBatch / encodeSchema / encodeMigrationSteps
       • native never sees the query AST — only SQL strings + args
  └─ Dispatcher (makeDispatcher/) — 3 backends behind one .call(method, args, cb):
       'jsi' (sync, global.nativeWatermelonCreateAdapter host object)
       'asynchronous' (classic bridge NativeModule WMDatabaseBridge)
       Node (in-process DatabaseBridge → better-sqlite3)
  └─ Native driver (WMDatabaseDriver objc/java, C++ Database, or JS DatabaseDriver)
       • owns the record cache and schema-version check, runs transactions
  └─ sqlite3 (FMDB / android.database.sqlite / amalgamated sqlite3.c / better-sqlite3)
```

Init is two-phase to avoid shipping the schema every launch: native compares
`PRAGMA user_version` and returns `ok | schema_needed | migrations_needed`; JS
then sends compiled schema SQL or computed migration-step SQL. **Missing
migration range silently falls back to destroy-and-recreate** (index.js:191).

## Mechanisms worth keeping (conceptually)

- **SQL compiled once, in JS.** The whole native surface is "execute this
  SQL / this batch". This is what makes the engine swappable.
- **Batch opcode format** `[cacheBehavior, table, sql, [args...]]`: one generic
  positional primitive transports creates/updates/deletes/local-storage/tombstone
  cleanup in a single transaction.
- **Two-phase init** (version check first, schema/migration SQL only if needed).
- **Two-strategy observation** with a hard gate (`canEncodeMatcher`): flat
  single-table WHERE queries get an in-memory JS matcher; anything with joins,
  sort, take/skip, or raw SQL falls back to re-query-on-any-table-change.
- **RecordCache identity map** (one Model instance per id) and the writer queue
  giving mutations a stable serialized view.
- **Sync's per-column client-wins merge** (`resolveConflict`): start from remote,
  overwrite columns listed in local `_changed`, keep local `_status/_changed` so
  locally-changed columns get pushed next sync. Pure function over plain objects.
- **Dirty tracking**: `_status ∈ {synced,created,updated,deleted}` +
  `_changed` = comma-set of dirty column names, maintained in `Model._setRaw` via
  `setRawColumnChange`. Created records keep `_changed` empty.
- **Sync concurrency guards**: apply and mark-synced each inside one
  `database.write`; re-check `lastPulledAt` unchanged before applying (two-sync
  collision); `areRecordsEqual(record._raw, pushedRaw)` gate so records modified
  between fetch-local and mark-synced simply stay dirty for the next push.

## Warts / bugs to fix in the rewrite

**Native binding (the reason the rewrite exists)**
- Not a TurboModule, no codegen. Classic bridge module + blocking-sync `install()`
  that grabs `bridge.runtime` from `RCTCxxBridge`, none of which exists on
  bridgeless New Architecture.
- `native/android-jsi/.../CMakeLists.txt:84` manually compiles
  `ReactCommon/jsi/jsi/jsi.cpp` with hardcoded include paths: the RN 0.86
  breakage. No prefab (`ReactAndroid::jsi`) anywhere. Toolchain ancient
  (compileSdk 28, NDK 20.1).
- Elaborate teardown hackery (Catalyst destroy → reflection) to close the DB
  before C++ destructors run on a dead thread (DatabaseBridge.cpp:22–77).
- Android JSI convention: errors are *returned* as `Error` objects, not thrown;
  the JS dispatcher checks `instanceof Error` (index.native.js:101).

**Query layer**
- `encodeQuery` inlines values via string escaping instead of placeholders;
  the code itself flags this as wrong (encodeValue/index.js:28). Only
  `encodeBatch` and `unsafeSqlQuery` use bound args.
- JOIN vs LEFT JOIN "extreeeeemelyyyy bad hack" (encodeQuery:166–186): legacy
  top-level `Q.on` gets inner JOIN (silently drops rows), nested `Q.on` gets
  LEFT JOIN, chosen by heuristic for backwards compat.
- Loki-compat semantics contort the operator set: weak equality (`1==true`),
  `weakGt` (JS null ordering), null-in-`oneOf` forbidden, `IS`/`IS NOT` for eq.
  Exists only so SQLite/Loki/JS-matcher agree; with Loki gone, most simplifies
  to native SQLite semantics.
- `Q.sanitizeLikeString` is lossy (replaces all non-alphanumerics with `_`)
  instead of using an `ESCAPE` clause.
- `_status != 'deleted'` filtering is bolted on by rewriting the description
  tree (including into every `Q.on`) in `queryWithoutDeleted`.
- `select distinct` applied globally whenever any has_many join exists.
- Migration steps: only create_table / add_columns / raw sql; everything else
  is a TODO.

**Record-caching protocol (ID-vs-raw)**
- Native tracks which record ids it has sent to JS and returns bare ids for
  those; JS RecordCache resolves ids to cached Models. Cache updates ride on
  batch opcodes (`cacheBehavior` +1/-1/0).
- The two sides desync in production: RecordCache has a defensive
  "id arrived but not cached" recovery path (RecordCache.js:71–106) with
  telemetry-confirmed hits. Cache ownership split across the boundary is the
  root cause.

**Core / reactivity**
- `Database.batch` clears `_preparedState` *before* the adapter call succeeds
  (`TODO: What if this fails?`): no rollback contract.
- Docs promise concurrent readers; `WorkQueue` runs everything strictly serial.
- Two parallel notification systems everywhere (RxJS subjects AND hand-rolled
  `_subscribers` arrays) whose call ordering matters. RxJS itself is shallow
  and quarantined behind a shim — droppable.
- `observeWithColumns` carries race machinery its own comments call outdated;
  count throttling is "has a bug, but we'll delete it anyway".
- JS matcher (`encodeMatcher/operators.js`) reimplements SQLite comparison
  semantics; divergence = silently wrong observer results. No conformance suite
  ties the two together.

**Sync**
- Lost-write race: pull cursor is `last_modified > lastPulledAt` with the
  timestamp chosen by the backend; any write landing in the pull window with a
  timestamp ≤ the returned cursor is never pulled again. Client merely logs a
  backwards timestamp. Entirely delegated to backend discipline
  (docs-website Backend.md:79–85, 133–137). → replaced by the rev cursor.
- Push-echo: acknowledged limitation (Limitations.md:3); pushed changes come
  back on next pull; harmless (absorbed by `requiresUpdate`/`areRecordsEqual`)
  but wasteful. Proper fix: push responds with a new cursor.
- Push sends full raws including `_status`/`_changed` instead of changed
  columns only (fetchLocal.js:35–37 TODOs).
- Sync depends on adapter-level tombstones (`getDeletedRecords` /
  `destroyDeletedRecords`) and KV local storage (`getLocal`/`setLocal`) — ORM
  concepts leaked into the adapter interface.
- Turbo sync (`provideSyncJson`/`unsafeLoadFromSync`) is a JSI-only native
  fast path for first-sync bulk load; on JSI it detours back through the async
  bridge for JSON delivery (compat shim).

**Misc**
- Node driver is a hand-rolled reimplementation of the native driver (drift
  risk); has a typo'd `{ verboze: … }` option and other oddities.
- `getRandomBytes`/`getRandomIds` piggyback on the DB bridge module.
- Adapter interface is callback-based (`ResultCallback<T>`) with a
  Promise-wrapping compat layer on top.
