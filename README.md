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
| Database core (writer queue, RecordCache, batch, observation) | 🔜 next |
| Model / Collection public API | ⏳ planned |
| Sync engine ([protocol designed](docs/sync-design.md)) | ⏳ planned |
| React Native driver (C++ TurboModule, bundled sqlite3) | ⏳ planned |
| Web driver (SQLite-WASM + OPFS Worker) | ⏳ planned |

Until the Database core lands, the built layers compose manually (and are
fully usable that way — the whole test suite works like this):

```ts
import {
  appSchema, tableSchema, encodeSchema,
  Q, encodeQuery, encodeMatcher, sanitizedRaw,
} from '@watermelon-rewrite/core'
import { NodeSqliteDriver } from '@watermelon-rewrite/driver-node'

const tasks = tableSchema({
  name: 'tasks',
  columns: [
    { name: 'name', type: 'string' },
    { name: 'position', type: 'number', isIndexed: true },
    { name: 'is_done', type: 'boolean' },
    { name: 'project_id', type: 'string', isOptional: true },
  ],
})
const schema = appSchema({ version: 1, tables: [tasks] })

const driver = new NodeSqliteDriver()
const { userVersion } = await driver.open('app.db')
if (userVersion === 0) {
  await driver.executeBatch(encodeSchema(schema).map((sql) => [sql, [[]]]))
  await driver.setUserVersion(schema.version)
}

// query: description → parameterized SQL → sanitized records
const description = Q.buildQueryDescription([
  Q.where('is_done', false),
  Q.sortBy('position'),
])
const [sql, args] = encodeQuery({ table: 'tasks', description })
const records = (await driver.query(sql, args)).map((row) =>
  sanitizedRaw(row, tasks),
)
```

## Repository layout

```
packages/
  core/          @watermelon-rewrite/core — everything platform-independent
    src/driver/       the SqliteDriver seam (types only)
    src/query/        query AST, Q builders, Q → SQL compiler
    src/schema/       appSchema/tableSchema, migrations, DDL compiler
    src/rawRecord/    sanitizedRaw and friends
    src/observation/  the in-memory matcher
  driver-node/   @watermelon-rewrite/driver-node — better-sqlite3 driver
                 + the conformance suites (run compiled SQL on real SQLite)
docs/            design decisions and reference guides — see docs/README.md
watermelondb-upstream/   reference checkout of upstream (gitignored)
```

## Documentation

- **[docs/README.md](docs/README.md)** — index of all documentation
- Design decisions: [engine choice](docs/q-dsl-and-one-engine.md) ·
  [architecture layers](docs/architecture-layers.md) ·
  [sync protocol](docs/sync-design.md) ·
  [upstream study](docs/upstream-study.md)
- Reference: [queries](docs/reference/queries.md) ·
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
