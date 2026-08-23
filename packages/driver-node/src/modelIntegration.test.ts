/**
 * The Model layer end to end: schema-generated accessors, update builders,
 * identity, relations, observation, timestamps, and interplay with sync.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appSchema,
  column as c,
  Database,
  Model,
  ModelFor,
  Q,
  synchronize,
  table,
  type AssociationsMap,
  type SyncPullArgs,
  type SyncPullResult,
} from '@remelondb/core';
import { NodeSqliteDriver } from './NodeSqliteDriver';

const tasksTable = table('tasks', {
  name: c.string(),
  is_done: c.boolean(),
  project_id: c.string().optional(),
  created_at: c.number(),
  updated_at: c.number(),
});

const projectsTable = table('projects', {
  name: c.string(),
});

const schema = appSchema({
  version: 1,
  tables: [tasksTable, projectsTable],
});

class Task extends ModelFor(tasksTable) {
  static override readonly associations = {
    projects: { type: 'belongs_to', key: 'project_id' },
  } satisfies AssociationsMap;
}

class Project extends ModelFor(projectsTable) {
  static override readonly associations = {
    tasks: { type: 'has_many', foreignKey: 'project_id' },
  } satisfies AssociationsMap;
}

describe('Model layer', () => {
  let driver: NodeSqliteDriver;
  let db: Database;

  beforeEach(async () => {
    driver = new NodeSqliteDriver();
    db = await Database.open({
      driver,
      schema,
      modelClasses: [Task, Project],
      name: ':memory:',
    });
  });

  afterEach(async () => {
    await driver.destroy().catch(() => {});
  });

  it('creates typed models with generated accessors and timestamps', async () => {
    const before = Date.now();
    const task = await db.write(() =>
      db.get(Task).create({ name: 'write models', is_done: false }),
    );
    expect(task).toBeInstanceOf(Task);
    expect(task.name).toBe('write models');
    expect(task.is_done).toBe(false);
    expect(task.created_at).toBeGreaterThanOrEqual(before);
    expect(task.updated_at).toBe(task.created_at);
    expect(task.syncStatus).toBe('created');
  });

  it('maintains model identity across find/query/create', async () => {
    const created = await db.write(() =>
      db.get(Task).create({ id: 't1', name: 'a' }),
    );
    const found = await db.get(Task).find('t1');
    const [queried] = await db.get(Task).query().fetch();
    expect(found).toBe(created);
    expect(queried).toBe(created);
  });

  it('records are read-only outside update()', async () => {
    const task = await db.write(() => db.get(Task).create({ name: 'x' }));
    expect(() => {
      task.name = 'nope';
    }).toThrow('outside of update()');
  });

  it('update() builder writes through sanitize + dirty tracking and touches updated_at', async () => {
    const task = await db.write(() =>
      db.get(Task).create({ id: 't1', name: 'v1' }),
    );
    const createdAt = task.updated_at;
    await new Promise((resolve) => setTimeout(resolve, 5));

    await db.write(() =>
      task.update(() => {
        task.name = 'v2';
        expect(task.name).toBe('v2'); // builder sees pending value
      }),
    );
    expect(task.name).toBe('v2');
    expect(task.updated_at).toBeGreaterThan(createdAt);

    const rows = await driver.query('select "name" from tasks', []);
    expect(rows[0]?.['name']).toBe('v2');
  });

  it('prepareUpdate() leaves the model unchanged until its batch commits', async () => {
    const task = await db.write(() =>
      db.get(Task).create({ id: 't1', name: 'before' }),
    );
    const emissions: Task[] = [];
    const unsubscribe = task.observe((record) => {
      if (record) emissions.push(record);
    });

    await db.write(async () => {
      const operation = task.prepareUpdate(() => {
        task.name = 'after';
        expect(task.name).toBe('after');
      });

      expect(task.name).toBe('before');
      expect(emissions).toHaveLength(1);

      await db.batch([operation]);
    });

    expect(task.name).toBe('after');
    expect(await db.get(Task).find('t1')).toBe(task);
    expect(emissions).toEqual([task, task]);
    unsubscribe();
  });

  it('rolls back a prepared model update with the rest of a failed batch', async () => {
    const task = await db.write(() =>
      db.get(Task).create({ id: 't1', name: 'before' }),
    );
    let notifications = 0;
    const unsubscribe = task.observe(() => notifications++);

    await expect(
      db.write(() =>
        db.batch([
          task.prepareUpdate(() => {
            task.name = 'after';
          }),
          db.get(Task).prepareCreate({ id: 't1', name: 'duplicate' }),
        ]),
      ),
    ).rejects.toThrow(/unique|constraint/i);

    expect(task.name).toBe('before');
    expect(notifications).toBe(1);
    const rows = await driver.query('select "name" from tasks where "id" = ?', [
      't1',
    ]);
    expect(rows).toEqual([{ name: 'before' }]);
    unsubscribe();
  });

  it('rolls back a prepared create when the model update fails', async () => {
    const task = await db.write(() =>
      db.get(Task).create({ id: 't1', name: 'before' }),
    );
    await driver.execute(
      `create trigger reject_blocked_task
       before update on tasks when new.name = 'blocked'
       begin select raise(abort, 'blocked task update'); end`,
      [],
    );

    await expect(
      db.write(() =>
        db.batch([
          db.get(Project).prepareCreate({ id: 'p1', name: 'created first' }),
          task.prepareUpdate(() => {
            task.name = 'blocked';
          }),
        ]),
      ),
    ).rejects.toThrow(/blocked task update/);

    expect(task.name).toBe('before');
    expect(db.get(Project).cache.get('p1')).toBeUndefined();
    expect(await driver.query('select "id" from projects', [])).toEqual([]);
  });

  it('rejects updates on a deleted record instead of writing onto the tombstone', async () => {
    const task = await db.write(() =>
      db.get(Task).create({ id: 'stale', name: 'before' }),
    );
    await db.write(() => task.markAsDeleted());

    // the committed path used to fail on its by-id lookup; the prepared
    // path must fail equally loudly instead of building an op from the
    // stale raw
    expect(() =>
      task.prepareUpdate(() => {
        task.name = 'after';
      }),
    ).toThrow(/deleted/);
    await expect(
      db.write(() =>
        task.update(() => {
          task.name = 'after';
        }),
      ),
    ).rejects.toThrow(/deleted/);
  });

  it('clears prepared fields after builder errors and rejects reentrant updates', async () => {
    const task = await db.write(() => db.get(Task).create({ name: 'before' }));

    expect(() =>
      task.prepareUpdate(() => {
        task.name = 'discarded';
        throw new Error('builder failed');
      }),
    ).toThrow('builder failed');
    expect(task.name).toBe('before');

    expect(() =>
      task.prepareUpdate(() => {
        task.prepareUpdate(() => {});
      }),
    ).toThrow('already updating');

    await db.write(() =>
      db.batch([
        task.prepareUpdate(() => {
          task.name = 'after';
        }),
      ]),
    );
    expect(task.name).toBe('after');
  });

  it('builder writes are sanitized like any other write', async () => {
    const task = await db.write(() => db.get(Task).create({ name: 'x' }));
    await db.write(() =>
      task.update(() => {
        task.is_done = 1 as never; // storage representation in…
      }),
    );
    expect(task.is_done).toBe(true); // …real boolean out
  });

  it('navigates belongs_to and has_many associations', async () => {
    const { project, task, orphan } = await db.write(async () => {
      const project = await db.get(Project).create({ id: 'p1', name: 'proj' });
      const task = await db
        .get(Task)
        .create({ id: 't1', name: 'a', project_id: 'p1' });
      const orphan = await db.get(Task).create({ id: 't2', name: 'b' });
      return { project, task, orphan };
    });

    expect(await task.related<Project>('projects')).toBe(project);
    expect(await orphan.related<Project>('projects')).toBeNull();

    const children = await project.children<Task>('tasks').fetch();
    expect(children).toEqual([task]);

    // model associations feed the query compiler too
    const viaJoin = await db
      .get(Task)
      .query(Q.on('projects', 'name', 'proj'))
      .fetch();
    expect(viaJoin).toEqual([task]);
  });

  it('related() is null when the foreign key points at a record that is gone', async () => {
    const { task, deleted } = await db.write(async () => {
      await db.get(Project).create({ id: 'p1', name: 'proj' });
      const task = await db
        .get(Task)
        .create({ id: 't1', name: 'a', project_id: 'p1' });
      const deleted = await db
        .get(Task)
        .create({ id: 't2', name: 'b', project_id: 'never-existed' });
      return { task, deleted };
    });

    expect(await deleted.related<Project>('projects')).toBeNull();

    await db.write(() => db.get(Project).markAsDeleted('p1'));
    expect(await task.related<Project>('projects')).toBeNull();
  });

  it('observes a single record until deletion', async () => {
    const task = await db.write(() => db.get(Task).create({ id: 't1' }));
    const emissions: (Task | null)[] = [];
    const unsubscribe = task.observe((record) => emissions.push(record));
    expect(emissions).toEqual([task]);

    await db.write(() => task.update(() => (task.name = 'renamed')));
    expect(emissions).toEqual([task, task]);

    await db.write(() => task.markAsDeleted());
    expect(emissions).toEqual([task, task, null]);
    unsubscribe();
  });

  it('query.observe emits model instances', async () => {
    const emissions: Task[][] = [];
    const unsubscribe = db
      .get(Task)
      .query(Q.where('is_done', false))
      .observe((records) => emissions.push(records));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const task = await db.write(() => db.get(Task).create({ is_done: false }));
    expect(emissions).toEqual([[], [task]]);
    expect(emissions[1]?.[0]).toBeInstanceOf(Task);
    unsubscribe();
  });

  it('rejects model classes whose columns collide with the Model API', async () => {
    const badSchema = appSchema({
      version: 1,
      tables: [table('bads', { update: c.string() })],
    });
    class Bad extends Model {
      static override readonly table = 'bads';
    }
    const d = new NodeSqliteDriver();
    await expect(
      Database.open({
        driver: d,
        schema: badSchema,
        modelClasses: [Bad],
        name: ':memory:',
      }),
    ).rejects.toThrow('conflicts with a property');
    await d.destroy().catch(() => {});
  });

  it('sync updates flow into existing model instances', async () => {
    const task = await db.write(() =>
      db.get(Task).create({ id: 't1', name: 'local', is_done: false }),
    );
    const pullChanges = async (
      _args: SyncPullArgs,
    ): Promise<SyncPullResult> => ({
      changes: {
        tasks: {
          created: [],
          updated: [
            {
              id: 't1',
              name: 'from server',
              is_done: true,
              project_id: null,
              created_at: 1,
              updated_at: 2,
            },
          ],
          deleted: [],
        },
      },
      cursor: '1',
    });
    // record is dirty (created) — but first sync: push marks it synced
    await synchronize({
      database: db,
      pullChanges,
      pushChanges: async () => ({ cursor: null, changes: null }),
    });
    await synchronize({ database: db, pullChanges });

    expect(task.name).toBe('from server'); // same instance, server value
    expect(task.is_done).toBe(true);
  });
});
