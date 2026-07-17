// Executable check for docs/tutorial.md: runs the tutorial's code
// sections verbatim against the built workspace packages, so the
// tutorial cannot drift from the real API. Sections 2-8 and the §9
// migrations object execute with assertions; the §9 re-open fragment
// (literal `...`) and §10's network sync are illustrative and are
// checked for imports/shape only.
//
// Run: pnpm build && node scripts/check-tutorial.mjs
// Deviations from the tutorial text: import specifiers point at the
// built packages, a setBadge shim replaces the app's badge API, and the
// database file lands in a temp directory.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appSchema, column as c, table, ModelFor, Database, Q,
  schemaMigrations, addColumns, synchronize,
} from '../packages/core/dist/index.mjs'
import { NodeSqliteDriver } from '../packages/driver-node/dist/index.mjs'

const workDir = await mkdtemp(join(tmpdir(), 'remelondb-tutorial-'))
process.chdir(workDir)

const badge = []
const setBadge = (n) => badge.push(n)

// §2 Define the schema
const decks = table('decks', {
  title: c.string(),
  created_at: c.number(),
  updated_at: c.number(),
})
const cards = table('cards', {
  deck_id: c.string().indexed(),
  front: c.string(),
  back: c.string(),
  due_at: c.number().indexed(),
  created_at: c.number(),
  updated_at: c.number(),
})
const reviews = table('reviews', {
  card_id: c.string().indexed(),
  rating: c.number(),
  reviewed_at: c.number(),
})
const schema = appSchema({ version: 1, tables: [decks, cards, reviews] })

// §3 Define the models
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

// §4 Open the database
const db = await Database.open({
  driver: new NodeSqliteDriver(),
  schema,
  modelClasses: [Deck, Card, Review],
  name: 'flashcards.db',   // ':memory:' for experiments
})

// §5 Create a deck and its cards
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

// §6 The study queue
const dueCards = await db.get(Card).query(
  Q.where('deck_id', deck.id),
  Q.where('due_at', Q.lte(Date.now())),
  Q.sortBy('due_at'),
  Q.take(20),
).fetch()

// §7 Live counts for the UI
const unsubscribe = db.get(Card).query(
  Q.where('due_at', Q.lte(Date.now())),
).observeCount((n) => setBadge(n))

// §8 Record a review
const card = dueCards[0]
const DAY = 24 * 60 * 60 * 1000
await db.write(async () => {
  await db.get(Review).create({
    card_id: card.id, rating: 3, reviewed_at: Date.now(),
  })
  await card.update(() => { card.due_at = Date.now() + DAY })
})
const cardsInDeck = await deck.children('cards').fetch()
const parent = await card.related('decks')          // the Deck, or null
const deckReviews = await db.get(Review).query(
  Q.on('cards', 'deck_id', deck.id),                // join through cards
).fetch()

// §9 Grow the schema (the migrations object only; see header)
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

// §10 Sync: network snippet is not runnable here; the import must exist
if (typeof synchronize !== 'function') throw new Error('synchronize missing')

// --- assertions ---
const assert = (cond, msg) => { if (!cond) throw new Error(`FAIL: ${msg}`) }
assert(dueCards.length === 5, `dueCards: ${dueCards.length}`)
assert(cardsInDeck.length === 5, `children: ${cardsInDeck.length}`)
assert(parent && parent.id === deck.id, 'related returned wrong deck')
assert(deckReviews.length === 1, `join query: ${deckReviews.length}`)
assert(card.due_at > Date.now(), 'update builder did not set due_at')
await new Promise((r) => setTimeout(r, 30))
assert(badge.length >= 1, 'observeCount never fired')
assert(badge[badge.length - 1] === 4, `badge should end at 4: ${badge}`)
assert(migrations.maxVersion === 2, 'migrations object wrong')
unsubscribe()
await rm(workDir, { recursive: true, force: true })
console.log('TUTORIAL CHECK: PASS', { dueCards: dueCards.length, badge })
