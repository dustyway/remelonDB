import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  bigint,
  boolean,
  doublePrecision,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { createMemoryStore } from '@remelondb/server';
import type { SyncStore } from '@remelondb/server';
import { createDrizzleStore } from '@remelondb/store-drizzle';
import type { DrizzleDb } from '@remelondb/store-drizzle';

// The store behind the example server: in-memory by default (state
// lives and dies with the process), Postgres when DATABASE_URL is set.
// The table is the Todo Zod object's keys as columns — names matching
// the wire, so no mappers — plus the four machinery columns the drizzle
// store requires (id, rev, deleted_at, owner).
export const todos = pgTable('todos', {
  id: text('id').primaryKey(),
  rev: bigint('rev', { mode: 'number' }).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  owner: text('owner').notNull(),
  text: text('text').notNull(),
  done: boolean('done').notNull(),
  createdAt: doublePrecision('created_at').notNull(),
});

const bootstrap = async (db: DrizzleDb): Promise<void> => {
  const statements = [
    `create sequence if not exists remelon_rev`,
    `create table if not exists remelon_sync_meta (key text primary key, value bigint not null)`,
    `create table if not exists todos (
       id text primary key,
       rev bigint not null,
       deleted_at timestamptz,
       owner text not null,
       text text not null,
       done boolean not null,
       created_at double precision not null
     )`,
    `create index if not exists todos_owner_rev_idx on todos (owner, rev)`,
  ];
  for (const statement of statements) {
    await db.execute(statement);
  }
};

export const createStore = async (): Promise<SyncStore<string>> => {
  const url = process.env['DATABASE_URL'];
  if (!url) return createMemoryStore();
  const db = drizzle(
    new Pool({ connectionString: url }),
  ) as unknown as DrizzleDb;
  await bootstrap(db);
  return createDrizzleStore<string>({
    db,
    tables: {
      todos: {
        table: todos,
        id: todos.id,
        rev: todos.rev,
        deletedAt: todos.deletedAt,
        scope: todos.owner,
      },
    },
  });
};
