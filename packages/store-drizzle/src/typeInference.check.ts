/**
 * Compile-time-only checks for #12: a normal typed Drizzle schema must
 * configure the adapter without `as unknown as` casts, and the
 * `drizzleSyncTable` helper must reject bad mappings at compile time.
 * This file is never imported at runtime; `tsc --noEmit` is its test
 * runner. Runtime behavior is covered by store.test.ts.
 */
import { bigint, pgTable, text, timestamp, integer } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createDrizzleStore, drizzleSyncTable } from './store';

const decks = pgTable('user_decks', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  createdAt: timestamp('created_at').notNull(),
  rev: bigint('rev', { mode: 'number' }).notNull(),
  deletedAt: timestamp('deleted_at'),
  position: integer('position'),
});

const schema = { decks };
declare const db: ReturnType<typeof drizzle<typeof schema>>;

// a fully typed database and typed columns, no casts anywhere
export const store = createDrizzleStore<string>({
  db,
  tables: {
    user_decks: {
      table: decks,
      id: decks.id,
      rev: decks.rev,
      deletedAt: decks.deletedAt,
      scope: decks.userId,
      insertOnly: ['created_at'],
      scrub: { title: '', description: null },
    },
  },
});

// the helper validates the mapping against the concrete table
export const checked = drizzleSyncTable<string, typeof decks>({
  table: decks,
  id: decks.id,
  rev: decks.rev,
  deletedAt: decks.deletedAt,
  scope: decks.userId,
  insertOnly: ['created_at'],
  scrub: { title: '', description: null },
});

export const badScrubKey = drizzleSyncTable<string, typeof decks>({
  table: decks,
  id: decks.id,
  rev: decks.rev,
  deletedAt: decks.deletedAt,
  scope: decks.userId,
  // @ts-expect-error 'headline' is not a column of user_decks
  scrub: { headline: '' },
});

export const badScrubValue = drizzleSyncTable<string, typeof decks>({
  table: decks,
  id: decks.id,
  rev: decks.rev,
  deletedAt: decks.deletedAt,
  scope: decks.userId,
  // @ts-expect-error title is a string column; a number cannot scrub it
  scrub: { title: 7 },
});

export const badInsertOnly = drizzleSyncTable<string, typeof decks>({
  table: decks,
  id: decks.id,
  rev: decks.rev,
  deletedAt: decks.deletedAt,
  scope: decks.userId,
  // @ts-expect-error 'made_up_column' is not a column name of user_decks
  insertOnly: ['made_up_column'],
});
