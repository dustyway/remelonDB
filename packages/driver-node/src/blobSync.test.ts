import { afterEach, describe, expect, it } from 'vitest';
import {
  appSchema,
  column as c,
  Database,
  synchronize,
  table,
} from '@remelondb/core';
import { createReferenceServer } from '@remelondb/server/conformance';
import { NodeSqliteDriver } from './NodeSqliteDriver';

const assets = table('assets', {
  data: c.blob(),
  preview: c.blob().optional(),
});
const schema = appSchema({ version: 1, tables: [assets] });

describe('blob sync', () => {
  const drivers: NodeSqliteDriver[] = [];

  afterEach(async () => {
    await Promise.all(drivers.splice(0).map((driver) => driver.destroy()));
  });

  it('round-trips bytes between two databases through the reference server', async () => {
    const open = async (): Promise<Database> => {
      const driver = new NodeSqliteDriver();
      drivers.push(driver);
      return Database.open({ driver, schema, name: ':memory:' });
    };
    const first = await open();
    const second = await open();
    const handlers = createReferenceServer().as('user-a');
    const sync = (database: Database) =>
      synchronize({
        database,
        pullChanges: handlers.pull,
        pushChanges: handlers.push,
      });

    await first.write(async () => {
      await first.get(assets).create({
        id: 'a1',
        data: new Uint8Array([0, 127, 255]),
        preview: null,
      });
    });
    await sync(first);
    await sync(second);

    const received = await second.get(assets).find('a1');
    expect(received.data).toEqual(new Uint8Array([0, 127, 255]));
    expect(received.data.constructor).toBe(Uint8Array);
    expect(received.preview).toBeNull();
  });
});
