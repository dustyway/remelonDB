# @remelondb/zod

The Zod adapter for [remelonDB](https://github.com/dustyway/remelonDB):
one shared Zod object becomes the single source of truth for a whole
stack — client tables, record types, and validation of both sync
directions.

## `zodTable`: a table definition from a Zod object

```ts
import { z } from 'zod'
import { zodTable } from '@remelondb/zod'

export const Task = z.object({
  name: z.string().min(1).max(120),
  position: z.number().int(),
  is_done: z.boolean(),
  note: z.string().nullable(),
})

export const tasks = zodTable('tasks', Task, { indexed: ['position'] })
// a plain TableSchema — usable in appSchema, ModelFor, db.get;
// InferRecord<typeof tasks> equals z.infer<typeof Task> & { id: string }
```

Supported vocabulary: `z.string()`, `z.number()`, `z.boolean()`, each
optionally `.nullable()` (maps to an optional column — SQL `NULL`).
Refinements (`.min`, `.email`, …) keep their column type and still
validate on the wire. Deliberate rejections, loud and by name:

- **`.optional()`** — Zod's `undefined` has no home in the value
  vocabulary (`string | number | boolean | null`); conflating it with
  `null` silently is the bug this package exists to prevent. Use
  `.nullable()`.
- Everything else (dates, enums, nested objects, defaults) — errors at
  build time rather than mapping lossily. Enums are planned alongside
  value-typed columns; see the design doc's open questions.

## `syncSchemas`: wire validators for the sync protocol

Validators for the [sync wire protocol](../../docs/sync-wire.md), built
from the same objects — pure Zod, so a server can use them without
depending on remelonDB:

```ts
import { syncSchemas } from '@remelondb/zod'

const wire = syncSchemas({ tasks: Task }, { id: z.uuid() })

// client: validate what the server returns, at the trust boundary
pullChanges: async (args) => {
  const res = await fetch('/sync/pull', { method: 'POST', body: JSON.stringify(args) })
  return wire.pullResult.parse(await res.json())
}

// server: validate what clients push, with the identical schemas
const push = wire.pushArgs.parse(requestBody)
```

Wire rows are strict — user columns plus `id`, nothing else — so
`_status`/`_changed` or anything smuggled fails loudly. The push-result
validator enforces the protocol's package rule (a cursor comes with the
interleaved changes, or both are null), so a nonconforming server fails
validation instead of silently losing writes.

## License

[MIT](https://github.com/dustyway/remelonDB/blob/main/LICENSE)
