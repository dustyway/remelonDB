# Tutorial: a flashcard app on remelonDB

This walkthrough builds the data layer of a small flashcard app: decks
containing cards, reviews recorded as you study, a due-cards study
queue, a live counter for the UI, a schema migration, and a sync hookup
at the end. Every snippet below is taken from a script that runs
against the packed packages; you can paste the pieces into a Node
project and follow along.

The examples use `NodeSqliteDriver` so they run anywhere. In an app you
swap only the driver import: `RnSqliteDriver` from
`@remelondb/driver-rn` on React Native, `WebSqliteDriver` from
`@remelondb/driver-web` in the browser. Everything else is identical on
all platforms, which is the point of the driver seam.

## 1. Install

See ["Using it in an app"](../README.md#using-it-in-an-app) in the root
README: install the tarballs for `@remelondb/core` and one driver, with
one `overrides` entry.

## 2. Define the schema

Three tables. Cards carry a `due_at` timestamp that the scheduler
updates after each review; reviews are append-only facts about what
happened.

```js
import { appSchema, tableSchema } from '@remelondb/core'

const schema = appSchema({
  version: 1,
  tables: [
    tableSchema({
      name: 'decks',
      columns: [
        { name: 'title', type: 'string' },
        { name: 'created_at', type: 'number' },
        { name: 'updated_at', type: 'number' },
      ],
    }),
    tableSchema({
      name: 'cards',
      columns: [
        { name: 'deck_id', type: 'string', isIndexed: true },
        { name: 'front', type: 'string' },
        { name: 'back', type: 'string' },
        { name: 'due_at', type: 'number', isIndexed: true },
        { name: 'created_at', type: 'number' },
        { name: 'updated_at', type: 'number' },
      ],
    }),
    tableSchema({
      name: 'reviews',
      columns: [
        { name: 'card_id', type: 'string', isIndexed: true },
        { name: 'rating', type: 'number' },
        { name: 'reviewed_at', type: 'number' },
      ],
    }),
  ],
})
```

`created_at`/`updated_at` are auto-stamped on create and update because
they are declared. `isIndexed` on `deck_id` and `due_at` backs the
queries this app runs constantly. Details: [schema
reference](reference/schema.md).

## 3. Define the models

Models give records typed accessors and association helpers. Accessors
are generated from the schema when the class is bound, so the class
body only declares associations (and, in TypeScript, `declare` fields).

```js
import { Model } from '@remelondb/core'

class Deck extends Model {
  static table = 'decks'
  static associations = {
    cards: { type: 'has_many', foreignKey: 'deck_id' },
  }
}

class Card extends Model {
  static table = 'cards'
  static associations = {
    decks: { type: 'belongs_to', key: 'deck_id' },
    reviews: { type: 'has_many', foreignKey: 'card_id' },
  }
}

class Review extends Model {
  static table = 'reviews'
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
  db.get('decks').create({ title: 'Spanish basics' }),
)

const FRONTS = [
  ['hola', 'hello'], ['adiós', 'goodbye'], ['gracias', 'thank you'],
  ['por favor', 'please'], ['lo siento', 'sorry'],
]
await db.write(async () => {
  const ops = FRONTS.map(([front, back]) =>
    db.get('cards').prepareCreate({
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

const dueCards = await db.get('cards').query(
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
const unsubscribe = db.get('cards').query(
  Q.where('due_at', Q.lte(Date.now())),
).observeCount((n) => setBadge(n))
```

The callback fires immediately with the current count and again
whenever the count changes. `query(...).observe(cb)` does the same for
the full result list. Call the returned function to unsubscribe.

## 8. Record a review

Studying a card produces two writes: an appended review, and a new due
date on the card. Model updates use a builder:

```js
const card = dueCards[0]
const DAY = 24 * 60 * 60 * 1000

await db.write(async () => {
  await db.get('reviews').create({
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
const deckReviews = await db.get('reviews').query(
  Q.on('cards', 'deck_id', deck.id),                // join through cards
).fetch()
```

## 9. Grow the schema

Suppose version 2 adds a free-text `notes` column to cards. Bump the
schema version, add the column to the table schema, and describe the
step in a migration so existing installs upgrade in place:

```js
import { schemaMigrations, addColumns } from '@remelondb/core'

const migrations = schemaMigrations({
  migrations: [
    {
      toVersion: 2,
      steps: [
        addColumns({
          table: 'cards',
          columns: [{ name: 'notes', type: 'string', isOptional: true }],
        }),
      ],
    },
  ],
})

const db = await Database.open({ driver, schema, migrations, ... })
```

A database that cannot reach the current version through migration
steps fails `open` loudly; data destruction is never implicit.

## 10. Sync

`synchronize()` needs two functions that talk to your backend; the
engine handles the rest (cursor storage, applying remote changes,
marking local ones as synced):

```js
import { synchronize } from '@remelondb/core'

await synchronize({
  database: db,
  pullChanges: async ({ cursor }) => {
    const res = await fetch('/sync/pull', {
      method: 'POST', body: JSON.stringify({ cursor }),
    })
    return res.json()   // { changes, cursor }
  },
  pushChanges: async ({ changes, cursor }) => {
    const res = await fetch('/sync/push', {
      method: 'POST', body: JSON.stringify({ changes, cursor }),
    })
    return res.json()   // { cursor, changes }
  },
})
```

Changesets are per-table `created`/`updated`/`deleted` groups; the
cursor is an opaque string your server defines. What the server must
guarantee, and why, is specified in [sync-design.md](sync-design.md);
the client-side details are in the [sync
reference](reference/sync.md).

## Where next

- [Queries](reference/queries.md), [models](reference/models.md),
  [database & observation](reference/database.md): the day-to-day API.
- [Schema & migrations](reference/schema.md),
  [records](reference/records.md): data shape and lifecycle.
- [Sync design](sync-design.md): read before implementing a backend.
