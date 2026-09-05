# Models reference

The Model layer gives records a typed, ergonomic class API. It is a _view_
over the raw-record engine ([database.md](database.md)): the cache,
batching, notifications, and sync all keep operating on RawRecords; models
wrap the cached raws one-to-one.

## Defining a model

```ts
import { z } from 'zod'
import { ModelFor, type AssociationsMap } from '@remelondb/core'
import { zodTable } from '@remelondb/core/zod'

const tasks = zodTable('tasks', z.object({
  name: z.string(),
  is_done: z.boolean(),
  project_id: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
}))

class Task extends ModelFor(tasks) {
  static override readonly associations = {
    projects: { type: 'belongs_to', key: 'project_id' },
    comments: { type: 'has_many', foreignKey: 'task_id' },
  } satisfies AssociationsMap
  // no field declarations: name/is_done/project_id/created_at/updated_at
  // are typed from the table definition
}

const db = await Database.open({ ..., modelClasses: [Task] })
```

**No decorators, no field declarations.** `ModelFor(tasks)` binds the class
to its table (`static table` is set by the factory; subclasses don't write
it) and types every instance field from the table definition. Field
accessors are generated on the class prototype from the table schema when
the class is bound. Property names equal column names. A column that
collides with the Model API (`update`, `id`, `observe`, …) fails
`Database.open` with a clear error.

Booleans read as real `true`/`false`, numbers as numbers, optional columns
as `T | null` — whatever `sanitizedRaw` guarantees
([records.md](records.md)) is what the accessor returns.

## Reading and writing

```ts
const task = await db.get(Task).find('t1');
task.name; // read anywhere
task.name = 'x'; // ❌ throws — records are read-only outside update()

await db.write(() =>
  task.update(() => {
    task.name = 'renamed'; // staged; visible inside the builder
    task.is_done = true;
  }),
);
```

Builder writes use the same pipeline as `collection.update`. It sanitizes
values by column type, tracks only values that changed, and updates
`updated_at` automatically. Unknown columns have no accessor, and TypeScript
rejects them. `task.markAsDeleted()` /
`task.destroyPermanently()` mirror the collection methods.

`update()` commits one update. Use `prepareUpdate()` when that update must
commit atomically with other work:

```ts
await db.write(() =>
  db.batch([
    auditEvents.prepareCreate({ task_id: task.id, action: 'completed' }),
    task.prepareUpdate(() => {
      task.is_done = true;
    }),
  ]),
);
```

The builder can read its pending values, but the cached model remains
unchanged after `prepareUpdate()` returns. `db.batch()` applies the values
only after the driver commits the whole batch. A failed batch leaves the
model unchanged.

## Identity

Each record id has one model instance wrapping its cached raw. `find`,
`query().fetch()`, and `create` return the same instance; committed
updates — including ones applied by **sync** — mutate it in place. Holding
a model in UI state and observing it is therefore safe and cheap.

## Relations

`static associations` declares join metadata once; it powers three things:

```ts
// 1. Q.on joins in queries (compiler reads associations from the class)
db.get(Task).query(Q.on('projects', 'is_archived', false));

// 2. belongs_to navigation
const project = await task.related<Project>('projects'); // Model | null

// 3. has_many navigation — returns a Query: fetch it or observe it
const open = await project.children<Task>('tasks').fetch();
project.children<Task>('tasks').observe(renderTaskList);
```

## Observing one record

```ts
const unsub = task.observe((record) => {
  if (record === null) return closeDetailView(); // deleted
  render(record); // created/updated
});
```

`observe` emits the record immediately, after every committed update
(regardless of which columns changed), and `null` on deletion. In contrast,
`query().observe()` re-emits only when the result's membership, order, or
visible content changes ([database.md](database.md#observation)).

## Sync

Models expose `syncStatus` (the record's `_status`), but sync otherwise
operates below the model layer. A pulled server
update lands in the cached raw, so live model instances reflect it
after the sync commit. See [sync.md](sync.md).
