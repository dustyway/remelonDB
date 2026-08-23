/**
 * Cross-tab write-block arbitration (docs/multi-tab.md): the SharedWorker
 * grants write-block tokens one at a time (db.read windows shared), so two
 * tabs' read-modify-write blocks cannot interleave. Statement atomicity
 * alone does not cover this — the lost-update race lives between a block's
 * read and its commit.
 */
import { describe, expect, it } from 'vitest';
import {
  appSchema,
  column as c,
  Database,
  ModelFor,
  table,
} from '@remelondb/core';
import { WebSqliteDriver } from './WebSqliteDriver';

const countersTable = table('counters', {
  value: c.number(),
});
const schema = appSchema({ version: 1, tables: [countersTable] });
class Counter extends ModelFor(countersTable) {}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('shared mode sync lease', () => {
  it('one tab holds the lease; expiry passes it on', async () => {
    const name = `lease-${Date.now()}.db`;
    const tabA = new WebSqliteDriver({ shared: true, syncLeaseMs: 300 });
    const tabB = new WebSqliteDriver({ shared: true, syncLeaseMs: 300 });
    await tabA.open(name);
    await tabB.open(name);

    expect(await tabA.requestSyncTurn()).toBe(true); // takes the lease
    expect(await tabB.requestSyncTurn()).toBe(false); // held by A
    expect(await tabA.requestSyncTurn()).toBe(true); // renewal

    await wait(350); // A stops renewing (its tab "closed")
    expect(await tabB.requestSyncTurn()).toBe(true); // B inherits
    expect(await tabA.requestSyncTurn()).toBe(false); // A is out now

    await tabA.close();
    await tabB.destroy();
  });
});

describe('shared mode write arbitration', () => {
  it('driver slots: exclusive excludes, shared coexists', async () => {
    const name = `arb-driver-${Date.now()}.db`;
    const tabA = new WebSqliteDriver({ shared: true });
    const tabB = new WebSqliteDriver({ shared: true });
    await tabA.open(name);
    await tabB.open(name);

    const log: string[] = [];
    const releaseA = await tabA.acquireWorkSlot!(true);
    const pendingB = tabB.acquireWorkSlot!(true).then((release) => {
      log.push('b granted');
      return release;
    });
    await wait(30);
    expect(log).toEqual([]); // B waits while A holds the exclusive slot
    log.push('a releasing');
    await releaseA();
    const releaseB = await pendingB;
    expect(log).toEqual(['a releasing', 'b granted']);
    await releaseB();

    // shared slots coexist with each other
    const sharedA = await tabA.acquireWorkSlot!(false);
    const sharedB = await tabB.acquireWorkSlot!(false);
    await sharedA();
    await sharedB();

    await tabA.close();
    await tabB.destroy();
  });

  it('two databases racing read-modify-write converge', async () => {
    const name = `arb-db-${Date.now()}.db`;
    const driverA = new WebSqliteDriver({ shared: true });
    const driverB = new WebSqliteDriver({ shared: true });
    const dbA = await Database.open({
      driver: driverA,
      schema,
      modelClasses: [Counter],
      name,
    });
    const dbB = await Database.open({
      driver: driverB,
      schema,
      modelClasses: [Counter],
      name,
    });
    await dbA.write(() => dbA.get(Counter).create({ id: 'c1', value: 0 }));

    // each side: read the current value, wait (widening the race window),
    // then write value + 1. Without cross-tab arbitration one increment
    // is lost; with it the blocks serialize and both land.
    const increment = async (db: Database) => {
      await db.write(async () => {
        const [counter] = await db.get(Counter).query().fetch();
        const seen = counter!.value;
        await wait(20);
        await counter!.update(() => {
          counter!.value = seen + 1;
        });
      });
    };
    await Promise.all([increment(dbA), increment(dbB)]);

    // storage-level convergence is this slice's contract: both increments
    // landed, nothing was lost (raw SQL bypasses the record caches)
    expect(
      await driverA.query('select "value" from "counters" where "id" = ?', [
        'c1',
      ]),
    ).toEqual([{ value: 2 }]);

    // with change broadcast, B's increment reaches A's cache too — the
    // cached instance converges without any A-side action
    const [finalA] = await dbA.get(Counter).query().fetch();
    await expect.poll(() => finalA!.value).toBe(2);

    await driverA.close();
    await driverB.destroy();
  });
});
