/**
 * Local-only tables end to end: ordinary storage and migrations, invisible
 * to every phase of sync.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyRemoteChanges,
  appSchema,
  addColumns,
  column as c,
  Database,
  fetchLocalChanges,
  hasUnsyncedChanges,
  schemaMigrations,
  synchronize,
  table,
  type SyncChanges,
  type SyncPullResult,
  type SyncPushResult,
} from '@remelondb/core';
import { NodeSqliteDriver } from './NodeSqliteDriver';

const tasks = table('tasks', { name: c.string() });
const cache = table(
  'media_cache',
  { file_id: c.string().indexed(), bytes: c.blob() },
  { localOnly: true },
);
const schema = appSchema({ version: 1, tables: [tasks, cache] });
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

const cacheRow = (id: string) => ({
  id,
  file_id: `f-${id}`,
  bytes: new Uint8Array([1, 2, 3]),
});

describe('local-only tables and the push', () => {
  it('never enter a push and never count as unsynced work', async () => {
    await db.write(async () => {
      await db.get('media_cache').create(cacheRow('m1'));
    });

    expect(await hasUnsyncedChanges(db)).toBe(false);
    const local = await fetchLocalChanges(db);
    expect(local.changes['media_cache']).toBeUndefined();
    expect(local.isEmpty).toBe(true);

    let pushed: SyncChanges | undefined;
    await synchronize({
      database: db,
      pullChanges: async (): Promise<SyncPullResult> => ({
        changes: { tasks: empty },
        cursor: '1',
      }),
      pushChanges: async ({ changes }): Promise<SyncPushResult> => {
        pushed = changes;
        return { cursor: null, changes: null };
      },
    });
    expect(pushed?.['media_cache']).toBeUndefined();

    // and the rows are still there, still marked created
    const rows = await driver.query('select * from "media_cache"', []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'm1', _status: 'created' });
  });
});

describe('local-only tables and the pull', () => {
  it('a pull naming one is rejected rather than applied', async () => {
    await expect(
      db.write(async () => {
        await applyRemoteChanges(db, {
          media_cache: {
            created: [{ id: 'm1', file_id: 'f', bytes: '' }],
            updated: [],
            deleted: [],
          },
        });
      }),
    ).rejects.toThrow("local-only table 'media_cache'");

    expect(await driver.query('select * from "media_cache"', [])).toHaveLength(
      0,
    );
  });

  it('a replacement leaves local-only rows intact and replaces the rest', async () => {
    await db.write(async () => {
      await applyRemoteChanges(db, {
        tasks: {
          created: [
            { id: 't1', name: 'stale' },
            { id: 't2', name: 'keep' },
          ],
          updated: [],
          deleted: [],
        },
      });
      await db.get('media_cache').create(cacheRow('m1'));
    });

    await db.write(async () => {
      await applyRemoteChanges(
        db,
        { tasks: { ...empty, created: [{ id: 't2', name: 'keep' }] } },
        { replacement: true },
      );
    });

    const taskRows = await driver.query('select * from "tasks"', []);
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0]).toMatchObject({ id: 't2' });
    expect(await driver.query('select * from "media_cache"', [])).toHaveLength(
      1,
    );
  });
});

describe('local-only tables and migrations', () => {
  const filePath = `${import.meta.dirname}/.tmp-local-only-test.db`;

  afterEach(async () => {
    const cleanup = new NodeSqliteDriver();
    await cleanup.open(filePath).catch(() => null);
    await cleanup.destroy().catch(() => {});
  });

  it('are created and altered like any other table', async () => {
    const first = new NodeSqliteDriver();
    const dbV1 = await Database.open({ driver: first, schema, name: filePath });
    await dbV1.write(async () => {
      await dbV1.get('media_cache').create(cacheRow('m1'));
    });
    await first.close();

    const cacheV2 = table(
      'media_cache',
      {
        file_id: c.string().indexed(),
        bytes: c.blob(),
        fetched_at: c.number(),
      },
      { localOnly: true },
    );
    const second = new NodeSqliteDriver();
    const dbV2 = await Database.open({
      driver: second,
      schema: appSchema({ version: 2, tables: [tasks, cacheV2] }),
      migrations: schemaMigrations({
        migrations: [
          {
            toVersion: 2,
            steps: [
              addColumns({
                table: 'media_cache',
                columns: { fetched_at: c.number() },
              }),
            ],
          },
        ],
      }),
      name: filePath,
    });
    expect(await dbV2.get('media_cache').find('m1')).toMatchObject({
      file_id: 'f-m1',
      fetched_at: 0,
    });
    await second.destroy();
  });
});
