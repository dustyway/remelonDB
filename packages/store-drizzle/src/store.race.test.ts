import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { bigint, boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import type { SyncChanges } from '@remelondb/core';
import { createSyncEngine } from '@remelondb/server';
import { accepted, pulled } from '@remelondb/server/conformance';
import { createDrizzleStore } from './store';

// The lost-write race, constructed deterministically (conformance item 4
// needs interleaving its generic hook cannot force): pin a pull snapshot
// on one connection, commit a push on another while the pull is still
// open, and the snapshot-derived cursor must sit below the missed write
// so the next pull delivers it. Needs real multi-connection Postgres:
// set REMELON_TEST_PG (CI provides a service container) or this skips.
const url = process.env['REMELON_TEST_PG'];

const raceTasks = pgTable('race_tasks', {
  id: text('id').primaryKey(),
  rev: bigint('rev', { mode: 'number' }).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  owner: text('owner').notNull(),
  name: text('name').notNull(),
  done: boolean('done').notNull(),
});

const liveIds = (changes: SyncChanges): string[] => {
  const set = changes['tasks'] ?? { created: [], updated: [], deleted: [] };
  return [...set.created, ...set.updated].map((row) => String(row['id']));
};

const d = url ? describe : describe.skip;
d('pull race on real postgres', () => {
  it(
    'a push committing during a pull is never lost',
    { timeout: 30_000 },
    async () => {
      const pool = new Pool({ connectionString: url, max: 4 });
      try {
        await pool.query('drop table if exists race_tasks');
        await pool.query('drop table if exists race_meta');
        await pool.query('drop sequence if exists race_rev');
        await pool.query('create sequence race_rev');
        await pool.query(
          'create table race_meta (key text primary key, value bigint not null)',
        );
        await pool.query(`
        create table race_tasks (
          id text primary key,
          rev bigint not null,
          deleted_at timestamptz,
          owner text not null,
          name text not null,
          done boolean not null
        )
      `);
        const store = createDrizzleStore<string>({
          db: drizzle(pool),
          revSequence: 'race_rev',
          metaTable: 'race_meta',
          tables: {
            tasks: {
              table: raceTasks,
              id: raceTasks.id,
              rev: raceTasks.rev,
              deletedAt: raceTasks.deletedAt,
              scope: raceTasks.owner,
            },
          },
        });
        const engine = createSyncEngine({
          store,
          tables: { tasks: { validate: (row) => row['name'] !== '' } },
        });
        const h = engine.as('racer');

        const empty = pulled(
          await h.pull({ cursor: null, schemaVersion: 1, migration: null }),
        );
        accepted(
          await h.push({
            changes: {
              tasks: {
                created: [{ id: 'seed', name: 'seed', done: false }],
                updated: [],
                deleted: [],
              },
            },
            cursor: empty.cursor,
          }),
        );
        const caughtUp = pulled(
          await h.pull({ cursor: null, schemaVersion: 1, migration: null }),
        );
        const since = Number(caughtUp.cursor);

        let pinned!: () => void;
        const snapshotPinned = new Promise<void>(
          (resolve) => (pinned = resolve),
        );
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));

        // connection A: the pull transaction, held open across the push
        const racingPull = store.transaction('racer', 'pull', async (tx) => {
          await tx.changedSince('tasks', 'racer', 0); // first query pins the snapshot
          pinned();
          await gate;
          return {
            ids: (await tx.changedSince('tasks', 'racer', since)).map(
              (change) => change.id,
            ),
            cursor: await tx.maxRev('racer'),
          };
        });

        await snapshotPinned;
        // connection B: a full push commits while A's snapshot is open
        accepted(
          await h.push({
            changes: {
              tasks: {
                created: [{ id: 'during', name: 'during', done: false }],
                updated: [],
                deleted: [],
              },
            },
            cursor: caughtUp.cursor,
          }),
        );
        release();
        const snapshot = await racingPull;

        const duringRev = Number(
          (
            await pool.query<{ rev: string }>(
              `select rev from race_tasks where id = 'during'`,
            )
          ).rows[0]!.rev,
        );
        // the open snapshot cannot see the concurrent commit...
        expect(snapshot.ids).not.toContain('during');
        // ...its cursor stays below the missed write, not at the sequence tip...
        expect(snapshot.cursor).toBeLessThan(duringRev);
        expect(snapshot.cursor).toBe(since);
        // ...so the next pull from that cursor delivers it: nothing lost
        const recovery = pulled(
          await h.pull({
            cursor: String(snapshot.cursor),
            schemaVersion: 1,
            migration: null,
          }),
        );
        expect(liveIds(recovery.changes)).toContain('during');
      } finally {
        await pool.end();
      }
    },
  );
});
