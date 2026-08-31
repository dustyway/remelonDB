import { afterEach, describe, expect, it, vi } from 'vitest';
import { appSchema, column as c, table } from '../schema/index';
import { Database } from './Database';
import type { SqliteDriver } from '../driver/SqliteDriver';

/**
 * `Database.open` probes the random source before it touches the driver.
 * A runtime that cannot create records must fail at startup, with no
 * database opened, rather than at its first save (docs/reference/runtimes.md).
 */
const realCrypto = globalThis.crypto;
const setCrypto = (value: unknown) =>
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true });

afterEach(() => setCrypto(realCrypto));

const schema = appSchema({
  version: 1,
  tables: [table('tasks', { name: c.string() })],
});

const driverThatMustNotOpen = () =>
  ({ open: vi.fn() }) as unknown as SqliteDriver & {
    open: ReturnType<typeof vi.fn>;
  };

describe('Database.open random-source probe', () => {
  it('rejects before driver.open when the runtime has no crypto', async () => {
    setCrypto(undefined);
    const driver = driverThatMustNotOpen();

    await expect(
      Database.open({ driver, schema, name: ':memory:' }),
    ).rejects.toThrow(/install a polyfill/);
    expect(driver.open).not.toHaveBeenCalled();
  });

  it('rejects before driver.open when the source is present but broken', async () => {
    const native = new Error("'RNGetRandomValues' could not be found");
    setCrypto({
      getRandomValues: () => {
        throw native;
      },
    });
    const driver = driverThatMustNotOpen();

    const rejection = Database.open({ driver, schema, name: ':memory:' });
    await expect(rejection).rejects.toThrow(/without rebuilding/);
    await expect(rejection).rejects.toMatchObject({ cause: native });
    expect(driver.open).not.toHaveBeenCalled();
  });
});
