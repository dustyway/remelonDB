/**
 * Adapter tests, not conformance. They cover what this package owns:
 * the mapping of the seam's seven methods onto expo-sqlite's async API,
 * against a mocked module. A mock does not implement SQLite, so the
 * query corpus, DDL and sanitization suites would be asserting against
 * the mock rather than a database. Running the real conformance suite
 * needs an Expo harness on a device lane (#43).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const statement = {
  executeAsync: vi.fn(async () => undefined),
  finalizeAsync: vi.fn(async () => undefined),
};

const database = {
  execAsync: vi.fn(async () => undefined),
  getFirstAsync: vi.fn(async () => ({ user_version: 0 })),
  getAllAsync: vi.fn(async () => [] as unknown[]),
  runAsync: vi.fn(async () => undefined),
  prepareAsync: vi.fn(async () => statement),
  withTransactionAsync: vi.fn(async (work: () => Promise<void>) => work()),
  closeAsync: vi.fn(async () => undefined),
};

// The signatures are written out so the toHaveBeenCalledWith assertions
// stay typed; the name itself is not needed by the fakes.
const openDatabaseAsync = vi.fn<(name: string) => Promise<typeof database>>(
  async () => database,
);
const deleteDatabaseAsync = vi.fn<(name: string) => Promise<undefined>>(
  async () => undefined,
);

vi.mock('expo-sqlite', () => ({
  openDatabaseAsync: (name: string) => openDatabaseAsync(name),
  deleteDatabaseAsync: (name: string) => deleteDatabaseAsync(name),
}));

const { RnSqliteDriver } = await import('./RnSqliteDriver');

const opened = async (name = 'app.db') => {
  const driver = new RnSqliteDriver();
  await driver.open(name);
  return driver;
};

beforeEach(() => {
  vi.clearAllMocks();
  database.getFirstAsync.mockResolvedValue({ user_version: 0 });
  database.prepareAsync.mockResolvedValue(statement);
  database.withTransactionAsync.mockImplementation(
    async (work: () => Promise<void>) => work(),
  );
});

describe('open', () => {
  it('opens by name, puts the journal in WAL, and reports user_version', async () => {
    database.getFirstAsync.mockResolvedValue({ user_version: 7 });

    const result = await new RnSqliteDriver().open('app.db');

    expect(openDatabaseAsync).toHaveBeenCalledWith('app.db');
    expect(database.execAsync).toHaveBeenCalledWith(
      'pragma journal_mode = WAL',
    );
    expect(result).toEqual({ userVersion: 7 });
  });

  it('reports version 0 when the pragma answers nothing', async () => {
    database.getFirstAsync.mockResolvedValue(null as never);

    expect(await new RnSqliteDriver().open('app.db')).toEqual({
      userVersion: 0,
    });
  });

  it('refuses to open twice, rather than dropping the first handle', async () => {
    const driver = await opened();

    await expect(driver.open('other.db')).rejects.toThrow('already open');
    expect(openDatabaseAsync).toHaveBeenCalledTimes(1);
  });
});

describe('the closed state', () => {
  it('rejects work after close instead of using a stale handle', async () => {
    const driver = await opened();
    await driver.close();

    expect(database.closeAsync).toHaveBeenCalledTimes(1);
    await expect(driver.query('select 1', [])).rejects.toThrow('not open');
    await expect(driver.execute('select 1', [])).rejects.toThrow('not open');
  });

  it('rejects work before the first open', async () => {
    await expect(new RnSqliteDriver().query('select 1', [])).rejects.toThrow(
      'not open',
    );
  });
});

describe('statements', () => {
  it('passes query sql and arguments through', async () => {
    const driver = await opened();
    database.getAllAsync.mockResolvedValue([{ id: 'a' }]);

    const rows = await driver.query('select * from t where id = ?', ['a']);

    expect(database.getAllAsync).toHaveBeenCalledWith(
      'select * from t where id = ?',
      ['a'],
    );
    expect(rows).toEqual([{ id: 'a' }]);
  });

  it('passes execute sql and arguments through', async () => {
    const driver = await opened();

    await driver.execute('insert into t values (?)', [1]);

    expect(database.runAsync).toHaveBeenCalledWith(
      'insert into t values (?)',
      [1],
    );
  });
});

describe('executeBatch', () => {
  it('runs inside one transaction, preparing each statement once', async () => {
    const driver = await opened();

    await driver.executeBatch([
      ['insert into t values (?)', [[1], [2]]],
      ['delete from t where id = ?', [[3]]],
    ]);

    expect(database.withTransactionAsync).toHaveBeenCalledTimes(1);
    expect(database.prepareAsync).toHaveBeenCalledTimes(2);
    expect(statement.executeAsync).toHaveBeenCalledTimes(3);
    expect(statement.executeAsync).toHaveBeenNthCalledWith(1, [1]);
    expect(statement.executeAsync).toHaveBeenNthCalledWith(3, [3]);
  });

  it('finalizes a statement whose execution failed', async () => {
    const driver = await opened();
    statement.executeAsync.mockRejectedValueOnce(new Error('constraint'));

    await expect(
      driver.executeBatch([['insert into t values (?)', [[1]]]]),
    ).rejects.toThrow('constraint');
    expect(statement.finalizeAsync).toHaveBeenCalledTimes(1);
  });
});

describe('setUserVersion', () => {
  it('writes the pragma', async () => {
    const driver = await opened();

    await driver.setUserVersion(3);

    expect(database.execAsync).toHaveBeenCalledWith('pragma user_version = 3');
  });

  it('refuses values that would be interpolated into the pragma', async () => {
    // The version cannot be bound, so it is checked rather than escaped.
    const driver = await opened();

    await expect(driver.setUserVersion(1.5)).rejects.toThrow('invalid');
    await expect(driver.setUserVersion(-1)).rejects.toThrow('invalid');
    expect(database.execAsync).toHaveBeenCalledTimes(1); // the WAL pragma only
  });
});

describe('destroy', () => {
  it('closes the handle and deletes the file', async () => {
    const driver = await opened('app.db');

    await driver.destroy();

    expect(database.closeAsync).toHaveBeenCalledTimes(1);
    expect(deleteDatabaseAsync).toHaveBeenCalledWith('app.db');
  });

  it('does not ask expo-sqlite to delete an in-memory database', async () => {
    const driver = await opened(':memory:');

    await driver.destroy();

    expect(database.closeAsync).toHaveBeenCalledTimes(1);
    expect(deleteDatabaseAsync).not.toHaveBeenCalled();
  });

  it('is safe on a driver that was never opened', async () => {
    await new RnSqliteDriver().destroy();

    expect(database.closeAsync).not.toHaveBeenCalled();
    expect(deleteDatabaseAsync).not.toHaveBeenCalled();
  });
});
