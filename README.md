# watermelon-rewrite

A from-scratch rewrite of [WatermelonDB](https://github.com/Nozbe/WatermelonDB):
a reactive, offline-first, syncable database layer for React Native, web, and
Node — built on **one engine (SQLite) everywhere** and designed for the React
Native New Architecture from day one.

> Package names (`@watermelon-rewrite/*`) are placeholders until the project
> has a real name.

## Why a rewrite

Upstream WatermelonDB's native layer predates the New Architecture and broke
with it: its Android JSI build hand-compiles `jsi.cpp` from hardcoded
`ReactCommon` paths that React Native no longer ships, its iOS/Android modules
are classic-bridge with a manual JSI install that grabs `RCTCxxBridge`
internals that don't exist in bridgeless mode, and its prebuilt `.so` files
predate Google Play's 16 KB page-alignment requirement. Its web story is a
separately-implemented LokiJS engine whose query semantics must be kept in
lockstep with SQLite by hand — a permanent correctness tax.

Rather than patch that stack, this project keeps WatermelonDB's best ideas
(queries as data, reactive observation, the offline-first sync protocol) and
rebuilds everything on two principles:

1. **A query is data, not code.** `Q.where('likes', Q.gt(10))` builds a
   serializable description; one pure function compiles it to parameterized
   SQL. See [docs/q-dsl-and-one-engine.md](docs/q-dsl-and-one-engine.md).
2. **One engine: SQLite everywhere.** Native (bundled sqlite3 via a C++
   TurboModule), web (SQLite-WASM + OPFS in a Worker), Node (better-sqlite3).
   Query semantics are inherited from SQLite, not re-implemented per platform.
   The one bounded exception — a tiny in-memory matcher for observers — is
   conformance-tested against real SQLite query-for-query.

The portability seam is a deliberately dumb, ~7-method **`SqliteDriver`**
(execute SQL, atomically batch, report `user_version`). Everything above it —
query compiler, schema DDL, record sanitization, observation, sync — is
written once in TypeScript and identical on every platform. See
[docs/architecture-layers.md](docs/architecture-layers.md).

## Status

| Layer | State |
| --- | --- |
| `SqliteDriver` seam (Promise-shaped, web-capable) | ✅ done |
| Node driver (better-sqlite3) | ✅ done |
| Q DSL: query AST + validated builders | ✅ done |
| Q → SQL compiler (parameterized, LEFT JOIN, deleted-filter flag) | ✅ done |
| Schema, migrations, DDL compiler | ✅ done |
| RawRecord sanitization (`sanitizedRaw`) | ✅ done |
| In-memory matcher + SQL/matcher conformance corpus | ✅ done |
| Database core (writer queue, RecordCache, batch, observation) | ✅ done |
| Model layer (typed records, no decorators) | ✅ done |
| Sync engine ([protocol](docs/sync-design.md): no lost writes, no push echo) | ✅ done |
| React Native driver (C++ TurboModule, bundled sqlite3) | ✅ [runtime-verified on Android emulator](packages/driver-rn/README.md): smoke + full conformance suite (50/50, same as Node); iOS pending |
| Web driver (SQLite-WASM + OPFS Worker) | ✅ [verified in real Chromium](packages/driver-web/README.md): full conformance suite on OPFS |

The full TypeScript side works today, on Node:

```ts
import {
  appSchema, tableSchema, Database, Model, Q, synchronize,
  type AssociationsMap,
} from '@watermelon-rewrite/core'
import { NodeSqliteDriver } from '@watermelon-rewrite/driver-node'

const schema = appSchema({
  version: 1,
  tables: [
    tableSchema({
      name: 'tasks',
      columns: [
        { name: 'name', type: 'string' },
        { name: 'position', type: 'number', isIndexed: true },
        { name: 'is_done', type: 'boolean' },
        { name: 'project_id', type: 'string', isOptional: true },
      ],
    }),
  ],
})

class Task extends Model {
  static override readonly table = 'tasks'
  static override readonly associations = {
    projects: { type: 'belongs_to', key: 'project_id' },
  } satisfies AssociationsMap

  declare name: string        // type-only; accessors are schema-generated
  declare position: number
  declare is_done: boolean
}

const db = await Database.open({
  driver: new NodeSqliteDriver(),
  schema,
  modelClasses: [Task],
  name: 'app.db',
})

const task = await db.write(() =>
  db.get<Task>('tasks').create({ name: 'try it', position: 1 }),
)
await db.write(() => task.update(() => { task.is_done = true }))

const unsubscribe = db
  .get<Task>('tasks')
  .query(Q.where('is_done', false), Q.sortBy('position'))
  .observe((open) => console.log('open tasks:', open.length))

await synchronize({ database: db, pullChanges, pushChanges }) // your backend
```

## Repository layout

```
packages/
  core/          @watermelon-rewrite/core — everything platform-independent
    src/driver/       the SqliteDriver seam (types only)
    src/query/        query AST, Q builders, Q → SQL compiler
    src/schema/       appSchema/tableSchema, migrations, DDL compiler
    src/rawRecord/    sanitizedRaw, dirty tracking
    src/observation/  the in-memory matcher
    src/database/     Database, Collection, Query, WorkQueue, RecordCache
    src/model/        the Model layer (schema-generated accessors)
    src/sync/         the sync engine (pull/push, conflict resolution)
  driver-node/   @watermelon-rewrite/driver-node — better-sqlite3 driver
                 + conformance & integration suites on real SQLite
  driver-rn/     @watermelon-rewrite/driver-rn — React Native driver:
                 pure C++ TurboModule + bundled SQLite (see its README)
  driver-web/    @watermelon-rewrite/driver-web — browser driver:
                 SQLite-WASM + OPFS in a Worker (see its README)
docs/            design decisions and reference guides — see docs/README.md
watermelondb-upstream/   reference checkout of upstream (gitignored)
```

## Documentation

- **[docs/README.md](docs/README.md)** — index of all documentation
- Design decisions: [engine choice](docs/q-dsl-and-one-engine.md) ·
  [architecture layers](docs/architecture-layers.md) ·
  [sync protocol](docs/sync-design.md) ·
  [upstream study](docs/upstream-study.md)
- Reference: [database & observation](docs/reference/database.md) ·
  [models](docs/reference/models.md) ·
  [queries](docs/reference/queries.md) ·
  [sync](docs/reference/sync.md) ·
  [schema & migrations](docs/reference/schema.md) ·
  [records](docs/reference/records.md) ·
  [the driver contract](docs/reference/driver.md)

## Development

```sh
pnpm install        # needs build-script approval for better-sqlite3 (preconfigured)
pnpm test           # vitest: unit + conformance suites
pnpm typecheck      # tsc --noEmit, strict
```

Testing philosophy: pure layers get exact-output unit tests in `core`;
everything with semantics gets a **conformance test** in `driver-node` that
runs against real SQLite. The matcher conformance suite runs one query corpus
through both engines (compiled SQL and the in-memory matcher) and asserts
identical results — that's the "one authoritative engine" rule as an
executable invariant.
