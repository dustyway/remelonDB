# Database & observation reference

The `Database` owns the driver, the collections, the writer queue, and the
change-notification bus. This is the runtime API reference; the query
*language* is in [queries.md](queries.md), models in [models.md](models.md).

## Opening

```ts
const db = await Database.open({
  driver,               // any SqliteDriver
  schema,               // appSchema — see schema.md
  migrations,           // optional schemaMigrations
  modelClasses: [Task], // optional — see models.md
  associations: [...],  // optional Q.on metadata for model-less tables
  name: 'app.db',       // passed to driver.open
})
```

`open()` runs the two-phase init: fresh database → schema DDL; older
version → migration steps (**a missing migration path throws** — data
destruction is never implicit); newer version → refuses (app downgrade).

## Reads, writes, and the queue

All work is serialized through one strictly-FIFO queue:

- `db.write(async () => { ... })` — the only place mutations are allowed.
  `create`/`update`/`markAsDeleted`/`destroyPermanently`/`batch` throw
  outside of it.
- `db.read(async () => { ... })` — a consistency window: no writer runs
  while the block does. Plain fetches (`find`, `query().fetch()`) are
  allowed anywhere and don't enqueue.
- **No re-entrancy**: calling `db.write`/`db.read` from inside a running
  block deadlocks. Compose with plain functions inside one block.

## Collections and CRUD

`db.get(tasks)` (a table object) or `db.get(Task)` (a model class) returns
the table's typed Collection:

The two forms differ in what the records *are*. Records from a
collection with a bound model class (listed in `Database.open`'s
`modelClasses`) are model instances — the `update` builder,
`markAsDeleted()`, `observe()`, association helpers. Without a bound
class, records are plain typed rows: fields read fine, but record
methods do not exist at runtime even though the table-object form's
types currently claim they do — calling `record.update()` on an unbound
collection throws. Rule of thumb: bind a model class and use
`db.get(Model)` whenever you mutate through records; the bare
table-object form suits read-only access and model-less tables.
Collection-level CRUD (`collection.update(id, fields)`,
`collection.markAsDeleted(id)`) works either way.

```ts
await db.write(async () => {
  const task = await db.get(Task).create({ name: 'a', position: 1 })
  await db.get(Task).update(task.id, { name: 'b' })   // sanitized, dirty-tracked
  await db.get(Task).markAsDeleted(task.id)           // sync tombstone
  await db.get(Task).destroyPermanently(task.id)      // gone for real
})
const found = await db.get(Task).find('some-id')      // throws if missing
```

- `create`/`update` auto-stamp `created_at`/`updated_at` when those columns
  exist; updates track changed columns for sync ([records.md](records.md)).
- `prepareCreate`/`prepareUpdate` build operations without committing —
  combine several into one atomic `db.batch([...])`.
- **Identity map**: one record instance per id. `find`, `query`, and
  `create` all return the same object; updates mutate it in place.

## The batch contract

`db.batch(operations)` executes everything in **one driver transaction**.
On success, caches are updated first, then subscribers are notified — every
subscriber observes a consistent world. On failure, nothing happened: no
cache changes, no notifications, records keep their prepared state, and the
error propagates out of the write block.

## Observation

```ts
const unsub = db.get(Task)
  .query(Q.where('is_done', false))
  .observe(
    (records) => render(records),
    (error) => showDatabaseError(error),
  )

const unsub2 = db.get(Task).query().observeCount((n) => setBadge(n))
```

The second argument is why observation failures are survivable: a
re-fetch can fail (database gone, driver error), and without the
callback that failure is an unhandled rejection — the list simply stops
updating with nothing in the UI to say so. With it, the failure reaches
the code that can show it. A subscriber that itself throws is an app bug
and is deliberately not routed here.

One strategy for every query: re-fetch when any of the query's tables
change, emit the initial results and then whenever the result list
differs — by membership, order, or visible-column content.

Notes that follow from the design:

- A listed record's visible-column change re-emits the list (a synced
  remote edit repaints a sorted list); bookkeeping-only changes
  (`_status`/`_changed`, e.g. a push marking records synced) never
  re-emit.
- Observers discard stale in-flight results (generation counter)
  and re-emit only when the fetched list actually differs.
- Both `observe` and `observeCount` accept an optional second error callback.
- `observeCount` re-queries `count(*)` on relevant changes and emits only
  when the number changed. No throttling (upstream's was knowingly buggy);
  add debouncing in the UI layer if you need it.

In React, don't wire `observe()` by hand: the hooks in
[react.md](react.md) wrap these observations with shared subscriptions
and structural query keys.

### Diagnostics and cancellation

Pass `onObservation` to `Database.open` for opt-in instrumentation:

```ts
const db = await Database.open({
  driver,
  schema,
  name: 'app.db',
  onObservation: (event) => metrics.record(event),
})
```

Each event names the table and query description, records/count mode,
initial/change trigger, duration, result count, and whether the request
succeeded, failed, or was discarded as stale. The callback is passive:
exceptions it throws are ignored, and no timing is collected when it is
absent.

Unsubscribing invalidates an in-flight result, so it can never emit into a
dead subscription. It does not interrupt SQLite work already executing.
The driver seam intentionally has no cancellation method: Node SQLite is
synchronous once entered, while worker and native interruption have
different guarantees. Generation-based stale-result suppression is the
portable contract; an `AbortSignal` that only stopped some drivers would be
misleading.

Lower-level buses, mostly for infrastructure:

- `db.onChange(tables, handler)` — batched changes touching any listed
  table, keyed by table.
- `collection.onChange(handler)` — this table's changes. Both deliver
  **raw-level** records.

## Local storage

`db.localStorage` — string key-value storage in the core-owned
`local_storage` table. Sync keeps its cursor here; apps may use it for
small metadata. `get(key) → string | null`, `set(key, value)`,
`remove(key)`.
