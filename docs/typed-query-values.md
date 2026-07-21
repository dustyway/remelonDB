# Typed query values and enum columns

Status: proposed, not started. Per-column value typing in `Q` and
`z.enum` support in the Zod adapter, designed together because they
need the same machinery: a value-type parameter on `ColumnDef`.

## The failure class this removes

SQLite compares type-aware: the number `5` never equals the string
`'5'`. A mistyped comparison value therefore compiles, runs, and
silently matches nothing:

```ts
db.get(tasks).query(Q.where('position', '5'))   // compiles; empty result
```

This is the same silent-wrong-answer class that schema-inferred types
removed for column names, one level deeper. Enums are the same problem
through the Zod adapter: `z.enum(['open', 'done'])` cannot map to a
column today because `InferRecord` (which sees only `'string'`) would
widen where `z.infer` narrows, breaking the interop contract
`InferRecord<zodTable(...)> = z.infer<schema> & { id }`.

## Shape of the design

- **Phantom only.** The query AST, the compiled SQL, `ColumnSchema`,
  DDL, sanitization, and the wire format are byte-identical to today.
  Everything below is type-level and erased.
- **Checked at the query site.** Comparisons are built standalone
  (`Q.gt(5)` has no column context), so the value type rides on the
  comparison and is checked where the clause meets the collection —
  the same place column names are checked now.
- **The dynamic path stays.** `db.get('tasks')` (string form) keeps
  today's untyped clauses; all defaults are the current permissive
  types, so only table-object collections get the stricter checks.

## Design

### 1. `ColumnDef` gains a value-type parameter

```ts
interface ColumnDef<
  T extends ColumnType = ColumnType,
  Optional extends boolean = boolean,
  V extends Value = ValueOf<T>,        // string | number | boolean per T
> { ... }
```

`InferRecord` reads `V` instead of mapping `T`, so existing columns
infer exactly as before, and an enum column infers its union.

### 2. `column.enum`: the hand-written enum column

```ts
const tasks = table('tasks', {
  state: c.enum(['open', 'done']),     // ColumnDef<'string', false, 'open' | 'done'>
})
type R = InferRecord<typeof tasks>     // { state: 'open' | 'done', ... }
```

At runtime `c.enum(values)` produces exactly what `c.string()`
produces — the values array is consumed by the type system only.
`ColumnSchema` stays `{ type: 'string' }`, so DDL, migrations, and the
`zodTable` deep-equality pin are untouched. Nothing at runtime rejects
an out-of-vocabulary string locally: local writes stay lenient
(`sanitizedRaw` coerces to string), and enforcement belongs to the
trust boundary, where the wire schemas already validate the original
Zod object. This is the same stance the adapter takes for refinements.

### 3. Comparisons carry their value type

```ts
interface Comparison<V extends Value = Value> {
  ...                                  // runtime shape unchanged
  readonly $v?: V                      // phantom, always undefined
}

Q.eq<V>(value: V): Comparison<V>
Q.gt/gte/lt/lte<V extends NonNullValue>(value: V): Comparison<V>
Q.oneOf/notIn<V extends NonNullValue>(values: readonly V[]): Comparison<V>
Q.between(a: number, b: number): Comparison<number>
Q.like/notLike/includes(pattern: string): Comparison<string>
```

`WhereDescription<C, V>` carries both phantom parameters;
`Q.where(left, value)` infers `V` from a bare value or takes it from
the comparison. `Q.and`/`Q.or` propagate the same union their
conditions carry, as they do for column names today.

### 4. The clause union becomes value-aware

`Collection`'s second type parameter grows from a column-name union to
a column→value map derived from the table (`id` included as `string`).
The accepted clause type distributes over it:

```ts
type WhereFor<M> = { [K in keyof M & string]: WhereDescription<K, M[K]> }[keyof M & string]
```

`V` sits covariantly, so the check is subtype-shaped: `Q.eq('open')`
(a `Comparison<'open'>`) satisfies an `'open' | 'done'` column;
`Q.eq('opne')` and `Q.gt('5')`-against-a-number-column do not.
`Q.like(...)` is `Comparison<string>`, so string patterns on number
columns stop compiling too — previously another silent empty result.
Comparing against a nullable column accepts `null` for `eq`/`notEq`
(the record field type includes it); the ordered comparisons already
reject `null` at runtime and now also at compile time.

### 5. Zod: `z.enum` maps to an enum column

`ColumnFor` accepts `z.ZodEnum`, producing
`ColumnDef<'string', false, z.infer<enum>>` (nullable variant as
usual); runtime maps it to the same output as `c.enum`. The interop
contract holds by construction: both sides now narrow. Wire schemas
keep using the original Zod object, so enum membership is enforced at
the sync boundary with no new code.

## Compatibility

Runtime: none — no AST, SQL, schema, or wire change. Types: code that
was silently wrong stops compiling, which is the point of the release.
Correct code can break only where a value was deliberately typed wider
than the column (e.g. a `Value`-typed variable passed to a `number`
column); the fix is a narrowing or the string-collection path. Ships
as a breaking type-level change in the next release notes.

## Non-goals

- **Runtime validation of query values.** Compile time is the contract
  here; runtime enforcement lives at the wire (Zod) as everywhere else.
- **`Q.on` and association typing.** Joined-table columns stay
  string-typed; checking them needs the association graph in types
  (existing open question, unchanged).
- **`z.literal`, unions, defaults, dates.** `z.enum` only; the rest
  keeps failing loudly in `zodTable`.

## Testing

- `schema/typeInference.test.ts` grows value pins: the examples above
  as `@ts-expect-error` cases, plus exact `InferRecord` shapes for
  `c.enum`.
- `zod/index.test.ts` pins the enum mapping: runtime deep-equality
  with the hand-written `c.enum` table, and type-level equality of
  `InferRecord` with `z.infer & { id }` for an enum column.
- No new runtime behavior, so no new runtime suites.

## Open questions

- **`Q.column` right-hand sides.** `Q.eq(Q.column('other'))` has no
  value type; v1 types it as an opt-out (`Comparison<any>`), losing
  value checking for that one clause. Typing it properly needs the
  column map at comparison-build time, which the standalone-builder
  shape resists.
- **Error-message quality.** The distributed clause union produces
  correct but verbose errors ("not assignable to WhereDescription<...>
  | ..."). If this reads badly in practice, a branded error type per
  mismatch case can replace the raw union later without changing the
  public surface.
- **`created_at`/`updated_at` sugar** (`c.timestamp()`) still pends
  separately; nothing here blocks it.
