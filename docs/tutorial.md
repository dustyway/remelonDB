# Tutorial: a flashcard app on remelonDB

This walkthrough builds the data layer of a small flashcard app: decks
containing cards, reviews recorded as you study, a due-cards study
queue, a live counter for the UI, a schema migration, and a sync hookup
at the end. CI executes the code blocks below straight out of this
file: [scripts/check-tutorial.mjs](../scripts/check-tutorial.mjs)
extracts them and runs them against the built packages on every push,
so what you read here is code that provably runs. That includes the
sync hookup, which runs against the real backend engine in-process.
Two illustrative blocks are marked as fragments and skipped: the
migration re-open sketch and the HTTP route wiring in section 10. You
can paste the pieces into a Node project and follow along.

The examples use `NodeSqliteDriver` so they run anywhere. In an app you
swap only the driver import: `RnSqliteDriver` from
`@remelondb/driver-rn` on React Native, `WebSqliteDriver` from
`@remelondb/driver-web` in the browser. Everything else is identical on
all platforms, which is the point of the driver seam.

## 1. Install

remelonDB is split into frontend and backend packages around one wire
protocol. The frontend — your app — installs `@remelondb/core` and one
driver from npm:

```sh
pnpm add @remelondb/core @remelondb/driver-node zod
```

`@remelondb/core/zod` is the schema front end this tutorial uses: one Zod
object per table drives the client table, the record types, and — in
section 10 — validation of both sync directions.

The backend — wherever your sync endpoints live — installs the sync
engine (wired up in section 10):

```sh
pnpm add @remelondb/server
```

The engine embeds in your own server and stores data in memory out of
the box — enough for this tutorial and for development; durable
storage comes from implementing its small storage seam.

Apps that never sync need only the first line. For later:
`@remelondb/server/conformance` proves a custom backend store against
the protocol contract.

## 2. Define the schema

Three tables. Cards carry a `due_at` timestamp that the scheduler
updates after each review; reviews are append-only facts about what
happened.

Each table is one Zod object — the single source of truth. It becomes
the client table here, and the same object validates the sync wire in
section 10.

```js
import { z } from 'zod'
import { appSchema } from '@remelondb/core'
import { zodTable } from '@remelondb/core/zod'

const DeckRow = z.object({
  title: z.string().min(1),
  created_at: z.number(),
  updated_at: z.number(),
})

const CardRow = z.object({
  deck_id: z.string(),
  front: z.string(),
  back: z.string(),
  due_at: z.number(),
  created_at: z.number(),
  updated_at: z.number(),
})

const ReviewRow = z.object({
  card_id: z.string(),
  rating: z.number().int().min(0).max(3),
  reviewed_at: z.number(),
})

const decks = zodTable('decks', DeckRow)
const cards = zodTable('cards', CardRow, { indexed: ['deck_id', 'due_at'] })
const reviews = zodTable('reviews', ReviewRow, { indexed: ['card_id'] })

const schema = appSchema({ version: 1, tables: [decks, cards, reviews] })
```

The column vocabulary is `z.string()`, `z.number()`, `z.boolean()`,
each optionally `.nullable()`. Refinements like `.min(0).max(3)` don't
change the column type. Local writes are not validated; validation
happens at the trust boundary, the sync wire, in section 10. Indexes are
a database concept Zod has no word for, so they ride in the options bag:
`deck_id` and `due_at` back the queries this app runs constantly.
`created_at`/`updated_at` are auto-stamped on create and update because
they are declared.

(No Zod in your stack? `zodTable` produces ordinary table definitions;
writing them by hand with the `table()`/`column` builders is the same
thing and documented in the [schema reference](reference/schema.md).)

## 3. Define the models

Models give records typed accessors and association helpers. Each class
extends `ModelFor(tableObject)`, which binds it to its table and (in
TypeScript) types every field from the table definition. Accessors are
generated from the schema when the class is bound, so the class body
only declares associations.

```js
import { ModelFor } from '@remelondb/core'

class Deck extends ModelFor(decks) {
  static associations = {
    cards: { type: 'has_many', foreignKey: 'deck_id' },
  }
}

class Card extends ModelFor(cards) {
  static associations = {
    decks: { type: 'belongs_to', key: 'deck_id' },
    reviews: { type: 'has_many', foreignKey: 'card_id' },
  }
}

class Review extends ModelFor(reviews) {
  static associations = {
    cards: { type: 'belongs_to', key: 'card_id' },
  }
}
```

## 4. Open the database

