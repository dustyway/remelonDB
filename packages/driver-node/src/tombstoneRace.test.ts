/**
 * The mid-push tombstone race (thermonuclear core P1-1): while a push is
 * in flight, another context can destroy the pushed tombstone and
 * re-create the id as a live synced row (a pull applying the server's
 * re-creation). mark-as-synced must not destroy that newer knowledge,
 * and a run whose sync lease was taken mid-push must not mark at all.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appSchema,
  column as c,
  CURSOR_KEY,
  Database,
  hasUnsyncedChanges,
  sanitizedRaw,
  synchronize,
  table,
  type SyncPullResult,
  type SyncPushResult,
} from '@remelondb/core';
import { NodeSqliteDriver } from './NodeSqliteDriver';

const tasks = table('tasks', { name: c.string(), position: c.number() });
const schema = appSchema({ version: 1, tables: [tasks] });
const empty = { created: [], updated: [], deleted: [] };

let driver: NodeSqliteDriver;
let db: Database;
beforeEach(async () => {
  driver = new NodeSqliteDriver();
  db = await Database.open({ driver, schema, name: ':memory:' });
});
afterEach(async () => {
  await driver.destroy().catch(() => {});
});

const seedAndDelete = async () => {
  await synchronize({
    database: db,
    pullChanges: async (): Promise<SyncPullResult> => ({
      changes: {
        tasks: {
          created: [{ id: 't1', name: 'v1', position: 1 }],
          updated: [],
          deleted: [],
        },
      },
      cursor: '1',
    }),
  });
  await db.write(async () => {
    await db.get('tasks').markAsDeleted('t1');
  });
};

const foreignRecreation = async () => {
  // another context pulled the server's re-creation of t1 and advanced
  // the shared cursor while our push was in flight
  await driver.execute('delete from "tasks" where "id" = ?', ['t1']);
  await driver.execute(
    'insert into "tasks" ("id","_changed","_status","name","position") values (?,?,?,?,?)',
    ['t1', '', 'synced', 'server-recreated', 7],
  );
  await db.localStorage.set(CURSOR_KEY, '2');
  await db.applyExternalChanges({
    tasks: [
      {
        record: { id: 't1', _status: 'deleted', _changed: '' },
        type: 'destroyed',
      },
      {
        record: sanitizedRaw(
          {
            id: 't1',
            _status: 'synced',
            _changed: '',
            name: 'server-recreated',
            position: 7,
          },
          tasks,
        ),
        type: 'created',
      },
    ],
  });
};

describe('a pushed tombstone against a mid-push foreign re-creation', () => {
  it('leaves the re-created row alive: only a still-standing tombstone is destroyed', async () => {
    await seedAndDelete();
    await synchronize({
      database: db,
      pullChanges: async (): Promise<SyncPullResult> => ({
        changes: { tasks: empty },
        cursor: '1',
      }),
      pushChanges: async (): Promise<SyncPushResult> => {
        await foreignRecreation();
        return { cursor: null, changes: null };
      },
    });

    const rows = await driver.query('select * from "tasks"', []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 't1', name: 'server-recreated' });
    expect(await db.localStorage.get(CURSOR_KEY)).toBe('2');
  });

  it('a run whose lease was taken mid-push marks nothing and reports lost', async () => {
    await seedAndDelete();
    let granted = true;
    Object.assign(driver, {
      requestSyncTurn: async () => granted,
    });

    const result = await synchronize({
      database: db,
      pullChanges: async (): Promise<SyncPullResult> => ({
        changes: { tasks: empty },
        cursor: '1',
      }),
      pushChanges: async (): Promise<SyncPushResult> => {
        granted = false; // the lease expired and another tab took the turn
        return { cursor: null, changes: null };
      },
    });

    expect(result.lease).toBe('lost');
    // the tombstone stays dirty for the next run to reconcile
    expect(await hasUnsyncedChanges(db)).toBe(true);
  });
});
