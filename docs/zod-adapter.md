# @remelondb/zod: shared schemas as the single source of truth

Status: implemented (packages/zod). Second step of the plan begun
in [schema-inferred-types.md](schema-inferred-types.md): that doc made
the table literal the source of truth *inside* a client; this one lets a
shared Zod schema be the source of truth *across* a whole stack (server
database, wire validation, client database).

## Why

The consumer this is designed against runs Drizzle + Postgres on the
server, Zod schemas in a shared workspace package, and remelonDB on the
client. Today those are three definitions of the same records. The
target chain is one:

```
Drizzle schema (server truth)
  → drizzle-zod → shared Zod objects (@repo/schemas)
      → frontend form validation
      → backend request validation
      → sync payload validation, both directions
      → zodTable() → remelonDB client tables
```

Validation placement matters more than validation volume. Local writes
are already guarded (`sanitizedRaw` sanitizes every record against the
table schema). The genuinely untrusted inputs are the two sync
directions: what `pullChanges` returns from the network, and what a
client pushes to the server — a push is user input to the backend,
exactly like a form submission, and must be validated like one.

## Design

A new package, `@remelondb/zod`. Peer dependencies: `@remelondb/core`
and `zod` (^4 — the target consumer is on Zod 4, and 4's stable
introspection is what the implementation should build on). Core itself
gains nothing: no new options, no runtime changes. Everything composes
through existing surfaces.

### 1. `zodTable`: a table definition from a Zod object

```ts
// @repo/schemas (shared)
export const Card = z.object({
  deck_id: z.string(),
  front: z.string(),
  back: z.string(),
  due_at: z.number(),
  notes: z.string().nullable(),
})

// client
import { zodTable } from '@remelondb/zod'
export const cards = zodTable('cards', Card, { indexed: ['deck_id', 'due_at'] })
// cards is a plain TableSchema — usable in appSchema, ModelFor, db.get
```

Mapping rules (the supported vocabulary, v1):

| Zod | Column |
| --- | --- |
| `z.string()` (incl. refinements: `.min`, `.email`, …) | `string` |
| `z.number()` (incl. `.int()`, refinements) | `number` |
| `z.boolean()` | `boolean` |
| `.nullable()` of the above | the same column, `.optional()` |

Everything else is a loud error at `zodTable` call time, naming the key
and the unsupported construct. Two deliberate rejections:

- **`.optional()` (undefined) is rejected, only `.nullable()` maps.**
  remelonDB's value vocabulary has `null` and no `undefined`; accepting
  `.optional()` would silently conflate the two. The error message tells
  the user to write `.nullable()`.
- **Refinements are kept, not lost.** A refined `z.string().email()`
  still maps to a `string` column — but the *original* Zod object is
  what validates wire payloads (section 2), so the email check runs at
  the trust boundary even though SQLite stores a plain string.

Reserved keys (`id`, `_status`, `_changed`, rowid aliases) are rejected
exactly as `table()` rejects them; `indexed` in the options names
columns to index, since Zod has no such concept.

### 2. Wire schemas: validate both sync directions

The adapter builds Zod schemas for the sync protocol's wire types
(`SyncPullResult`, `SyncPushArgs`, … from core's `sync/types.ts`) out of
the same per-table objects:

```ts
import { syncSchemas } from '@remelondb/zod'

const sync = syncSchemas({ cards: Card, decks: Deck, reviews: Review })
// sync.pullResult  — parses { changes, cursor } | { resyncRequired: true }
// sync.pushArgs    — parses { changes, cursor }
// sync.pushResult  — parses { cursor, changes, rejected? } | { conflict: true }
```

Wire records are the table object extended with `id: z.string()`
(records on the wire carry user columns plus id only; `_status` and
`_changed` never cross — the schema enforces that by rejecting unknown
keys). Deleted entries are id arrays. The cursor stays `z.string()`,
opaque as the protocol requires.

Integration needs no core hook, because validation slots into functions
the app already writes:

```ts
// client: pull validation inside the app's own pullChanges
pullChanges: async (args) => {
  const res = await fetch('/sync/pull', { ... })
  return sync.pullResult.parse(await res.json())
}
```

```ts
// server (NestJS): the same builder runs without remelonDB at all —
// syncSchemas is pure Zod, so the push endpoint validates its body
// with sync.pushArgs like any other DTO
```

A pull that fails parsing throws inside `pullChanges`; `synchronize`
already propagates that as a failed sync with the local database
untouched (writes apply atomically at the end). No partial state.

### 3. The interop contract, testable

For every supported schema: `InferRecord<ReturnType<zodTable>>` must
equal `z.infer<typeof schema> & { readonly id: string }`. This is pinned
with type-level equality assertions, the same technique as
schema/typeInference.test.ts. It is the load-bearing guarantee: a
record type derived on the client and one inferred from the shared
schema can never drift, because they are computed from the same object.

Runtime pins: `zodTable` output deep-equals the hand-written `table()`
equivalent; `sync.pullResult` accepts the driver-node sync test fixtures
verbatim and rejects them under mutations (wrong type in a column,
extra `_status` key, missing cursor).

## Non-goals

- Replacing `sanitizedRaw`. Local writes keep the lenient sanitize path;
  Zod validates trust boundaries. (Strict Zod-validated `create()` is a
  conceivable later option, listed under open questions.)
- Zod 3 support. The consumer is on 4; supporting both doubles the
  introspection surface for no current user.
- Generating server schemas. Drizzle→Zod is `drizzle-zod`'s job; this
  package only consumes the result.
- Enums, dates, defaults, nested objects. See open questions; v1 rejects
  them loudly rather than mapping them lossily.

## Open questions

- **Enums**: `z.enum([...])` could store as `string`, but then
  `InferRecord` (which sees `ColumnDef<'string'>`) widens where
  `z.infer` narrows, breaking the interop contract. Supporting them
  properly wants a value-type parameter on `ColumnDef` — the same
  machinery the planned Q value-typing needs, so the two designs should
  land together.
- **Timestamps**: server Drizzle uses `timestamp` (Date objects);
  remelonDB stores numbers. The wire crossing needs one convention
  (epoch milliseconds) and a documented transform on the server edge.
  This is an app-repo decision the adapter should document but not
  decide.
- Whether `synchronize` should eventually take the schemas directly
  (`validate: sync`) instead of relying on apps to call `.parse` — more
  discoverable, but adds a core dependency direction worth resisting
  until real usage argues for it.
- A strict-create option (`createValidated`) for apps that want Zod at
  the local write boundary too.
