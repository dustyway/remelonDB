/**
 * Two clients cold-opening the same database concurrently (two tabs on
 * a fresh origin, remelonDB#3's last leg): both see user_version 0 and
 * both attempt setup. The winner's setup commits atomically; the loser
 * collides, re-checks the version, and joins the winner's world instead
 * of surfacing "table already exists" to a user.
 */
import { describe, expect, it, vi } from 'vitest';
import { appSchema, column as c, table } from '../schema/index';
import { Database } from './Database';
import type { SqliteDriver } from '../driver/SqliteDriver';

const schema = appSchema({
  version: 3,
  tables: [table('tasks', { name: c.string() })],
});

/** A driver whose setup batch fails like a DDL collision, with the
 * version afterwards reading as the winner's. */
const loserDriver = () => {
  let version = 0;
  const executeBatch = vi.fn(async () => {
    // the other client's atomic setup committed first
    version = schema.version;
    throw new Error('SQLITE_ERROR: table "tasks" already exists');
  });
  const driver = {
    open: async () => ({ userVersion: 0 }),
    query: vi.fn(async (sql: string) =>
      sql.includes('user_version') ? [{ user_version: version }] : [],
    ),
    execute: async () => {},
    executeBatch,
    setUserVersion: vi.fn(async () => {}),
    close: async () => {},
    destroy: async () => {},
  } as unknown as SqliteDriver;
  return { driver, executeBatch };
};

describe('concurrent first open', () => {
  it("the losing client accepts the winner's setup instead of failing", async () => {
    const { driver, executeBatch } = loserDriver();
    const db = await Database.open({ driver, schema, name: 'race.db' });
    expect(db).toBeDefined();
    expect(executeBatch).toHaveBeenCalledTimes(1);
  });

  it('an unrelated setup failure still surfaces', async () => {
    const { driver } = loserDriver();
    // version stays 0: the collision explanation does not hold
    (driver.query as ReturnType<typeof vi.fn>).mockImplementation(async () => [
      { user_version: 0 },
    ]);
    await expect(
      Database.open({ driver, schema, name: 'race.db' }),
    ).rejects.toThrow(/already exists/);
  });

  it('setup ships DDL and version stamp in one atomic batch', async () => {
    let batch: readonly (readonly [string, unknown])[] = [];
    const driver = {
      open: async () => ({ userVersion: 0 }),
      query: async () => [],
      execute: async () => {},
      executeBatch: vi.fn(async (statements: typeof batch) => {
        batch = statements;
      }),
      setUserVersion: vi.fn(async () => {}),
      close: async () => {},
      destroy: async () => {},
    } as unknown as SqliteDriver;
    await Database.open({ driver, schema, name: 'atomic.db' });
    const sqls = batch.map(([sql]) => sql);
    expect(sqls.some((sql) => /user_version\s*=\s*3/.test(sql))).toBe(true);
  });
});
