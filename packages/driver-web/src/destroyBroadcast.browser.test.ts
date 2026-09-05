/**
 * Destroy broadcast (docs/multi-tab.md): destroying a database in one tab
 * evicts every other holder at the broker, so those tabs are told rather
 * than discovering it as "database is not open" on their next request.
 */
import { describe, expect, it } from 'vitest';
import { WebSqliteDriver } from './WebSqliteDriver';

describe('shared mode destroy broadcast', () => {
  it('tells the other tab its database was destroyed', async () => {
    const name = `destroyed-${Date.now()}.db`;
    const driverA = new WebSqliteDriver({ shared: true });
    const driverB = new WebSqliteDriver({ shared: true });
    await driverA.open(name);
    await driverB.open(name);

    await driverA.destroy();

    await expect
      .poll(() => driverB.query('select 1', []).catch((e: Error) => e.message))
      .toMatch(/destroyed by another tab/);

    driverA.hostedComputeWorker?.terminate();
    driverB.hostedComputeWorker?.terminate();
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
});
