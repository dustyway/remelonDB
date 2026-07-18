# Schema-inferred types

Status: implemented. Motivated by making remelonDB's
type story match the schema-first style of its first consumer's stack
(Drizzle on the server, Zod for shared validation).

## The problem

Today the schema and the types are written twice, and nothing checks that
they agree:

```ts
const schema = appSchema({
  version: 1,
  tables: [
    tableSchema({
      name: 'tasks',
      columns: [
        { name: 'name', type: 'string' },
        { name: 'position', type: 'number', isIndexed: true },
      ],
    }),
  ],
})

class Task extends Model {
  static override readonly table = 'tasks'
  declare name: string      // hand-written duplicate of the schema
  declare position: number  // typo here = silent undefined at runtime
}
```

Three concrete failure modes, none caught by the compiler:

1. A `declare` that drifts from the schema (wrong name, wrong type,
   missing `| null` on an optional column) produces records whose types lie.
2. `Q.where('nmae', ...)` compiles fine and matches nothing.
3. `db.get<Task>('tasks')` is an unchecked cast; the string and the type
   parameter are not connected.

## Goals

- One source of truth: the schema literal. Record types, column-name
  checking, and collection types are all derived from it.
- No runtime redesign: the schema module's output objects
  (`TableSchema`, `AppSchema`), the DDL compiler, migrations, and the
  query AST stay exactly as they are. This is a surface change: input
  syntax plus a type layer.
- Keep the door open for the Zod adapter (separate design): a Zod object
  must be mechanically convertible into the same table definitions.
  (Since built: `zodTable` in [zod-adapter.md](zod-adapter.md) produces
  identical `TableSchema` output, pinned by test.)

Non-goals: a Drizzle-style chained query builder (the serializable query
AST is load-bearing for observation and sync and stays); runtime
validation of local writes (`sanitizedRaw` already covers it); changing
the wire or storage format.

## Design

### 1. Column builders, object-map syntax

The old helper took a columns array and built a name-keyed map
internally. The definition syntax is now the map directly, with builders:

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

Builders are tiny: three constructors (`string`, `number`, `boolean`) and
two modifiers (`optional()`, `indexed()`). Each produces a plain
`ColumnSchema` object at runtime; `table()` produces a `TableSchema` plus
the type information described next. Reserved-name and
`created_at`/`updated_at` validation is unchanged.

The array syntax is removed, not deprecated: the package is unpublished,
and one blessed way to write a schema is worth more than compatibility
with zero external users.

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
`_status`/`_changed` do not appear (they are core-internal, and code that
needs them is already working with `RawRecord`).

### 3. Tables are values; collections are typed by them

```ts
const collection = db.get(tasks)  // Collection<typeof tasks>
```

`db.get` takes the table object (or a model class: `db.get(Task)`), so
the unchecked cast from failure mode 3 is no longer needed. Two honest
limits: the string overload still exists for dynamic and internal
access, so the old cast form remains *expressible*, just never
necessary; and `Database` is not generic over its schema, so passing a
table object that is not part of this database's schema fails at
runtime (with a clear error), not at compile time. Making `Database`
schema-generic would close both and is listed under open questions.

### 4. Models keep the class, lose the `declare`s

```ts
class Task extends ModelFor(tasks) {
  // no declared fields: name/position/is_done/project_id are typed
  // from the table definition; accessors are generated at bind time
  // as today; `static override associations = {...}` still goes here
}
```

The base class comes from a factory because a bare generic class cannot
type instance fields from a type parameter: TypeScript gives a class no
way to declare properties whose names come from a generic, so
`ModelFor(tasks)` returns a base class whose instance type already
carries the inferred fields.

The class layer stays because behavior lives there (update builders,
associations, sync-aware writes). What changes is that field types come
from the table object instead of hand duplication. `static table` is set
by `ModelFor` from the table object (subclasses don't write it), which
also lets `Database.open` check that every model's table is in the app
schema.

A class-free record API (plain typed objects, functions for writes) would
be the fuller Drizzle match but requires reworking record identity in the
observation layer and the record cache. Deliberately out of scope;
revisit after the Zod adapter ships.

### 5. Column names in `Q` are checked

`Q.where` and `Q.sortBy` carry their column name as a type parameter
(`Clause<'position'>`); `collection.query(...)` constrains accepted
clauses to `Clause<keyof InferRecord<T>>`. A misspelled column becomes a
compile error at the query site. The runtime AST is byte-for-byte
unchanged; `Q.on` (joined tables) stays string-typed in the first
iteration and is listed as an open question.

## What this buys, checkably

- Failure modes 1 and 2 become compile errors, pinned by
  `@ts-expect-error` cases (schema/typeInference.test.ts). Mode 3 (the
  unchecked cast) is eliminated by replacement rather than removal: the
  typed `db.get(Task)`/`db.get(tasks)` forms make it unnecessary, but
  the string overload remains for dynamic access (see section 3).
- The flashcard tutorial loses every `declare` line.
- Zod adapter interop: `zodTable(z.object({...}))` can emit the same
  `TableSchema` + types, and `InferRecord` must equal `z.infer` for the
  supported column vocabulary. That equality is testable with a
  type-level assertion.

## Migration impact

Mechanical, contained to schema definitions and model classes: the
tutorial, README examples, all test schemas, and the conformance suite's
corpus setup. No driver, DDL, sync, or observation code changes. Estimate:
the type layer and builders are the real work; the migration is an
afternoon of find-and-edit verified by typecheck.

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
- `Q.on` and association typing: checking joined-table columns needs the
  association graph in types; worth it, but a second iteration.
- `created_at`/`updated_at`: keep the convention (validated number
  columns) or give them builder sugar (`c.timestamp()`) that types them
  as `number` and documents the convention in code.
- Whether `InferRecord` should expose `_status` under a branded internal
  key for advanced sync tooling, or stay strictly app-facing.