Apps open the database through a manager instead of calling
`Database.open` directly. The manager makes sure there is only ever
one open in flight, lets a failed open be retried, and on the web
reacts when another tab takes the database over. Section 11 goes into
the details; for now it is one extra line:

```js
import { createDatabaseManager, Database } from '@remelondb/core'
import { NodeSqliteDriver } from '@remelondb/driver-node'

const manager = createDatabaseManager({
  open: () =>
    Database.open({
      driver: new NodeSqliteDriver(),
      schema,
      modelClasses: [Deck, Card, Review],
      name: 'flashcards.db',   // ':memory:' for experiments
    }),
})
const db = await manager.init()
```

On first open the schema DDL runs; on later opens with a higher schema
version, migrations run (section 9).

## 5. Create a deck and its cards

All mutations happen inside `db.write()`. Single creates are one call;
for seeding many rows, prepare the operations and commit them as one
atomic batch:

```js
const deck = await db.write(() =>
  db.get(Deck).create({ title: 'Spanish basics' }),
)

const FRONTS = [
  ['hola', 'hello'], ['adiós', 'goodbye'], ['gracias', 'thank you'],
  ['por favor', 'please'], ['lo siento', 'sorry'],
]
await db.write(async () => {
  const ops = FRONTS.map(([front, back]) =>
    db.get(Card).prepareCreate({
      deck_id: deck.id, front, back, due_at: Date.now(),
    }),
  )
  await db.batch(ops)   // one transaction; all or nothing
})
```

`db.write()` itself is a serialized writer window, not a transaction:
each `create`/`update`/delete inside it commits individually, and a
failure mid-block does not undo earlier commits. When several records
must live or die together, prepare the operations and commit them as
one batch. Deletes have prepared builders too, so a cascade is one
transaction:

```js fragment
await db.write(async () => {
  const cards = await db.get(Card).query(Q.where('deck_id', deck.id)).fetch()
  await db.batch([
    ...cards.map((card) => card.prepareMarkAsDeleted()),
    deck.prepareMarkAsDeleted(),
  ])   // parent and children vanish together, or not at all
})
```

Ids are client-generated (16 characters, sync-safe), so records never
wait for a server to exist.

Writes can fail: the database was closed under you (logout, a tab
takeover), the disk refused, a query inside the block threw. `write()`
rejects with that error, and for a batch the in-memory state is left
untouched, so the failure is clean rather than half-applied. Handle it
where the user is waiting:

```js fragment
try {
  await db.write(() => db.get(Deck).create({ title }))
  closeDialog()          // only once the write is durable
} catch (error) {
  showError(error)       // the deck was not created; say so
}
```

Dismissing the dialog before the write resolves is the tempting
shortcut, and it reports a success the database never agreed to.

## 6. The study queue

Queries are built from `Q` conditions on a collection. The study queue
is "cards of this deck that are due, oldest first":

```js
import { Q } from '@remelondb/core'

const dueCards = await db.get(Card).query(
  Q.where('deck_id', deck.id),
  Q.where('due_at', Q.lte(Date.now())),
  Q.sortBy('due_at'),
  Q.take(20),
).fetch()
```

The full operator set (comparisons, `oneOf`, `like`, boolean nesting)
is in the [queries reference](reference/queries.md). Semantics are
SQLite's on every platform; there is no second engine to disagree with.

## 7. Live counts for the UI

Observation keeps UI in step with the database without re-querying by
hand. A due-count badge:

```js
const unsubscribe = db.get(Card).query(
  Q.where('due_at', Q.lte(Date.now())),
).observeCount((n) => setBadge(n))
```

One caveat before wiring a badge to this: `Date.now()` is captured
when the query is built. Observation re-runs when *records change*,
not when the clock advances, so a card quietly becoming due does not
fire the callback. Either rebuild the observation on a timer:

```js fragment
let stop = observeDue()
const timer = setInterval(() => {
  stop()
  stop = observeDue()   // fresh Date.now() cutoff
}, 60_000)
function observeDue() {
  return db.get(Card).query(
    Q.where('due_at', Q.lte(Date.now())),
  ).observeCount((n) => setBadge(n))
}
```

or observe a bounded card set once and derive dueness locally. This still
needs a timer. In React, store the current time in state and capture it in a
`select` callback; each tick recomputes the selection without restarting the
query observation. The [react reference](reference/react.md) shows when each
shape fits.

The callback fires immediately with the current count and again
whenever the count changes. `query(...).observe(cb)` does the same for
the full result list, re-emitting when membership, order, or the
content of listed records changes — an edit arriving via sync repaints
a sorted list like a local one does. Call the returned function to
unsubscribe. In React, don't wire this by hand: the bindings in
[reference/react.md](reference/react.md) wrap observation into
`useQuery`/`useQueryCount` with subscription sharing and no dependency
arrays, and wrap writes into `useMutation` (pending and error state
instead of a bare promise to babysit).

