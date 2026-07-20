# Queries reference

A query is built as pure data (a `QueryDescription`) and compiled to
parameterized SQL by `encodeQuery`. This document is the reference for
both, and for the semantics of the compiled SQL.

In an app you build queries through a collection and fetch/observe them
([database.md](database.md)); the compiler runs under the hood:

```ts
db.get(Task).query(
  Q.where('is_done', false),
  Q.where('position', Q.gt(2)),
  Q.sortBy('position', Q.desc),
  Q.take(20),
)
```

The standalone pipeline the rest of this doc describes:

```ts
import { Q, encodeQuery } from '@remelondb/core'

const description = Q.buildQueryDescription([
  Q.where('is_done', false),
  Q.sortBy('position', Q.desc),
])
const [sql, args] = encodeQuery({ table: 'tasks', description })
```

Everything is validated at construction: identifiers must match
`^[a-zA-Z_][a-zA-Z0-9_]*$`, values must be primitives (`undefined` is
rejected with a hint to use `null`; `NaN`/`Infinity` are rejected), and
condition trees only accept nodes produced by the `Q` builders (enforced with
runtime tags, so arbitrary objects can't masquerade as conditions).
Descriptions are deep-frozen outside production and survive
`JSON.stringify`/`parse` — they can cross workers or process boundaries.

## Comparison operators

`Q.where(column, value)` is shorthand for `Q.where(column, Q.eq(value))`.
Every operator below can also take `Q.column('other_column')` where noted, to
compare two columns of the same row/table.

| Builder | SQL emitted | Semantics |
| --- | --- | --- |
| `Q.eq(v)` | `col is ?` | Null-safe equality: `eq(null)` matches null. Strict across types — `'42'` never equals `42`. Column RHS allowed. |
| `Q.notEq(v)` | `col is not ?` | Negation of `eq` — **matches rows where the column is null** (`null IS NOT 'x'` is true). Column RHS allowed. |
| `Q.gt/gte/lt/lte(v)` | `col > ?` etc. | Null never matches (either side). Rejects `null` at build time. Across storage classes, SQLite ordering applies: any text sorts above any number. Column RHS allowed. |
| `Q.between(a, b)` | `col between ? and ?` | Two numbers, inclusive. Null never matches. |
| `Q.oneOf([...])` | `col in (?, ?, …)` | Non-null values only. Empty list matches **nothing**. Null column never matches. |
| `Q.notIn([...])` | `col not in (?, …)` | Non-null values only. Empty list matches **everything, including null rows** (SQLite rule). Non-empty list never matches null rows. |
| `Q.like(p)` / `Q.notLike(p)` | `col like ? escape '\'` | See [LIKE](#like-and-escapelike). `notLike` never matches null rows. |
| `Q.includes(s)` | `instr(col, ?) > 0` | Literal substring match. **Case-sensitive** (unlike `like`). Null never matches. |

The `is`/`is not` and text-above-numbers rules are SQLite's own semantics,
adopted deliberately: there is no second engine to compromise with, and the
driver conformance corpus pins them on every platform.

## LIKE and `escapeLike`

- `like` is **case-insensitive for ASCII letters only** — SQLite does not
  case-fold non-ASCII (`'å' LIKE 'Å%'` does not match).
- Patterns always compile with `escape '\'`. To match user input literally
  inside a pattern, escape it:

```ts
Q.where('name', Q.like(`%${Q.escapeLike(userInput)}%`))
```

`Q.escapeLike` backslash-escapes `\`, `%`, and `_`. (Upstream WatermelonDB's
`sanitizeLikeString` destroyed all non-alphanumeric characters instead; this
is the lossless replacement.)

## Logic and joins

- `Q.and(...conds)` / `Q.or(...conds)` nest arbitrarily.
- `Q.on(table, column, value)` or `Q.on(table, ...conditions)` places
  conditions on a joined table.

Joins need an *association* so the compiler knows the join keys:

```ts
const associations = [
  { from: 'tasks', to: 'projects', info: { type: 'belongs_to', key: 'project_id' } },
  { from: 'tasks', to: 'comments', info: { type: 'has_many', foreignKey: 'task_id' } },
]
encodeQuery({ table: 'tasks', description, associations })
```

Join semantics — deliberate and worth knowing:

- **Always `LEFT JOIN`.** A row with no joined record is not silently
  dropped; whether it matches depends on the condition. Combined with
  IS-semantics this composes usefully:
  `Q.on('projects', 'is_archived', Q.notEq(true))` matches tasks whose
  project is unarchived, tasks with **no** project, and tasks whose project
  is **deleted** — because `NULL is not 1` is true.
- **Deleted joined rows don't exist.** With `filterDeleted` on (default),
  joined tables get `_status is not 'deleted'` inside the JOIN condition —
  a deleted project behaves exactly like no project at all. The main table's
  filter goes in `WHERE`.
- **`has_many` joins deduplicate.** Any to-many join adds `select distinct`
  (or `count(distinct id)`) so fan-out never multiplies result rows.
- **Nested `Q.on`** (inside `Q.and`/`Q.or`) requires the join to be declared
  up front with `Q.joinTables([...])`; joins reached through another joined
  table use `Q.nestedJoin(from, to)`. Top-level `Q.on` declares its own join
  implicitly. Undeclared nested joins fail compilation with a clear error.

## Sorting and pagination

- `Q.sortBy(column, Q.asc | Q.desc)` — repeatable; main-table columns only.
- `Q.take(n)` / `Q.skip(n)` — `skip` requires `take`; duplicates are errors;
  neither is allowed in count mode. Both compile to bound placeholders.

## Unsafe escape hatches

- `Q.unsafeSqlExpr('length("name") > 3')` — a raw SQL fragment inside WHERE.
- `Q.unsafeSqlQuery('select * from tasks where …', [args])` — replaces the
  entire compiled query (values are still bound). Can only be combined with
  join declarations; cannot be counted.

Both bypass injection safety for whatever you interpolate yourself — hence
the names.

## Compilation: `encodeQuery`

```ts
encodeQuery(
  { table, description, associations? },
  { mode?: 'select' | 'count', filterDeleted?: boolean },
): [sql, args]
```

- `mode: 'count'` returns one row with a `count` column.
- `filterDeleted` (default `true`) hides `_status = 'deleted'` tombstones —
  see [records.md](records.md). Sync internals query with it off.
- Output is deterministic and fully parameterized; the only strings
  interpolated into SQL are identifiers already validated by the builders.

SQLite is the only engine that evaluates a query — observation re-queries
it rather than re-matching in JS ([database.md](database.md)). The
semantics above (IS-equality, storage-class ordering, ASCII-only LIKE
folding, the `NOT IN ()` edge case) are pinned by the driver conformance
query corpus; if you extend the compiler, extend the corpus.
