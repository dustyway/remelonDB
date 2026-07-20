# Schema-inferred types

Status: implemented. The schema literal is the single source of truth:
record types, model fields, collection types, and `Q` column checking
all derive from one `table()` definition. Motivated by matching the
schema-first style of remelonDB's reference consumer stack (Drizzle on
the server, Zod for shared validation).

## The failure class this removes

Written with a duplicated schema — a runtime definition plus
hand-declared model fields — nothing checks that the two agree:

```ts
// with a hand-duplicated schema
class Task extends Model {
  static override readonly table = 'tasks'
  declare name: string      // hand-written duplicate of the schema
  declare position: number  // typo here = silent undefined at runtime
}
```

Three concrete failure modes, none caught by a compiler:

1. A `declare` that drifts from the schema (wrong name, wrong type,
   missing `| null` on an optional column) produces records whose types lie.
2. `Q.where('nmae', ...)` compiles fine and matches nothing.
3. `db.get<Task>('tasks')` is an unchecked cast; the string and the type
   parameter are not connected.

Modes 1 and 2 are compile errors under this design, pinned by
`@ts-expect-error` cases (`schema/typeInference.test.ts`). Mode 3 is
eliminated by replacement: the typed `db.get(Task)` / `db.get(tasks)`
forms make the cast unnecessary (the string overload survives for
dynamic and internal access — see section 3).

## Shape of the design

- **One source of truth**: everything below derives from the `table()`
  literal.
- **A surface change only**: the schema module's runtime output
  (`TableSchema`, `AppSchema`), the DDL compiler, migrations, and the
  query AST are untouched by the type layer — it is input syntax plus
  phantom types over the same runtime objects.
- **Mechanically derivable**: a Zod object converts into the identical
  `TableSchema` via `zodTable` ([zod-adapter.md](zod-adapter.md)),
  pinned by a deep-equality test.

Non-goals. Each one protects an invariant that another part of the
system stands on:

- **No Drizzle-style chained query builder.** Queries stay serializable
  data because observation and sync inspect them; a builder that
  compiles straight toward SQL would take that away.
- **No runtime validation of local writes.** `sanitizedRaw` already
  sanitizes every local write, and this design types them at compile
  time. Validation effort belongs at the trust boundaries — the sync
  wire — where the Zod adapter puts it.
- **No change to the wire or storage format.** The type layer exists
  only at compile time; nothing about stored or synced data depends
  on it.

## Design

### 1. Column builders, object-map syntax

```ts
import { column as c, table } from '@remelondb/core'

export const tasks = table('tasks', {
  name: c.string(),
  position: c.number().indexed(),
  is_done: c.boolean(),
  project_id: c.string().optional(),
})

export const schema = appSchema({ version: 1, tables: [tasks] })
```

Builders are tiny: three constructors (`string`, `number`, `boolean`)
and two modifiers (`optional()`, `indexed()`). Each produces a plain
`ColumnSchema` object at runtime; `table()` produces a `TableSchema`
plus the type information described next. Reserved-name and
`created_at`/`updated_at` validation live in `table()`. This is the one
way to write a schema — there is no alternative syntax to keep in sync.

### 2. Record types are inferred

```ts
type TaskRecord = InferRecord<typeof tasks>
// {
//   readonly id: string
//   name: string
//   position: number
//   is_done: boolean
//   project_id: string | null
// }
```

Mapping rules: `string`/`number`/`boolean` map to themselves;
`.optional()` adds `| null`; `id` is always present and readonly;
`_status`/`_changed` do not appear (they are core-internal, and code
that needs them works with `RawRecord`).

### 3. Tables are values; collections are typed by them

```ts
const collection = db.get(tasks)  // typed records, checked Q columns
```

`db.get` takes the table object (or a model class: `db.get(Task)`), so
the unchecked cast from failure mode 3 is never necessary. Two honest
limits: the string overload exists for dynamic and internal access, so
that cast remains *expressible*; and `Database` is not generic
over its schema, so a table object outside this database's schema fails
at runtime (with a clear error), not at compile time. Both close with
the schema-generic `Database` under open questions. Bound vs unbound
collections also differ at runtime — see
[reference/database.md](reference/database.md) and the open question
below.

### 4. Models keep the class, lose the `declare`s

```ts
class Task extends ModelFor(tasks) {
  // no declared fields: name/position/is_done/project_id are typed
  // from the table definition; accessors are generated at bind time;
  // `static override associations = {...}` still goes here
}
```

The base class comes from a factory because a bare generic class cannot
type instance fields from a type parameter: TypeScript gives a class no
way to declare properties whose names come from a generic, so
`ModelFor(tasks)` returns a base class whose instance type already
carries the inferred fields.

The class layer stays because behavior lives there (update builders,
associations, sync-aware writes); field types come from the table object
instead of hand duplication. `static table` is set by `ModelFor` from
the table object (subclasses don't write it), which also lets
`Database.open` check that every model's table is in the app schema.

A class-free record API (plain typed objects, functions for writes)
would be the fuller Drizzle match but requires reworking record
identity in the observation layer and the record cache; it remains out
of scope.

### 5. Column names in `Q` are checked

`Q.where` and `Q.sortBy` carry their column name as a type parameter
(`Clause<'position'>`); `collection.query(...)` constrains accepted
clauses to the table's column union. A misspelled column is a compile
error at the query site. The runtime AST is byte-for-byte unchanged;
`Q.on` (joined tables) stays string-typed — see open questions. Values
are not yet typed per column (`Q.where('position', '5')` compiles); see
open questions.

## Open questions

- Making `Database` generic over its `AppSchema`, so `db.get(tasks)`
  rejects tables outside the schema at compile time and the untyped
  string overload can retire from the public surface.
- The table-object overload types records as `TypedModel` (record
  methods included) even when no model class is bound, but unbound
  collections hand out plain rows at runtime — `record.update()`
  typechecks and throws. The honest type for the unbound case is the
  record shape without methods; distinguishing bound from unbound in
  types likely also needs the schema-generic `Database`.
- Per-column value typing in `Q`: SQLite compares type-aware (the
  number `5` never equals the string `'5'`), so a mistyped comparison
  value silently matches nothing — the same silent-wrong-answer class
  this design exists to kill, one level deeper. Wants a value-type
  parameter on comparisons and careful attention to error-message
  quality; shares machinery with Zod-enum support.
- `Q.on` and association typing: checking joined-table columns needs
  the association graph in types.
- `created_at`/`updated_at`: keep the convention (validated number
  columns) or give them builder sugar (`c.timestamp()`) that types them
  as `number` and documents the convention in code.
- Whether `InferRecord` should expose `_status` under a branded internal
  key for advanced sync tooling, or stay strictly app-facing.