## 8. Record a review

Studying a card produces two writes: an appended review, and a new due
date on the card. Prepare both operations and commit them in one batch so
neither can succeed without the other:

```js
const card = dueCards[0]
const DAY = 24 * 60 * 60 * 1000
const now = Date.now()

await db.write(() =>
  db.batch([
    db.get(Review).prepareCreate({
      card_id: card.id, rating: 3, reviewed_at: now,
    }),
    card.prepareUpdate(() => { card.due_at = now + DAY }),
  ]),
)
```

After this commits, the observer from section 7 fires with the new
count. Progress (due dates, streaks, statistics) is derived from the
review rows; the reviews table is the source of truth and the card's
`due_at` is a scheduler output.

Associations from section 3 come with helpers:

```js
const cardsInDeck = await deck.children('cards').fetch()
const parent = await card.related('decks')          // the Deck, or null
const deckReviews = await db.get(Review).query(
  Q.on('cards', 'deck_id', deck.id),                // join through cards
).fetch()
```

## 9. Grow the schema

Suppose version 2 adds a free-text `notes` column to cards. Add
`notes: z.string().nullable()` to `CardRow`, bump the schema version,
and describe the step in a migration so existing installs upgrade in
place. Migration steps state column deltas directly, so they use the
column builders:

```js
import { schemaMigrations, addColumns, column as c } from '@remelondb/core'

const migrations = schemaMigrations({
  migrations: [
    {
      toVersion: 2,
      steps: [
        addColumns({
          table: 'cards',
          columns: { notes: c.string().optional() },
        }),
      ],
    },
  ],
})
```

Then pass the migrations when opening (sketch — fill in your own
driver and name):

```js fragment
const db = await Database.open({ driver, schema, migrations, ... })
```

A database that cannot reach the current version through migration
steps fails `open` loudly; data destruction is never implicit.

## 10. Sync

Sync has two halves. The backend half is `@remelondb/server`: the wire
protocol implemented once, above a small storage seam. Configure it
with the tables to sync and get per-user pull/push handlers back:

```js
import { createMemoryStore, createSyncEngine } from '@remelondb/server'
import { syncSchemas } from '@remelondb/core/zod'

const wire = syncSchemas({ decks: DeckRow, cards: CardRow, reviews: ReviewRow })

const engine = createSyncEngine({
  store: createMemoryStore(),   // or your database adapter
  tables: {
    decks: { validate: (row) => wire.rows.decks.safeParse(row).success },
    cards: { validate: (row) => wire.rows.cards.safeParse(row).success },
    reviews: {
      validate: (row) => wire.rows.reviews.safeParse(row).success,
      appendOnly: true,
    },
  },
})
const handlers = engine.as('user-1')   // { pull(args), push(args) }
```

`syncSchemas` turns the section-2 Zod objects into wire validators:
strict row schemas (user columns plus `id`, nothing smuggled), and
envelope schemas for every message. Here the server side uses the row
schemas to vet incoming rows — a row failing them is rejected by id
and stays dirty on the client, per the protocol. `appendOnly` turns
section 2's "reviews are append-only facts" into an enforced contract:
a push that rewrites an existing review is rejected by id instead of
accepted.

The frontend half is `synchronize()` from core. It needs two functions
that reach those handlers; the engine handles the rest (cursor
storage, applying remote changes, conflict merges, marking local
records as synced). Here the handlers are in-process, so the wiring is
direct — this block really runs in CI, pushing the flashcards from
section 5 into the memory store:

```js
import { synchronize, hasUnsyncedChanges } from '@remelondb/core'

const result = await synchronize({
  database: db,
  pullChanges: (args) => handlers.pull(args),
  pushChanges: (args) => handlers.push(args),
})
// result says what happened — { lease, resynced, pulled, pushed,
// rejected, rejectedRecords, retryCount } — so UI state ("recovered
// from a server reset", "2 changes rejected") comes from data, not
// log parsing. rejectedRecords names the refused ids per table:
// rejected rows stay dirty and retry forever, so anything above 0
// deserves an attention state, not a "synced" label.

const clean = !(await hasUnsyncedChanges(db))   // true: everything pushed
```

In production the handlers sit behind two routes — every protocol
outcome is a returned value, so a route handler is one line,
`res.json(await handlers.push(req.body))` — and the client reaches
them through `@remelondb/core/transport`. You supply one `post`
function (the URL and the authentication are yours; here the browser's
cookie jar carries the session); the transport classifies failures and
validates every response with the same wire schemas the server uses:

