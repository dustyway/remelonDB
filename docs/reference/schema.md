# Schema & migrations reference

Schemas and migrations are plain data with validation at construction; the
DDL compiler (`encodeSchema`, `encodeMigrationSteps`) turns them into lists
of single SQL statements for a driver to run atomically.

## Defining a schema

```ts
import { appSchema, tableSchema } from '@remelondb/core'

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
```

- **Column types**: `'string' | 'number' | 'boolean'`. Columns are stored
  untyped in SQLite (dynamic typing); the declared type drives JS-side
  sanitization (see [records.md](records.md)) and migration backfill
  defaults.
- **`isOptional`**: the column may be `null`. Non-optional columns are
  coerced to a type default (`''`/`0`/`false`) rather than null.
- **`isIndexed`**: creates `create index "…" on "table" ("column")`.
- **`created_at` / `updated_at`**, if declared, must be non-optional
  `number` columns (epoch-millisecond timestamps, maintained by the future
  Model layer).

Validation at construction (all throw with specific messages): identifiers
must match `^[a-zA-Z_][a-zA-Z0-9_]*$`; duplicate tables/columns are
rejected; `version` must be a positive integer.

### Standard columns and reserved names

Every table implicitly gets three columns — never declare them:

| Column | Purpose |
| --- | --- |
| `id` | primary key, 16-char generated string (or caller-provided) |
| `_status` | sync lifecycle: `synced` / `created` / `updated` / `deleted` |
| `_changed` | comma-separated names of columns changed since last sync |

Reserved and rejected: column names `id`, `_status`, `_changed`, and the
SQLite rowid aliases `rowid`/`oid`/`_rowid_` (case-insensitive); table names
`local_storage` and anything starting with `sqlite_`.

## What the DDL looks like

`encodeSchema(schema)` returns an array of single statements:

```sql
create table "local_storage" ("key" primary key not null, "value")
create table "tasks" ("id" primary key, "_changed", "_status", "name", "position", "project_id", …)
create index if not exists "tasks_position" on "tasks" ("position")
create index if not exists "tasks__status" on "tasks" ("_status")
```

- `local_storage` is a core-owned key-value table (sync cursor, app local
  storage) — a regular table over the driver seam, not a driver feature.
- Every table gets a `_status` index automatically: deleted-record filtering
  touches it on every query, and sync queries it directly.
- Statements come as a list because drivers prepare one statement at a time;
  run them atomically with `driver.executeBatch(list.map(sql => [sql, [[]]]))`.

## Setup flow (two-phase init)

`driver.open(name)` reports the current `PRAGMA user_version`; the caller
decides what to do — the driver has no schema knowledge:

- `userVersion === 0` → fresh database: run `encodeSchema(schema)`, then
  `driver.setUserVersion(schema.version)`.
- `userVersion === schema.version` → ready.
- `0 < userVersion < schema.version` → migrate (below).
- `userVersion > schema.version` → the app was downgraded; surface an error.

**`Database.open` owns this decision** ([database.md](database.md)) — you
normally never run it by hand. The primitives below remain public for
tooling and tests.

## Migrations

```ts
import {
  schemaMigrations, createTable, addColumns, unsafeExecuteSql,
  stepsForMigration, encodeMigrationSteps,
} from '@remelondb/core'

const migrations = schemaMigrations({
  migrations: [
    {
      toVersion: 2,
      steps: [
        addColumns({
          table: 'tasks',
          columns: [
            { name: 'priority', type: 'number', isIndexed: true },
            { name: 'note', type: 'string', isOptional: true },
          ],
        }),
      ],
    },
    { toVersion: 3, steps: [createTable({ name: 'tags', columns: [/* … */] })] },
  ],
})
```

- Migrations must be **sorted and contiguous** (`toVersion` 2, 3, 4, …);
  gaps and duplicates are construction errors. `minVersion`/`maxVersion`
  are derived.
- Steps are data, like queries. Available steps:
  - `createTable({...})` — same validation as `tableSchema`.
  - `addColumns({table, columns})` — compiles to
    `alter table … add "col" default <literal>`; SQLite backfills existing
    rows with the default natively (`''`/`0` per type, `null` if optional —
    the same values `sanitizedRaw` uses, so migrated rows and sanitized
    records agree).
  - `unsafeExecuteSql(sql)` — one raw statement per step (drivers prepare
    single statements; multi-statement strings will fail).

### Applying a migration

```ts
const steps = stepsForMigration(migrations, { from: userVersion, to: schema.version })
if (steps === null) {
  // range not covered — an explicit decision point, never silent
  throw new Error('No migration path; refusing to touch the database')
}
await driver.executeBatch(encodeMigrationSteps(steps).map((sql) => [sql, [[]]]))
await driver.setUserVersion(schema.version)
```

**`stepsForMigration` returns `null` for an uncovered range** — the caller
must decide what that means. This is a deliberate departure from upstream
WatermelonDB, which silently fell back to destroying and recreating the
database. Data destruction here is only ever an explicit opt-in.

Not yet implemented (add via `unsafeExecuteSql` for now, or wait): rename
table/column, drop table/column, changing optionality, adding an index to an
existing column.
