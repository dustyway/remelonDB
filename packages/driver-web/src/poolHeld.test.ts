import type { Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpfsPoolHeldError } from './errors';
import { POOL_RETRY_DELAYS_MS, SqliteWorkerServer } from './server';
import { DEFAULT_OPEN_TIMEOUT_MS, WebSqliteDriver } from './WebSqliteDriver';

afterEach(() => {
  vi.useRealTimers();
});

describe('held OPFS pool', () => {
  it('closes databases before pausing the pool', async () => {
    const close = vi.fn();
    const pauseVfs = vi.fn();
    class FakeDb {
      selectValue(): number {
        return 0;
      }
      close = close;
    }
    const sqlite3 = {
      installOpfsSAHPoolVfs: async () => ({
        OpfsSAHPoolDb: FakeDb,
        pauseVfs,
      }),
    } as unknown as Sqlite3Static;
    const server = new SqliteWorkerServer(sqlite3);

    await server.open('held.db', 'opfs');
    server.releasePool();

    expect(close).toHaveBeenCalledOnce();
    expect(pauseVfs).toHaveBeenCalledOnce();
  });

  it('finishes pool retries before the default open timeout', () => {
    const retryTotal = POOL_RETRY_DELAYS_MS.reduce(
      (total, delay) => total + delay,
      0,
    );
    // The original 15.9s retry schedule could never beat the 15s timeout.
    expect(retryTotal + 1_000).toBeLessThan(DEFAULT_OPEN_TIMEOUT_MS);
  });

  it('stops retrying and retains the browser diagnostic', async () => {
    vi.useFakeTimers();
    const install = vi.fn(() => {
      const error = new Error('pool still locked');
      error.name = 'NoModificationAllowedError';
      return Promise.reject(error);
    });
    const sqlite3 = {
      installOpfsSAHPoolVfs: install,
    } as unknown as Sqlite3Static;
    const server = new SqliteWorkerServer(sqlite3);

    const opening = server.open('held.db', 'opfs');
    const rejection = expect(opening).rejects.toMatchObject({
      name: 'OpfsPoolHeldError',
      code: 'OPFS_POOL_HELD',
      diagnostic: 'NoModificationAllowedError: pool still locked',
    });
    await vi.runAllTimersAsync();
    await rejection;
    expect(install).toHaveBeenCalledTimes(7);
  });

  it('reconstructs the typed error at the caller boundary', async () => {
    let answer: ((message: unknown) => void) | undefined;
    const driver = new WebSqliteDriver({
      storage: 'memory',
      createEndpoint: () => ({
        addMessageListener: (listener) => {
          answer = listener;
        },
        postMessage: (message) => {
          const { id } = message as { id: number };
          queueMicrotask(() => {
            answer?.({
              id,
              ok: false,
              error: 'pool held',
              code: 'OPFS_POOL_HELD',
              diagnostic: 'NoModificationAllowedError: locked',
            });
          });
        },
      }),
    });

    const error = await driver
      .open('held.db')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpfsPoolHeldError);
    expect(error).toMatchObject({
      code: 'OPFS_POOL_HELD',
      diagnostic: 'NoModificationAllowedError: locked',
    });
  });
});
