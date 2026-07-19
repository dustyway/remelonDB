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
  .observe((records) => render(records))

const unsub2 = db.get(Task).query().observeCount((n) => setBadge(n))
```

Two strategies, chosen automatically per query:

| | Simple | Reloading |
| --- | --- | --- |
| Applies to | flat single-table queries (`canEncodeMatcher`) | joins, sortBy, take/skip, raw SQL |
| Mechanism | in-memory matcher re-checks membership per change — no re-query | re-fetch when any of the query's tables change |
| Emits | initial results, then on **membership changes** | initial results, then when the result list differs — membership, order, or visible-column content |

Notes that follow from the design:

- Simple observers emit on membership only: a content change that doesn't
  affect membership doesn't re-emit the list — observe individual records
  for that (`model.observe`, models.md). Reloading observers do re-emit
  when a listed record's visible columns change (a synced remote edit
  repaints a sorted list); bookkeeping-only changes (`_status`/`_changed`,
  e.g. a push marking records synced) never re-emit.
- The simple observer subscribes before its initial fetch and buffers
  changes, so commits racing the first fetch aren't lost.
- Reloading observers discard stale in-flight results (generation counter)
  and re-emit only when the fetched list actually differs.
- `observeCount` re-queries `count(*)` on relevant changes and emits only
  when the number changed. No throttling (upstream's was knowingly buggy);
  add debouncing in the UI layer if you need it.

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
