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

const itTabHosted = navigator.userAgent.includes('Firefox') ? it.skip : it;

describe('shared mode: the spawn asker is a dead page', () => {
  itTabHosted(
    'a later page still opens the database',
    async () => {
      const name = `deadasker-${Date.now()}.db`;
      const zombieName = `zombie-${Date.now()}.db`;

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
        name: zombieName,
        storage: 'opfs',
      });

      // the next page load: this must not ride out the open deadline
      const next = new WebSqliteDriver({ shared: true, openTimeoutMs: 6000 });
      await next.open(name);
      expect(await next.query('select 1 as one', [])).toEqual([{ one: 1 }]);

      await next.close();
      const zombieCleanup = new WebSqliteDriver({ shared: true });
      await zombieCleanup.open(zombieName);
      await zombieCleanup.destroy();
      await alive.destroy();
      zombie.port.close();
      next.hostedComputeWorker?.terminate();
      alive.hostedComputeWorker?.terminate();
    },
    30_000,
  );

  itTabHosted(
    'tries an older live port when the newest port is silent',
    async () => {
      const name = `spawn-retry-${Date.now()}.db`;
      const silentName = `spawn-silent-${Date.now()}.db`;
      const alive = new WebSqliteDriver({ shared: true });
      await alive.open(name);

      const silent = new SharedWorker(
        new URL('./shared-worker.ts', import.meta.url),
        { type: 'module' },
      );
      silent.port.start();

      alive.hostedComputeWorker?.terminate();
      silent.port.postMessage({
        id: 1,
        op: 'open',
        name: silentName,
        storage: 'opfs',
      });

      // Watchdog + ping deadline + one silent spawn attempt is under 5s.
      await new Promise((resolve) => setTimeout(resolve, 5500));
      expect(await alive.query('select 1 as one', [])).toEqual([{ one: 1 }]);

      const silentCleanup = new WebSqliteDriver({ shared: true });
      await silentCleanup.open(silentName);
      await silentCleanup.destroy();
      await alive.destroy();
      silent.port.close();
      alive.hostedComputeWorker?.terminate();
    },
    30_000,
  );

  itTabHosted(
    'discards a worker adopted after another tab won',
    async () => {
      const name = `late-adopt-${Date.now()}.db`;
      const slow = new SharedWorker(
        new URL('./shared-worker.ts', import.meta.url),
        { type: 'module' },
      );
      let sawSpawn!: () => void;
      let sawDiscard!: () => void;
      const spawnRequested = new Promise<void>((resolve) => {
        sawSpawn = resolve;
      });
      const discarded = new Promise<void>((resolve) => {
        sawDiscard = resolve;
      });
      slow.port.addEventListener('message', (event) => {
        const data = event.data as { control?: string } | null;
        if (data?.control === 'spawnWorker') sawSpawn();
        if (data?.control === 'discardWorker') sawDiscard();
      });
      slow.port.start();
      slow.port.postMessage({ id: 1, op: 'open', name, storage: 'opfs' });
      await spawnRequested;

      const winner = new WebSqliteDriver({ shared: true });
      await winner.open(name);

      const late = new MessageChannel();
      slow.port.postMessage({ control: 'adoptWorkerPort' }, [late.port1]);
      await discarded;

      late.port2.close();
      await winner.destroy();
      slow.port.close();
      winner.hostedComputeWorker?.terminate();
    },
    30_000,
  );
});
