import { afterAll, describe, expect, it } from 'vitest';
import { OpfsPoolHeldError } from './errors';
import type { Endpoint } from './protocol';
import { WebSqliteDriver } from './WebSqliteDriver';

const holder = new Worker(new URL('./worker.ts', import.meta.url), {
  type: 'module',
});
const holderEndpoint: Endpoint = {
  postMessage: (message) => {
    holder.postMessage(message);
  },
  addMessageListener: (listener) => {
    holder.addEventListener('message', (event) => {
      listener(event.data);
    });
  },
};

afterAll(() => {
  holder.terminate();
});

describe('held OPFS pool diagnostic', () => {
  it('reaches a shared-mode caller before its open deadline', async () => {
    const holdingDriver = new WebSqliteDriver({
      createEndpoint: () => holderEndpoint,
    });
    await holdingDriver.open(`pool-holder-${Date.now()}.db`);

    const waitingDriver = new WebSqliteDriver({
      shared: true,
      openTimeoutMs: 8_000,
    });
    const startedAt = Date.now();
    const error = await waitingDriver
      .open(`pool-waiter-${Date.now()}.db`)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpfsPoolHeldError);
    expect(error).toMatchObject({ code: 'OPFS_POOL_HELD' });
    expect(Date.now() - startedAt).toBeLessThan(8_000);
    holder.terminate();
  }, 12_000);
});
