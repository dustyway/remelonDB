# Models reference

The Model layer gives records a typed, ergonomic class API. It is a *view*
over the raw-record engine ([database.md](database.md)): the cache,
batching, notifications, and sync all keep operating on RawRecords; models
wrap the cached raws one-to-one.

## Defining a model

```ts
import { Model, type AssociationsMap } from '@remelondb/core'

class Task extends Model {
  static override readonly table = 'tasks'
  static override readonly associations = {
    projects: { type: 'belongs_to', key: 'project_id' },
    comments: { type: 'has_many', foreignKey: 'task_id' },
  } satisfies AssociationsMap

  declare name: string
  declare is_done: boolean
  declare project_id: string | null
  declare created_at: number
  declare updated_at: number
}

const db = await Database.open({ ..., modelClasses: [Task] })
```

**No decorators.** Field accessors are generated on the class prototype
from the table schema when the class is bound. Subclass fields are
`declare`-only (type-level, no runtime emit — a plain `name!: string` field
would shadow the generated accessor with `undefined`). Property names equal
column names. A column that collides with the Model API (`update`, `id`,
`observe`, …) fails `Database.open` with a clear error.

Booleans read as real `true`/`false`, numbers as numbers, optional columns
as `T | null` — whatever `sanitizedRaw` guarantees
([records.md](records.md)) is what the accessor returns.

## Reading and writing

```ts
const task = await db.get<Task>('tasks').find('t1')
task.name            // read anywhere
task.name = 'x'      // ❌ throws — records are read-only outside update()

await db.write(() =>
  task.update(() => {
    task.name = 'renamed'     // staged; visible inside the builder
    task.is_done = true
  }),
)
```

Builder writes flow through the same pipeline as `collection.update`:
values sanitized per column type, unknown columns impossible (no accessor,
and TypeScript rejects them), dirty tracking only for values that actually
changed, `updated_at` auto-touched. `task.markAsDeleted()` /
`task.destroyPermanently()` mirror the collection methods.

## Identity

One model instance per record id, wrapping the cached raw. `find`,
`query().fetch()`, and `create` return the same instance; committed
updates — including ones applied by **sync** — mutate it in place. Holding
a model in UI state and observing it is therefore safe and cheap.

## Relations

`static associations` declares join metadata once; it powers three things:

```ts
// 1. Q.on joins in queries (compiler reads associations from the class)
db.get<Task>('tasks').query(Q.on('projects', 'is_archived', false))

// 2. belongs_to navigation
const project = await task.related<Project>('projects')   // Model | null

// 3. has_many navigation — returns a Query: fetch it or observe it
const open = await project.children<Task>('tasks').fetch()
project.children<Task>('tasks').observe(renderTaskList)
```

## Observing one record

```ts
const unsub = task.observe((record) => {
  if (record === null) return closeDetailView()   // deleted
  render(record)                                  // created/updated
})
```

Emits the record immediately, after every committed update (regardless of
which columns changed), and `null` on deletion. This is the
content-granular counterpart to `query().observe()`, which only reacts to
membership changes ([database.md](database.md#observation)).

## Sync

Nothing model-specific: models expose `syncStatus` (the record's
`_status`), and sync operates below the model layer — a pulled server
update lands in the cached raw, so live model instances reflect it
instantly. See [sync.md](sync.md).