```js fragment
import { createSyncTransport, readSyncResponse } from '@remelondb/core/transport'

const post = (path, body, signal) =>
  readSyncResponse(path, () =>
    fetch(`/sync/${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    }),
  )

const { pullChanges, pushChanges } = createSyncTransport({
  post,
  validatePullResult: (raw) => wire.pullResult.parse(raw),
  validatePushResult: (raw) => wire.pushResult.parse(raw),
})

await synchronize({ database: db, pullChanges, pushChanges })
```

A response the engine cannot act on — a 401, a 5xx, no network, a body
that is not valid JSON or fails the wire schema — throws
`SyncTransportError` and the run fails with local dirty state
untouched. Protocol outcomes (`conflict`, `resyncRequired`, rejections)
pass through as data; that split is what keeps a broken network from
ever looking like a successful sync. `synchronize` still accepts any
two functions if your transport is not HTTP; the raw seam is in the
[sync reference](reference/sync.md).

Changesets are per-table `created`/`updated`/`deleted` groups; the
cursor is an opaque string the server defines. The memory store is
real enough to develop against; for a persistent backend you implement
the `SyncStore` seam and prove it with the
[`@remelondb/server/conformance`](../packages/server) suite.
What the server must guarantee, and why, is specified in
[sync-design.md](sync-design.md); the client-side details are in the
[sync reference](reference/sync.md).

## 11. Use it in an app

Section 4 opened through the manager without saying why. An app has
more lives than a script: a first open, a failed open the user
retries, on the web a takeover by another tab. The manager owns that
lifecycle — concurrent `init()` calls share one open, a failure stays
retryable, and a superseded attempt can never clobber a newer
database:

```js
const scratch = createDatabaseManager({
  open: () =>
    Database.open({
      driver: new NodeSqliteDriver(),
      schema,
      modelClasses: [Deck, Card, Review],
      name: ':memory:',
    }),
})

console.log(scratch.state.status)   // 'idle'
const db2 = await scratch.init()
console.log(scratch.state.status)   // 'ready'
console.log(db2 === scratch.database) // true
```

In React (web or native), drive the UI from the manager's state with
the hook from `@remelondb/core/react`, and on the web pass
`shared: true` so every tab lives on one database:

```js fragment
const manager = createDatabaseManager({
  open: (onTakenOver) =>
    Database.open({
      driver: new WebSqliteDriver({ shared: true, takeover: true, onTakenOver }),
      schema, migrations, modelClasses, name: 'app.db',
    }),
})

function Root() {
  const { status, error } = useDatabaseState(manager)
  if (status === 'ready') return <App db={manager.database} />
  if (status === 'error') return <Retry error={error} onRetry={() => manager.init()} />
  return <Splash />
}
```

The todo-sync example runs this bootstrap on web and native alike
(`frontend/src/db.ts`, `mobile/src/db.ts`).

### Keeping it synced

Section 10 called `synchronize()` by hand. An app wants that call made
at the right moments — after a local write, on regaining network, in
the background — without ever running twice at once, and it wants a
status to show. `createSyncController` owns the *when* the way the
manager owns open/close. This block runs in CI against the section-10
handlers:

```js
import { createRunSync, createSyncController } from '@remelondb/core'

const controller = createSyncController({
  runSync: createRunSync({
    database: db,
    pullChanges: (args) => handlers.pull(args),
    pushChanges: (args) => handlers.push(args),
  }),
  intervalMs: null,   // no background clock in this script
})

const firstRun = new Promise((resolve) =>
  controller.subscribe((state) => {
    if (state.lastSyncAt !== null) resolve(state)
  }),
)
controller.start()
const state = await firstRun
console.log(state.status)                  // 'idle'
console.log(state.lastResult.rejected)     // 0
controller.dispose()
```

In an app you keep the defaults instead: a 60-second interval, a
2-second debounce behind `notifyLocalWrite()` (call it from your write
paths; ten quick edits become one sync), and a `triggers` option that
subscribes platform wake-ups — `online`/`visibilitychange` on the web,
network-restored and app-foregrounded on native. A "sync now" button is
`controller.syncNow()`, which also re-arms automatic syncing after an
auth failure. Status for the UI comes from `subscribe`
(`idle`/`syncing`/`offline`/`error`/`resync-required`, plus
`lastResult` with the rejection fields from section 10). And the
shutdown order is fixed: `controller.dispose()` aborts an in-flight
run, *then* the database closes — on logout or account switch, always
dispose first. Details: [sync reference](reference/sync.md).

### Multiple accounts on one device

When different users share a browser, one fixed database name means
one account can open another's local data. The pattern: derive the
database name from the authenticated user id (encode it — never
interpolate raw ids into filenames), create the manager only once a
user is known, and call `manager.close()` on logout or account change.

In React, `useSessionDatabase` from `@remelondb/core/react` does all of
this — see [the session hook](reference/react.md#the-session-hook). Read
the rest of this section anyway if you own a manager yourself: the rules
are what the hook implements, and they are the same rules whatever calls
them.
`close()` tears the database down and returns the manager to `idle`,
and an open still in flight when it is called gets discarded on
arrival — closed immediately, its `init()` rejecting — so a slow open
can never resurrect a database after logout. `close()` waits for that
cleanup, so awaiting it means the file is released and the next
account can open its own:

```js fragment
// One owner (only onLogin/onLogout touch this) and one transition at
// a time: never let two of them run concurrently.
let manager = null

