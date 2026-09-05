/**
 * The created-bucket semantics from the thermonuclear review, aligned
 * with sync_model.qnt's pullRow rule: the remote value is taken only
 * when the local status is none or synced. Plus the changeset
 * normalization that keeps a malformed pull from wedging the client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyRemoteChanges,
  appSchema,
  column as c,
  Database,
  hasUnsyncedChanges,
  synchronize,
  table,
  type SyncPullResult,
  type SyncPushResult,
} from '@remelondb/core';
import { NodeSqliteDriver } from './NodeSqliteDriver';

const tasks = table('tasks', { name: c.string(), position: c.number() });
const notes = table('notes', { body: c.string() });
const assets = table('assets', {
  data: c.blob(),
  preview: c.blob().optional(),
});
const schema = appSchema({ version: 1, tables: [tasks, notes, assets] });
const empty = { created: [], updated: [], deleted: [] };
const task = (id: string, name: string, position = 1) => ({
  id,
  name,
  position,
});

let driver: NodeSqliteDriver;
let db: Database;
beforeEach(async () => {
  driver = new NodeSqliteDriver();
  db = await Database.open({ driver, schema, name: ':memory:' });
});
afterEach(async () => {
  await driver.destroy().catch(() => {});
});

const seedSynced = async (id: string, name: string) => {
  await db.write(async () => {
    await applyRemoteChanges(db, {
      tasks: { created: [task(id, name)], updated: [], deleted: [] },
    });
  });
};

describe('the created bucket against local state', () => {
  it('a local tombstone survives a remote creation; the delete pushes later', async () => {
    await seedSynced('t1', 'v1');
    await db.write(async () => {
      await db.get('tasks').markAsDeleted('t1');
    });

    await db.write(async () => {
      await applyRemoteChanges(db, {
        tasks: {
          created: [task('t1', 'server-recreated')],
          updated: [],
          deleted: [],
        },
      });
    });

    const rows = await driver.query('select * from "tasks"', []);
    expect(rows[0]).toMatchObject({ id: 't1', _status: 'deleted' });
    expect(await hasUnsyncedChanges(db)).toBe(true);
  });

  it('a pushed but unmarked creation accepts a later remote update', async () => {
    await db.write(async () => {
      await db.get('tasks').create({ id: 't1', name: 'mine', position: 1 });
    });

    await db.write(async () => {
      await applyRemoteChanges(db, {
        tasks: { created: [], updated: [task('t1', 'theirs', 9)], deleted: [] },
      });
    });

    const rows = await driver.query('select * from "tasks"', []);
    expect(rows[0]).toMatchObject({
      id: 't1',
      name: 'theirs',
      position: 9,
      _status: 'created',
    });
  });

  it('a later local edit to a creation survives a remote update', async () => {
    await db.write(async () => {
      await db.get('tasks').create({ id: 't1', name: 'mine', position: 1 });
      await db.get('tasks').update('t1', { name: 'mine-later' });
    });

    await db.write(async () => {
      await applyRemoteChanges(db, {
        tasks: { created: [], updated: [task('t1', 'theirs', 9)], deleted: [] },
      });
    });

    const rows = await driver.query('select * from "tasks"', []);
    expect(rows[0]).toMatchObject({
      id: 't1',
      name: 'mine-later',
      position: 9,
      _status: 'created',
      _changed: 'name',
    });
  });
});

describe('changeset normalization', () => {
  it('one id in created and updated applies once instead of wedging', async () => {
    await db.write(async () => {
      await applyRemoteChanges(db, {
        tasks: {
          created: [task('t1', 'from-created')],
          updated: [task('t1', 'from-updated', 5)],
          deleted: [],
        },
      });
    });
    const rows = await driver.query('select * from "tasks"', []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 't1', name: 'from-updated' });
  });

  it('deleted supersedes both other buckets for the same id', async () => {
    await seedSynced('t1', 'v1');
    await db.write(async () => {
      await applyRemoteChanges(db, {
        tasks: {
          created: [task('t1', 'zombie')],
          updated: [task('t1', 'zombie')],
          deleted: ['t1'],
        },
      });
    });
    expect(await driver.query('select * from "tasks"', [])).toHaveLength(0);
  });

  it('applies a repeated deleted id once', async () => {
    await seedSynced('t1', 'v1');
    const changes: unknown[] = [];
    db.get('tasks').onChange((batch) => changes.push(...batch));

    await db.write(async () => {
      await applyRemoteChanges(db, {
        tasks: { created: [], updated: [], deleted: ['t1', 't1'] },
      });
    });

    expect(changes).toHaveLength(1);
    expect(await driver.query('select * from "tasks"', [])).toHaveLength(0);
  });
});

describe('blob wire values', () => {
  it('decodes base64 before storing a pulled row', async () => {
    await db.write(async () => {
      await applyRemoteChanges(db, {
        assets: {
          created: [{ id: 'a1', data: 'AH//', preview: null }],
          updated: [],
          deleted: [],
        },
      });
    });

    const asset = await db.get('assets').find('a1');
    expect(asset.data).toEqual(new Uint8Array([0, 127, 255]));
    expect(asset.preview).toBeNull();
  });

  it('rejects malformed base64 without writing the row', async () => {
    await expect(
      db.write(async () =>
        applyRemoteChanges(db, {
          assets: {
            created: [{ id: 'a1', data: 'not base64', preview: null }],
            updated: [],
            deleted: [],
          },
        }),
      ),
    ).rejects.toThrow('Invalid base64');
    await expect(db.get('assets').find('a1')).rejects.toThrow('not found');
  });

  it('rejects a sparse row before schema defaults can replace a missing blob', async () => {
    await expect(
      db.write(async () =>
        applyRemoteChanges(db, {
          assets: {
            created: [{ id: 'a1', preview: null }],
            updated: [],
            deleted: [],
          },
        }),
      ),
    ).rejects.toThrow("missing column 'data'");
  });

  it('does not write or notify when pulled bytes are unchanged', async () => {
    const row = { id: 'a1', data: 'AH//', preview: null };
    await db.write(async () => {
      await applyRemoteChanges(db, {
        assets: { created: [row], updated: [], deleted: [] },
      });
    });
    let notifications = 0;
    db.get('assets').onChange(() => notifications++);

    await db.write(async () => {
      await applyRemoteChanges(db, {
        assets: { created: [], updated: [row], deleted: [] },
      });
    });

    expect(notifications).toBe(0);
  });

  it('does not re-emit a query for equal bytes from another context', async () => {
    await db.write(() =>
      db.get('assets').create({
        id: 'a1',
        data: new Uint8Array([1, 2]),
        preview: null,
      }),
    );
    const emissions: unknown[][] = [];
    const unsubscribe = db
      .get('assets')
      .query()
      .observe((records) => emissions.push(records));
    await new Promise((resolve) => setTimeout(resolve, 0));

    await db.applyExternalChanges({
      assets: [
        {
          type: 'updated',
          record: {
            id: 'a1',
            data: new Uint8Array([1, 2]),
            preview: null,
            _status: 'synced',
            _changed: '',
          },
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(emissions).toHaveLength(1);
    unsubscribe();
  });
});

describe('replacement snapshots', () => {
  it('leaves an omitted table unchanged', async () => {
    await db.write(async () => {
      await applyRemoteChanges(db, {
        tasks: { created: [task('t1', 'keep')], updated: [], deleted: [] },
        notes: {
          created: [{ id: 'n1', body: 'stale' }],
          updated: [],
          deleted: [],
        },
      });
    });
    await db.write(async () => {
      await db.get('notes').create({ id: 'n2', body: 'unpushed' });
    });

    await db.write(async () => {
      await applyRemoteChanges(
        db,
        { tasks: { created: [task('t1', 'keep')], updated: [], deleted: [] } },
        { replacement: true },
      );
    });

    const noteRows = await driver.query('select * from "notes"', []);
    expect(noteRows).toHaveLength(2);
    expect(noteRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'n1', _status: 'synced' }),
        expect.objectContaining({ id: 'n2', _status: 'created' }),
      ]),
    );
    expect(await driver.query('select * from "tasks"', [])).toHaveLength(1);
  });
});

describe('the push-response apply', () => {
  it('receives the conflictResolver the pull phase gets', async () => {
    const resolver = vi.fn(
      (_table: string, local: unknown, _remote: unknown, resolved: unknown) =>
        resolved,
    );
    await seedSynced('t1', 'v1');
    await db.write(async () => {
      await db.get('tasks').update('t1', { name: 'local-edit' });
    });

    await synchronize({
      database: db,
      conflictResolver: resolver as never,
      pullChanges: async (): Promise<SyncPullResult> => ({
        changes: { tasks: empty },
        cursor: '2',
      }),
      pushChanges: async (): Promise<SyncPushResult> => ({
        cursor: '3',
        changes: {
          tasks: {
            created: [],
            updated: [task('t1', 'interleaved', 3)],
            deleted: [],
          },
        },
      }),
    });

    expect(resolver).toHaveBeenCalled();
  });
});
