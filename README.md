# remelonDB

A from-scratch rewrite of [WatermelonDB](https://github.com/Nozbe/WatermelonDB):
an offline-first data layer with multi-device sync — reactive SQLite on
React Native, web, and Node, typed schemas inferred from one definition,
and a model-checked sync protocol shipped as client, server engine, and
conformance suites. Built on **one engine (SQLite) everywhere** and
designed for the React Native New Architecture from day one.

## Why a rewrite

Upstream WatermelonDB's native layer predates the New Architecture and broke
with it: its Android JSI build hand-compiles `jsi.cpp` from hardcoded
`ReactCommon` paths that React Native no longer ships, its iOS/Android modules
are classic-bridge with a manual JSI install that grabs `RCTCxxBridge`
internals that don't exist in bridgeless mode, and its prebuilt `.so` files
predate Google Play's 16 KB page-alignment requirement. Its web story is a
separately-implemented LokiJS engine whose query semantics must be kept in
lockstep with SQLite by hand: a permanent correctness tax.

Rather than patch that stack, this project keeps WatermelonDB's best ideas
(queries as data, reactive observation, the offline-first sync protocol) and
rebuilds everything on two principles:

1. **A query is data, not code.** `Q.where('likes', Q.gt(10))` builds a
   serializable description; one pure function compiles it to parameterized
   SQL. See [docs/q-dsl-and-one-engine.md](docs/q-dsl-and-one-engine.md).
2. **One engine: SQLite everywhere.** Native (bundled sqlite3 via a C++
   TurboModule), web (SQLite-WASM + OPFS in a Worker), Node (better-sqlite3).
   Query semantics are inherited from SQLite rather than re-implemented per
   platform — observation re-queries SQLite too, so there is no second
   engine anywhere.

The portability seam is a dumb, ~7-method **`SqliteDriver`**
(execute SQL, atomically batch, report `user_version`). Everything above it
(query compiler, schema DDL, record sanitization, observation, sync) is
written once in TypeScript and identical on every platform. See
[docs/architecture-layers.md](docs/architecture-layers.md).

## Status

Every layer — driver seam, query DSL and compiler, schema and
migrations, database core, model layer, and the
[sync engine](docs/sync-design.md) — is built and passes one shared
conformance suite on all four platforms: Node (better-sqlite3),
[web](packages/driver-web/README.md) (Chromium, Firefox, WebKit, and
real Safari over OPFS), and
[Android and iOS](packages/driver-rn/README.md) (on-device, same 50/50
suite as Node, plus a real reload-teardown cycle on iOS). A production
`vite build` smoke test covers the packed-tarball consumer path
end-to-end; every package README checklist is fully ticked.

The sync protocol has a normative wire contract
([docs/sync-wire.md](docs/sync-wire.md)) and a formal Quint model
checked in CI ([docs/sync_model.qnt](docs/sync_model.qnt), explained
in [docs/formal-model.md](docs/formal-model.md)) — and both
halves ship. The client engine lives in core. The backend half,
[`@remelondb/server`](packages/server), is not a hosted service but a
library you embed in your own Node backend: it hands you plain
`pull`/`push` functions to wire into two routes, with every protocol
semantic — cursors, conflict detection, per-record rejection —
implemented once above an eight-method storage seam. It ships with an
in-memory store for development and tests; for durable storage you
implement the seam over your database and prove the adapter with the
`@remelondb/server/conformance` suite, the wire contract as a runnable
suite. The `@remelondb/core/zod` subpath
derives tables and wire validators from shared Zod schemas.

A taste of the API — the same code on every platform, swapping only
the driver import:

```ts
import { appSchema, column as c, table, Database, ModelFor, Q } from '@remelondb/core'
import { NodeSqliteDriver } from '@remelondb/driver-node'

const tasks = table('tasks', {
  name: c.string(),
  position: c.number().indexed(),
  is_done: c.boolean(),
})

const schema = appSchema({ version: 1, tables: [tasks] })

// no field declarations: name/position/is_done are typed from the
// table definition; accessors are schema-generated
class Task extends ModelFor(tasks) {}

const db = await Database.open({
  driver: new NodeSqliteDriver(),   // RnSqliteDriver / WebSqliteDriver in apps
  schema,
  modelClasses: [Task],
  name: 'app.db',
})

await db.write(() => db.get(Task).create({ name: 'try it', position: 1 }))

db.get(Task)
  .query(Q.where('is_done', false), Q.sortBy('position'))
  .observe((open) => console.log('open tasks:', open.length))
```

The full walkthrough — associations, migrations, and sync against the
shipped backend engine — is [docs/tutorial.md](docs/tutorial.md).

## Repository layout

```
packages/
  core/          @remelondb/core — everything platform-independent
    src/driver/       the SqliteDriver seam (types only)
    src/query/        query AST, Q builders, Q → SQL compiler
    src/schema/       appSchema/table/column builders, migrations, DDL compiler
    src/rawRecord/    sanitizedRaw, dirty tracking
    src/database/     Database, Collection, Query, WorkQueue, RecordCache
    src/model/        the Model layer (schema-generated accessors)
    src/sync/         the sync engine (pull/push, conflict resolution)
    src/conformance/  the driver contract as a runnable suite
                      (import '@remelondb/core/conformance')
    src/zod/          shared Zod schemas as the source of truth:
                      zodTable + sync wire validators
                      (import '@remelondb/core/zod')
  driver-node/   @remelondb/driver-node — better-sqlite3 driver
                 + conformance & integration suites on real SQLite
  driver-rn/     @remelondb/driver-rn — React Native driver: thin
                 adapter over expo-sqlite (runs in Expo Go)
  driver-rn-cpp/ @remelondb/driver-rn-cpp — optional RN driver:
                 pure C++ TurboModule + bundled, pinned SQLite
                 (dev builds only; see its README)
  driver-web/    @remelondb/driver-web — browser driver:
                 SQLite-WASM + OPFS in a Worker (see its README)
  server/        @remelondb/server — embeddable sync backend engine:
                 protocol semantics over a storage seam; in-memory
                 store included, bring a store adapter for persistence;
                 the wire spec's checklist ships as a runnable suite at
                 '@remelondb/server/conformance' (docs/server-design.md)
examples/
  todo-sync/     one example, one shared schema, three packages:
                 backend/ (schema + ~50-line sync server), frontend/
                 (React web client; two-window offline-capable sync
                 demo, e2e-tested in CI), mobile/ (React Native
                 client, in progress)
docs/            design decisions and reference guides — see docs/README.md
watermelondb-upstream/   reference checkout of upstream (gitignored)
```

Each package sits on a boundary an npm package can't paper over: the
drivers carry their platform dependency, the C++ module needs its own
package for React Native autolinking, and the server runs on the other
side of the wire. Everything else ships as a core or server subpath
(`/conformance`, `/zod`) with its extra dependency as an optional peer.

## Documentation

- **[docs/tutorial.md](docs/tutorial.md)** — start here: a flashcard
  app's data layer, end to end
- **[examples/todo-sync](examples/todo-sync)** — then see it whole: a
  complete synced todo app (shared schema, ~50-line backend, web
  client); its two-window offline sync demo is e2e-tested in CI
- **[docs/sync-basics.md](docs/sync-basics.md)** — sync in plain
  language: who wins when two devices edit, and how to change it
- **[docs/sync-tour.md](docs/sync-tour.md)** — the sync protocol in
  eight real requests and responses, replayed by CI on every push
- **[docs/README.md](docs/README.md)** — index of all documentation
- **[API reference](https://dustyway.github.io/remelonDB/)** — generated
  from the source on every push (all packages, grouped by task, with
  examples)
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

## Using it in an app

The packages are on npm under the `@remelondb` scope:

```sh
pnpm add @remelondb/core @remelondb/driver-web   # or driver-node / driver-rn
```

Packages ship compiled ESM plus type declarations (`dist/`); no
TypeScript tooling is required to consume them. CI packs the tarballs
and consumes them from a plain Node project on every push.

## Development

```sh
pnpm install        # needs build-script approval for better-sqlite3 (preconfigured)
pnpm test           # vitest: unit + conformance suites
pnpm typecheck      # tsc --noEmit, strict
pnpm build          # tsdown: dist/ (ESM + .d.ts) for every package
```

Testing philosophy: pure layers get exact-output unit tests in `core`;
everything with semantics gets a **conformance test** in `driver-node` that
runs against real SQLite. One query corpus pins the compiled SQL's
semantics on every driver; that's the "one authoritative engine" rule as
an executable invariant.

## License and credits

[MIT](LICENSE). The design owes its best ideas (queries as data,
reactive observation, the offline-first sync protocol) to
[WatermelonDB](https://github.com/Nozbe/WatermelonDB) by Nozbe and
contributors (MIT); the code here is written from scratch. Generated
codegen files under `packages/driver-rn/android/generated/` retain
their Meta MIT headers.
