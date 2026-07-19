# Tutorial: a flashcard app on remelonDB

This walkthrough builds the data layer of a small flashcard app: decks
containing cards, reviews recorded as you study, a due-cards study
queue, a live counter for the UI, a schema migration, and a sync hookup
at the end. CI executes the code blocks below straight out of this
file: [scripts/check-tutorial.mjs](../scripts/check-tutorial.mjs)
extracts them and runs them against the built packages on every push,
so what you read here is code that provably runs. That includes the
sync hookup, which runs against the real backend engine in-process.
(Blocks marked as fragments — the migration re-open sketch and the
HTTP route wiring in section 10 — are illustrative and skipped.) You
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
pnpm add @remelondb/core @remelondb/driver-node @remelondb/zod zod
```

`@remelondb/zod` is the schema front end this tutorial uses: one Zod
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

Apps that never sync need only the first line. One more package
exists for later: `@remelondb/server-conformance` proves a custom
backend store against the protocol contract.

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
import { zodTable } from '@remelondb/zod'

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
change the column type — local writes are not validated (that happens
at the trust boundary, the sync wire, in section 10). Indexes are a
database concept Zod has no word for, so they ride in the options bag:
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

```js
import { Database } from '@remelondb/core'
import { NodeSqliteDriver } from '@remelondb/driver-node'

const db = await Database.open({
  driver: new NodeSqliteDriver(),
  schema,
  modelClasses: [Deck, Card, Review],
  name: 'flashcards.db',   // ':memory:' for experiments
})
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

Ids are client-generated (16 characters, sync-safe), so records never
wait for a server to exist.

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

The callback fires immediately with the current count and again
whenever the count changes. `query(...).observe(cb)` does the same for
the full result list, re-emitting when membership, order, or the
content of listed records changes — an edit arriving via sync repaints
a sorted list like a local one does. Call the returned function to
unsubscribe.

## 8. Record a review

Studying a card produces two writes: an appended review, and a new due
date on the card. Model updates use a builder:

```js
const card = dueCards[0]
const DAY = 24 * 60 * 60 * 1000

await db.write(async () => {
  await db.get(Review).create({
    card_id: card.id, rating: 3, reviewed_at: Date.now(),
  })
  await card.update(() => { card.due_at = Date.now() + DAY })
})
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
import { syncSchemas } from '@remelondb/zod'

const wire = syncSchemas({ decks: DeckRow, cards: CardRow, reviews: ReviewRow })

const engine = createSyncEngine({
  store: createMemoryStore(),   // or your database adapter
  tables: {
    decks: { validate: (row) => wire.rows.decks.safeParse(row).success },
    cards: { validate: (row) => wire.rows.cards.safeParse(row).success },
    reviews: { validate: (row) => wire.rows.reviews.safeParse(row).success },
  },
})
const handlers = engine.as('user-1')   // { pull(args), push(args) }
```

`syncSchemas` turns the section-2 Zod objects into wire validators:
strict row schemas (user columns plus `id`, nothing smuggled), and
envelope schemas for every message. Here the server side uses the row
schemas to vet incoming rows — a row failing them is rejected by id
and stays dirty on the client, per the protocol.

The frontend half is `synchronize()` from core. It needs two functions
that reach those handlers; the engine handles the rest (cursor
storage, applying remote changes, conflict merges, marking local
records as synced). Here the handlers are in-process, so the wiring is
direct — this block really runs in CI, pushing the flashcards from
section 5 into the memory store:

```js
import { synchronize, hasUnsyncedChanges } from '@remelondb/core'

await synchronize({
  database: db,
  pullChanges: (args) => handlers.pull(args),
  pushChanges: (args) => handlers.push(args),
})

const clean = !(await hasUnsyncedChanges(db))   // true: everything pushed
```

In production the handlers sit behind two routes — every protocol
outcome is a returned value, so a route handler is one line,
`res.json(await handlers.push(req.body))` — and the client reaches
them over HTTP:

```js fragment
await synchronize({
  database: db,
  pullChanges: async (args) => {
    const res = await fetch('/sync/pull', {
      method: 'POST', body: JSON.stringify(args),
    })
    return wire.pullResult.parse(await res.json())
  },
  pushChanges: async (args) => {
    const res = await fetch('/sync/push', {
      method: 'POST', body: JSON.stringify(args),
    })
    return wire.pushResult.parse(await res.json())
  },
})
```

Changesets are per-table `created`/`updated`/`deleted` groups; the
cursor is an opaque string the server defines. The memory store is
real enough to develop against; for a persistent backend you implement
the `SyncStore` seam and prove it with
[`@remelondb/server-conformance`](../packages/server-conformance).
What the server must guarantee, and why, is specified in
[sync-design.md](sync-design.md); the client-side details are in the
[sync reference](reference/sync.md).

## Where next

- [The example app](../examples/todo-sync/README.md): everything above
  running in a browser — two windows syncing through a ~50-line server,
  offline writes catching up on reconnect, and a 12-line React bridge.
- [Queries](reference/queries.md), [models](reference/models.md),
  [database & observation](reference/database.md): the day-to-day API.
- [Schema & migrations](reference/schema.md),
  [records](reference/records.md): data shape and lifecycle.
- [`@remelondb/zod`](zod-adapter.md): the design record for the adapter
  used throughout — what it accepts, what it rejects and why, and the
  interop guarantees behind `zodTable` and `syncSchemas`.
- [Sync design](sync-design.md): the protocol's rationale. The backend
  ships as [`@remelondb/server`](../packages/server); read this before
  backing it with your own `SyncStore` adapter.
