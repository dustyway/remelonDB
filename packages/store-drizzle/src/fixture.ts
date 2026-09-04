import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { bigint, boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { DrizzleDb } from './store';

// Shared by the pglite test suites: the four machinery columns plus two
// user columns. Not published (see package.json files).
export const tasks = pgTable('tasks', {
  id: text('id').primaryKey(),
  rev: bigint('rev', { mode: 'number' }).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  owner: text('owner').notNull(),
  name: text('name').notNull(),
  done: boolean('done').notNull(),
});

// A third table with a database-enforced unique column: constraint
// violations must surface as per-record rejections, never thrown.
export const profiles = pgTable('profiles', {
  id: text('id').primaryKey(),
  rev: bigint('rev', { mode: 'number' }).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  owner: text('owner').notNull(),
  handle: text('handle').unique(),
});

// A second table used only by conformance case 13 (appendOnly).
export const events = pgTable('events', {
  id: text('id').primaryKey(),
  rev: bigint('rev', { mode: 'number' }).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  owner: text('owner').notNull(),
  note: text('note').notNull(),
});

export const freshDb = async (): Promise<{ client: PGlite; db: DrizzleDb }> => {
  const client = new PGlite();
  await client.exec(`
    create sequence remelon_rev;
    create table remelon_sync_meta (key text primary key, value bigint not null);
    create table tasks (
      id text primary key,
      rev bigint not null,
      deleted_at timestamptz,
      owner text not null,
      name text not null,
      done boolean not null
    );
    create table events (
      id text primary key,
      rev bigint not null,
      deleted_at timestamptz,
      owner text not null,
      note text not null
    );
    create table profiles (
      id text primary key,
      rev bigint not null,
      deleted_at timestamptz,
      owner text not null,
      handle text unique
    );
  `);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- pglite's drizzle instance carries its own query-result HKT; DrizzleDb is the erased form the store accepts.
  return { client, db: drizzle(client) as unknown as DrizzleDb };
};
