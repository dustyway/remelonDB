import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/pglite';
import { PGlite } from '@electric-sql/pglite';
import { pgTable, text, bigint, timestamp } from 'drizzle-orm/pg-core';
import type { DrizzleDb } from './store';
import { createDrizzleStore } from './store';
import { freshDb, tasks } from './fixture';

// Store-contract discipline (thermonuclear findings): the engine's
// foreignIds check runs before upsert ever sees a row, so these
// invariants only show at the store level — which is exactly where a
// hook or a third-party engine would hit them.

describe('cross-scope upsert', () => {
  it('never modifies another scope of the same id', async () => {
    const { db } = await freshDb();
    const store = createDrizzleStore<string>({
      db,
      tables: {
        tasks: {
          table: tasks,
          id: tasks.id,
          rev: tasks.rev,
          deletedAt: tasks.deletedAt,
          scope: tasks.owner,
        },
      },
    });

    await store.transaction('victim', 'push', async (tx) => {
      await tx.upsert('tasks', 'victim', [
        { id: 'secret-1', name: 'private', done: false },
      ]);
    });
    await store.transaction('attacker', 'push', async (tx) => {
      await tx.upsert('tasks', 'attacker', [
        { id: 'secret-1', name: 'PWNED', done: true },
      ]);
    });

    const rows = await store.transaction('victim', 'pull', (tx) =>
      tx.changedSince('tasks', 'victim', 0),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.row).toMatchObject({ id: 'secret-1', name: 'private' });
  });
});

const parents = pgTable('parents', {
  id: text('id').primaryKey(),
  rev: bigint('rev', { mode: 'number' }).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  owner: text('owner').notNull(),
  name: text('name').notNull(),
});
const children = pgTable('children', {
  id: text('id').primaryKey(),
  rev: bigint('rev', { mode: 'number' }).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  owner: text('owner').notNull(),
  parentId: text('parent_id').notNull(),
});

const fkDb = async (): Promise<DrizzleDb> => {
  const client = new PGlite();
  await client.exec(`
    create sequence remelon_rev;
    create table remelon_sync_meta (key text primary key, value bigint not null);
    create table parents (
      id text primary key,
      rev bigint not null,
      deleted_at timestamptz,
      owner text not null,
      name text not null
    );
    create table children (
      id text primary key,
      rev bigint not null,
      deleted_at timestamptz,
      owner text not null,
      parent_id text not null references parents (id)
    );
  `);
  return drizzle(client);
};

const fkStore = (db: DrizzleDb) =>
  createDrizzleStore<string>({
    db,
    // parents FIRST in config order, so a naive single pass hits the FK
    tables: {
      parents: {
        table: parents,
        id: parents.id,
        rev: parents.rev,
        deletedAt: parents.deletedAt,
        scope: parents.owner,
      },
      children: {
        table: children,
        id: children.id,
        rev: children.rev,
        deletedAt: children.deletedAt,
        scope: children.owner,
      },
    },
  });

describe('gc under foreign keys', () => {
  it('prunes FK-linked tombstones across passes instead of wedging', async () => {
    const db = await fkDb();
    const store = fkStore(db);
    await store.transaction('u1', 'push', async (tx) => {
      await tx.upsert('parents', 'u1', [{ id: 'p1', name: 'parent' }]);
      await tx.upsert('children', 'u1', [{ id: 'c1', parent_id: 'p1' }]);
      await tx.tombstone('children', 'u1', ['c1']);
      await tx.tombstone('parents', 'u1', ['p1']);
    });

    await store.gc(1_000_000);

    const left = await store.transaction('u1', 'pull', async (tx) => ({
      parents: await tx.tombstonedIds('parents', 'u1', ['p1']),
      children: await tx.tombstonedIds('children', 'u1', ['c1']),
    }));
    expect(left).toEqual({ parents: [], children: [] });
  });

  it('leaves a tombstone a live row still references, without failing gc', async () => {
    const db = await fkDb();
    const store = fkStore(db);
    await store.transaction('u1', 'push', async (tx) => {
      await tx.upsert('parents', 'u1', [{ id: 'p1', name: 'parent' }]);
      await tx.upsert('children', 'u1', [{ id: 'c1', parent_id: 'p1' }]);
      await tx.tombstone('parents', 'u1', ['p1']);
    });

    await expect(store.gc(1_000_000)).resolves.toBeUndefined();

    const left = await store.transaction('u1', 'pull', async (tx) => ({
      parents: await tx.tombstonedIds('parents', 'u1', ['p1']),
      children: (await tx.changedSince('children', 'u1', 0)).length,
    }));
    // the referenced tombstone survives; the live child is untouched
    expect(left).toEqual({ parents: ['p1'], children: 1 });
  });
});

describe('revision sequence', () => {
  const taskStore = (db: DrizzleDb) =>
    createDrizzleStore<string>({
      db,
      tables: {
        tasks: {
          table: tasks,
          id: tasks.id,
          rev: tasks.rev,
          deletedAt: tasks.deletedAt,
          scope: tasks.owner,
        },
      },
    });

  it('refuses a revision past 2^53 instead of rounding it', async () => {
    const { client, db } = await freshDb();
    await client.exec(`select setval('remelon_rev', 9007199254740992)`);
    const store = taskStore(db);

    await expect(
      store.transaction('u1', 'push', (tx) =>
        tx.upsert('tasks', 'u1', [{ id: 't1', name: 'a', done: false }]),
      ),
    ).rejects.toThrow(/2\^53/);
  });

  it('stamps the largest safe revision exactly', async () => {
    const { client, db } = await freshDb();
    await client.exec(`select setval('remelon_rev', 9007199254740990)`);
    const store = taskStore(db);
    await store.transaction('u1', 'push', (tx) =>
      tx.upsert('tasks', 'u1', [{ id: 't1', name: 'a', done: false }]),
    );

    const max = await store.transaction('u1', 'pull', (tx) => tx.maxRev('u1'));
    expect(max).toBe(Number.MAX_SAFE_INTEGER);
  });
});
