# Schema & migrations reference

Schemas and migrations are plain data with validation at construction; the
DDL compiler (`encodeSchema`, `encodeMigrationSteps`) turns them into lists
of single SQL statements for a driver to run atomically.

## Defining a schema

```ts
import { appSchema, column as c, table } from '@remelondb/core'

const tasks = table('tasks', {
  name: c.string(),
  position: c.number().indexed(),
  is_done: c.boolean(),
  project_id: c.string().optional(),
})

const schema = appSchema({ version: 1, tables: [tasks] })
```

- **Column builders**: `c.string()`, `c.number()`, `c.boolean()`. Columns
  are stored untyped in SQLite (dynamic typing); the declared type drives
  JS-side sanitization (see [records.md](records.md)) and migration
  backfill defaults.
- Tables can also be **derived from a shared Zod object** instead of
  written by hand — `zodTable('tasks', TaskSchema)` in
  [`@remelondb/core/zod`](../zod-adapter.md) produces the identical
  `TableSchema`, with the record types guaranteed to match `z.infer`
  ([zod-adapter.md](../zod-adapter.md)).
- **`.optional()`**: the column may be `null`. Non-optional columns are
  coerced to a type default (`''`/`0`/`false`) rather than null.
- **`.indexed()`**: creates `create index "…" on "table" ("column")`.
- **`created_at` / `updated_at`**, if declared, must be non-optional
  `number` columns (epoch-millisecond timestamps, maintained by the future
  Model layer).
- **Record types are inferred**: `InferRecord<typeof tasks>` is the typed
  record shape (`.optional()` columns become `T | null`). Collections
  obtained via `db.get(tasks)` or `db.get(Task)` are typed by it, and
  misspelled column names in `Q.where`/`Q.sortBy` are compile errors.

Validation at construction (all throw with specific messages): identifiers
must match `^[a-zA-Z_][a-zA-Z0-9_]*$`; duplicate tables are rejected;
`version` must be a positive integer.

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
  stepsForMigration, encodeMigrationSteps, column as c,
} from '@remelondb/core'

const migrations = schemaMigrations({
  migrations: [
    {
      toVersion: 2,
      steps: [
        addColumns({
          table: 'tasks',
          columns: {
            priority: c.number().indexed(),
            note: c.string().optional(),
          },
        }),
      ],
    },
    { toVersion: 3, steps: [createTable({ name: 'tags', columns: { /* … */ } })] },
  ],
})
```

- Migrations must be **sorted and contiguous** (`toVersion` 2, 3, 4, …);
  gaps and duplicates are construction errors. `minVersion`/`maxVersion`
  are derived.
- Steps are data, like queries. Both `createTable` and `addColumns` take a
  `columns` map of column builders, the same shape `table()` uses. Available
  steps:
  - `createTable({name, columns})` — same validation as `table()`.
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
