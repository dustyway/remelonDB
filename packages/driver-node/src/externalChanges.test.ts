/**
 * database.applyExternalChanges: the multi-tab doorway (docs/multi-tab.md).
 * Another context committed to shared storage; this database's cache and
 * observers are stale. The doorway applies the broadcast change set to the
 * cache and notifies, without touching the driver — storage already has
 * the data.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  appSchema,
  column as c,
  Database,
  ModelFor,
  sanitizedRaw,
  table,
} from '@remelondb/core';
import { NodeSqliteDriver } from './NodeSqliteDriver';

const notesTable = table('notes', {
  text: c.string(),
});

const schema = appSchema({ version: 1, tables: [notesTable] });

class Note extends ModelFor(notesTable) {}

const raw = (fields: Record<string, unknown>) =>
  sanitizedRaw(fields, notesTable);

/** Simulate another context's committed write: storage only, no cache. */
const writeToStorageDirectly = async (
  driver: NodeSqliteDriver,
  fields: { id: string; text: string },
) => {
  await driver.execute(
    'insert into "notes" ("id", "_changed", "_status", "text") values (?, ?, ?, ?)',
    [fields.id, '', 'synced', fields.text],
  );
};

describe('applyExternalChanges', () => {
  let driver: NodeSqliteDriver;
  let db: Database;

  beforeEach(async () => {
    driver = new NodeSqliteDriver();
    db = await Database.open({
      driver,
      schema,
      modelClasses: [Note],
      name: ':memory:',
    });
  });

  afterEach(async () => {
    await driver.destroy().catch(() => {});
  });

  it('external create notifies query observers with the new record', async () => {
    const emissions: Note[][] = [];
    const unsubscribe = db
      .get(Note)
      .query()
      .observe((records) => emissions.push(records));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(emissions.at(-1)).toEqual([]);

    await writeToStorageDirectly(driver, { id: 'n1', text: 'from elsewhere' });
    await db.applyExternalChanges({
      notes: [
        {
          record: raw({ id: 'n1', text: 'from elsewhere', _status: 'synced' }),
          type: 'created',
        },
      ],
    });

    const latest = emissions.at(-1)!;
    expect(latest.map((n) => n.id)).toEqual(['n1']);
    expect(latest[0]!.text).toBe('from elsewhere');
    unsubscribe();
  });

  it('external update mutates the cached instance in place', async () => {
    const note = await db.write(() =>
      db.get(Note).create({ id: 'n1', text: 'old' }),
    );

    // another context updated storage; our cached instance is stale
    await driver.execute('update "notes" set "text" = ? where "id" = ?', [
      'new',
      'n1',
    ]);
    await db.applyExternalChanges({
      notes: [
        {
          record: raw({ id: 'n1', text: 'new', _status: 'synced' }),
          type: 'updated',
        },
      ],
    });

    // same identity, fresh content: observers holding the instance see the change
    const refetched = await db.get(Note).query().fetch();
    expect(refetched[0]).toBe(note);
    expect(note.text).toBe('new');
  });

  it('external destroy removes the record and notifies', async () => {
    await db.write(() => db.get(Note).create({ id: 'n1', text: 'doomed' }));
    const emissions: Note[][] = [];
    const unsubscribe = db
      .get(Note)
      .query()
      .observe((records) => emissions.push(records));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(emissions.at(-1)!.length).toBe(1);

    await driver.execute('delete from "notes" where "id" = ?', ['n1']);
    await db.applyExternalChanges({
      notes: [{ record: raw({ id: 'n1', text: 'doomed' }), type: 'destroyed' }],
    });

    expect(emissions.at(-1)).toEqual([]);
    unsubscribe();
  });

  it('is idempotent: re-broadcast create degrades to update, unknown destroy is a no-op', async () => {
    const note = await db.write(() =>
      db.get(Note).create({ id: 'n1', text: 'old' }),
    );

    await db.applyExternalChanges({
      notes: [
        {
          record: raw({ id: 'n1', text: 'again', _status: 'synced' }),
          type: 'created',
        },
      ],
    });
    expect(note.text).toBe('again');
    expect((await db.get(Note).query().fetch()).length).toBe(1);

    await expect(
      db.applyExternalChanges({
        notes: [{ record: raw({ id: 'ghost', text: '' }), type: 'destroyed' }],
      }),
    ).resolves.toBeUndefined();
  });

  it('does not interleave with an open read consistency window', async () => {
    const log: string[] = [];
    const read = db.read(async () => {
      log.push('read start');
      await new Promise((resolve) => setTimeout(resolve, 30));
      log.push('read end');
    });
    const apply = db
      .applyExternalChanges({
        notes: [
          {
            record: raw({ id: 'n1', text: 'x', _status: 'synced' }),
            type: 'created',
          },
        ],
      })
      .then(() => log.push('applied'));
    await Promise.all([read, apply]);
    expect(log).toEqual(['read start', 'read end', 'applied']);
  });
});
