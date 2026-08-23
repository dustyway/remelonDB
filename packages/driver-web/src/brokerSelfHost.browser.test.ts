/**
 * remelonDB#4: where SharedWorkerGlobalScope has the Worker constructor
 * (Firefox), the broker hosts the compute worker itself — it survives
 * tab navigation, so no tab is ever asked to host and no page death can
 * orphan the OPFS handles. Chromium/WebKit keep the tab-hosted bridge.
 * The observable is the driver's hostedComputeWorker: null means the
 * broker never sent this tab a spawnWorker control.
 */
import { describe, expect, it } from 'vitest';
import { WebSqliteDriver } from './WebSqliteDriver';

const isFirefox = navigator.userAgent.includes('Firefox');

describe('broker-hosted compute (remelonDB#4)', () => {
  it('shared mode works with host-appropriate compute placement', async () => {
    const name = `selfhost-${Date.now()}.db`;
    const tabA = new WebSqliteDriver({ shared: true });
    const tabB = new WebSqliteDriver({ shared: true });

    await tabA.open(name);
    await tabA.execute('create table t ("id" primary key, "v")', []);
    await tabA.execute('insert into t values (?, ?)', ['k', 'v1']);
    await tabB.open(name);
    expect(await tabB.query('select "v" from t', [])).toEqual([{ v: 'v1' }]);

    if (isFirefox) {
      // the whole point: no tab hosts the worker
      expect(tabA.hostedComputeWorker).toBeNull();
      expect(tabB.hostedComputeWorker).toBeNull();
    } else {
      // chromium/webkit: exactly one tab was asked to host
      expect(
        tabA.hostedComputeWorker ?? tabB.hostedComputeWorker,
      ).not.toBeNull();
    }

    await tabA.close();
    await tabB.destroy();
    // tab-hosted cleanup (no-op on firefox); the broker's idle release
    // handles the self-hosted case on its own
    tabA.hostedComputeWorker?.terminate();
    tabB.hostedComputeWorker?.terminate();
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  it('reopening after everything closed spawns fresh and sees durable data', async () => {
    const name = `selfhost-re-${Date.now()}.db`;
    const first = new WebSqliteDriver({ shared: true });
    await first.open(name);
    await first.execute('create table t ("id" primary key)', []);
    await first.setUserVersion(7);
    await first.close(); // last holder: idle release tears compute down

    await new Promise((resolve) => setTimeout(resolve, 200));

    const second = new WebSqliteDriver({ shared: true });
    const { userVersion } = await second.open(name);
    expect(userVersion).toBe(7);
    await second.destroy();
    first.hostedComputeWorker?.terminate();
    second.hostedComputeWorker?.terminate();
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  it('a surviving holder keeps working after the compute worker dies', async () => {
    const name = `survivor-${Date.now()}.db`;
    const tabA = new WebSqliteDriver({ shared: true });
    const tabB = new WebSqliteDriver({ shared: true });
    await tabA.open(name);
    await tabA.execute('create table t ("id" primary key, "v")', []);
    await tabA.execute('insert into t values (?, ?)', ['k', 'kept']);
    await tabB.open(name);

    // the staging repro: the hosting context dies without ceremony
    // (tab-hosted mode only; a broker-hosted worker cannot die this way)
    if (tabA.hostedComputeWorker ?? tabB.hostedComputeWorker) {
      (tabA.hostedComputeWorker ?? tabB.hostedComputeWorker)!.terminate();
    }

    // the survivor's next query must be answered, not "not open": the
    // broker respawns, re-opens held databases, then replays
    expect(await tabB.query('select "v" from t', [])).toEqual([{ v: 'kept' }]);

    // and a brand-new tab joins cleanly too
    const tabC = new WebSqliteDriver({ shared: true });
    await tabC.open(name);
    expect(await tabC.query('select count(*) as n from t', [])).toEqual([
      { n: 1 },
    ]);

    await tabA.close();
    await tabB.close();
    await tabC.destroy();
    tabA.hostedComputeWorker?.terminate();
    tabB.hostedComputeWorker?.terminate();
    tabC.hostedComputeWorker?.terminate();
    await new Promise((resolve) => setTimeout(resolve, 200));
  }, 40_000);

  it('two tabs cold-opening simultaneously both succeed (first-open race)', async () => {
    const name = `race-${Date.now()}.db`;
    const tabA = new WebSqliteDriver({ shared: true });
    const tabB = new WebSqliteDriver({ shared: true });

    // neither open may fail with "already open" or a DDL collision
    const [a, b] = await Promise.all([tabA.open(name), tabB.open(name)]);
    expect(a.userVersion).toBe(0);
    expect(b.userVersion).toBe(0);

    await tabA.execute('create table t ("id" primary key)', []);
    expect(await tabB.query('select count(*) as n from t', [])).toEqual([
      { n: 0 },
    ]);

    await tabA.close();
    await tabB.destroy();
    tabA.hostedComputeWorker?.terminate();
    tabB.hostedComputeWorker?.terminate();
    await new Promise((resolve) => setTimeout(resolve, 200));
  }, 30_000);

  it('heals when connect-probe pings race ahead of the pending opens', async () => {
    // the discovered flake ordering: a dead compute, then two fresh
    // connections whose probe pings enter the route table before their
    // opens. the respawn asker must never be a ping's self-addressed
    // fake port — pre-fix, spawnWorker vanished into it and both opens
    // timed out.
    const name = `pingorder-${Date.now()}.db`;
    const seed = new WebSqliteDriver({ shared: true });
    await seed.open(name);
    await seed.close();
    // kill whatever hosts the compute, silently
    seed.hostedComputeWorker?.terminate();

    const tabA = new WebSqliteDriver({ shared: true });
    const tabB = new WebSqliteDriver({ shared: true });
    const [a, b] = await Promise.all([tabA.open(name), tabB.open(name)]);
    expect(a.userVersion).toBe(0);
    expect(b.userVersion).toBe(0);
    expect(await tabA.query('select 1 as one', [])).toEqual([{ one: 1 }]);

    await tabA.close();
    await tabB.destroy();
    tabA.hostedComputeWorker?.terminate();
    tabB.hostedComputeWorker?.terminate();
    await new Promise((resolve) => setTimeout(resolve, 200));
  }, 40_000);
});
