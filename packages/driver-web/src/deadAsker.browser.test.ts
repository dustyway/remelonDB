/**
 * remelonDB#38: when the compute host dies, resetEpoch recruits a
 * replacement by posting spawnWorker to pending[0].port. After a full
 * page load that port can belong to the page that just died, and
 * postMessage to it neither throws nor arrives, so the broker waits
 * forever for a compute worker nobody is building.
 *
 * The abandoned port below is that dead page: a real connection to the
 * same broker that never answers a control message.
 */
import { describe, expect, it } from 'vitest';
import { WebSqliteDriver } from './WebSqliteDriver';

describe('shared mode: the spawn asker is a dead page', () => {
  it('a later page still opens the database', async () => {
    const name = `deadasker-${Date.now()}.db`;

    // a live page hosts the compute
    const alive = new WebSqliteDriver({ shared: true });
    await alive.open(name);

    // the page that is about to die: same broker, own port, and it
    // never handles messages, so a spawnWorker control vanishes
    const zombie = new SharedWorker(
      new URL('./shared-worker.ts', import.meta.url),
      { type: 'module' },
    );
    zombie.port.start();

    // the compute host dies first, so the dead page's request below is
    // never answered and stays pending: exactly the route resetEpoch
    // will pick as its spawn asker
    alive.hostedComputeWorker?.terminate();
    zombie.port.postMessage({
      id: 1,
      op: 'open',
      name: `zombie-${Date.now()}.db`,
      storage: 'opfs',
    });

    // the next page load: this must not ride out the open deadline
    const next = new WebSqliteDriver({ shared: true, openTimeoutMs: 6000 });
    await next.open(name);
    expect(await next.query('select 1 as one', [])).toEqual([{ one: 1 }]);

    await next.close();
    next.hostedComputeWorker?.terminate();
    alive.hostedComputeWorker?.terminate();
  }, 30_000);
});
