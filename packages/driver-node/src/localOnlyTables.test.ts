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
  createTable,
  Database,
  fetchLocalChanges,
  hasUnsyncedChanges,
  LAST_SCHEMA_VERSION_KEY,
  schemaMigrations,
  synchronize,
  table,
  type MigrationStep,
  type SyncChanges,
  type SyncPullArgs,
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

  it('markAsDeleted removes the row instead of leaving a tombstone', async () => {
    await db.write(async () => {
      await db.get('media_cache').create(cacheRow('m1'));
      await db.get('media_cache').markAsDeleted('m1');
    });

    expect(await driver.query('select * from "media_cache"', [])).toEqual([]);
    expect(await hasUnsyncedChanges(db)).toBe(false);
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

describe('local-only tables and the migration descriptor', () => {
  const filePath = `${import.meta.dirname}/.tmp-local-only-migration.db`;

  afterEach(async () => {
    const cleanup = new NodeSqliteDriver();
    await cleanup.open(filePath).catch(() => null);
    await cleanup.destroy().catch(() => {});
  });

  const syncOnce = async (
    database: Database,
  ): Promise<(SyncPullArgs['migration'] | undefined)[]> => {
    const seen: (SyncPullArgs['migration'] | undefined)[] = [];
    await synchronize({
      database,
      migrationsEnabledAtVersion: 1,
      pullChanges: async (args): Promise<SyncPullResult> => {
        seen.push(args.migration);
        return { changes: {}, cursor: '1' };
      },
      pushChanges: async (): Promise<SyncPushResult> => ({
        cursor: null,
        changes: null,
      }),
    });
    return seen;
  };

  const openV2 = async (
    driverV2: NodeSqliteDriver,
    tablesV2: readonly ReturnType<typeof table>[],
    steps: MigrationStep[],
  ): Promise<Database> =>
    Database.open({
      driver: driverV2,
      schema: appSchema({ version: 2, tables: [tasks, ...tablesV2] }),
      migrations: schemaMigrations({ migrations: [{ toVersion: 2, steps }] }),
      name: filePath,
    });

  beforeEach(async () => {
    const first = new NodeSqliteDriver();
    const dbV1 = await Database.open({
      driver: first,
      schema: appSchema({ version: 1, tables: [tasks] }),
      name: filePath,
    });
    await syncOnce(dbV1);
    expect(await dbV1.localStorage.get(LAST_SCHEMA_VERSION_KEY)).toBe('1');
    await first.close();
  });

  it('a migration creating only a local-only table reports none', async () => {
    const second = new NodeSqliteDriver();
    const dbV2 = await openV2(
      second,
      [cache],
      [
        createTable({
          name: 'media_cache',
          columns: { file_id: c.string().indexed(), bytes: c.blob() },
        }),
      ],
    );

    expect(await syncOnce(dbV2)).toEqual([null]);
    expect(await dbV2.localStorage.get(LAST_SCHEMA_VERSION_KEY)).toBe('2');
    await second.destroy();
  });

  it('a mixed migration reports only the synced table', async () => {
    const notes = table('notes', { body: c.string() });
    const second = new NodeSqliteDriver();
    const dbV2 = await openV2(
      second,
      [cache, notes],
      [
        createTable({
          name: 'media_cache',
          columns: { file_id: c.string().indexed(), bytes: c.blob() },
        }),
        createTable({ name: 'notes', columns: { body: c.string() } }),
      ],
    );

    expect(await syncOnce(dbV2)).toEqual([
      { from: 1, tables: ['notes'], columns: [] },
    ]);
    await second.destroy();
  });
});