async function onLogin(userId) {
  await onLogout()   // an account switch closes the old database first
  const name = `user_${hex(userId)}.db`
  manager = createDatabaseManager({
    open: (onTakenOver) =>
      Database.open({
        driver: new WebSqliteDriver({ shared: true, takeover: true, onTakenOver }),
        schema, migrations, modelClasses, name,
      }),
  })
  return manager.init()
}

async function onLogout() {
  const closing = manager
  await closing?.close()
  if (manager === closing) {
    manager = null   // a login during the await owns the variable now
  }
}
```

That first comment is load-bearing, and it asks for two things. The
first is that account transitions run one at a time. A switch that
logs straight in as another user is the case to watch: assigning a
new manager over the old one leaves that database open with nothing
pointing at it, held for the rest of the session. `onLogin` handles
the sequential form by closing first, which is why it awaits
`onLogout`. This fragment does not serialize callers; the application
must do that. Two transitions running concurrently would each be
closing and assigning under the other, and a mutex or a promise queue
around the pair is what prevents it.

The second is that no other code path touches the variable. Add one,
say a route guard reading the profile or a layout component, and "the
current manager" and "the manager I created" stop being the same
object. Now `onLogout`'s `close()` can tear down a database another
caller is still using. The failure is quiet. `close()` returns the
manager to `idle`, not to an error state, so a component still
rendering that manager sees no error and no data. The screen is blank
and nothing calls `init()` again.

The comparison in `onLogout` is the backstop for when that discipline
slips. A login that begins while the logout waits on `close()`
installs a new manager, and a bare `manager = null` afterwards would
discard it. Clearing a shared reference only while it still points at
what you closed costs one line and settles the question.

If more than one code path needs the database, the rules get
stricter. One path owns the variable and is the only one that writes
it. Every other caller borrows: it uses the active manager for the
same database and never closes it, and it creates a private manager
only when no suitable one is active, closing exactly the instance it
created. Borrowing is not politeness. Where `SharedWorker` is
unavailable the driver falls back to single-owner semantics, so a
second open of a database that is already open fails rather than
sharing. The same fallback constrains a private manager for a
different database, because the SAH pool has one owner per origin
rather than one per file: an open manager for the outgoing account
can block a private manager for the incoming one. Close the outgoing
account's manager before opening it. One thing not to borrow is a
manager whose owner has already closed it. That manager is back at
`idle`, which reads exactly like unstarted, so calling `init()` on it
reopens a database nobody is left to close. A keyed, reference-counted registry that would move
these rules out of caller discipline and into the library is under
discussion ([#32](https://github.com/dustyway/remelonDB/issues/32)).

## Where next

- [The example app](../examples/todo-sync/README.md): everything above
  running in a browser — two tabs mirroring one shared database, a
  private window syncing through a ~50-line server, offline writes
  catching up on reconnect, and a 12-line React bridge.
- [Multi-tab](multi-tab.md): how shared mode works — the broker, write
  arbitration, change broadcast — and the model-checked ordering
  invariant behind it.
- [Queries](reference/queries.md), [models](reference/models.md),
  [database & observation](reference/database.md): the day-to-day API.
- [Schema & migrations](reference/schema.md),
  [records](reference/records.md): data shape and lifecycle.
- [`@remelondb/core/zod`](zod-adapter.md): the design record for the adapter
  used throughout — what it accepts, what it rejects and why, and the
  interop guarantees behind `zodTable` and `syncSchemas`.
- [Sync design](sync-design.md): the protocol's rationale. The backend
  ships as [`@remelondb/server`](../packages/server); read this before
  backing it with your own `SyncStore` adapter.
