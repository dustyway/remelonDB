/**
 * Database.close: work the database already accepted finishes before the
 * driver goes away. Two phases, because a query or local-storage call
 * can legitimately be issued from inside an accepted read/write block —
 * refusing direct operations the moment close is requested would abandon
 * the very block close promised to finish.
 */
import { describe, expect, it, vi } from 'vitest';
import { appSchema, column as c, table } from '../schema/index';
import { Database } from './Database';
import type { Row, SqliteDriver } from '../driver/SqliteDriver';

const tasks = table('tasks', { name: c.string() });
const schema = appSchema({ version: 1, tables: [tasks] });

/** A deferred whose settle the test calls. */
const deferred = <T = void>() => {
  let settle!: (value: T) => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, settle, fail };
};

/** Let queued microtasks run without settling anything of our own. */
const settleMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * An already-migrated driver. `query` resolves [] unless a test takes
 * control of it, and `close` settles when the test says.
 */
const fakeDriver = (options: { withWorkSlot?: boolean } = {}) => {
  const closed = deferred();
  const close = vi.fn(() => closed.promise);
  const query = vi.fn(async (): Promise<Row[]> => []);
  const execute = vi.fn(async () => {});
  const slotGrant = deferred();
  const release = vi.fn(async () => {});
  const driver = {
    open: vi.fn(async () => ({ userVersion: schema.version })),
    close,
    query,
    execute,
    executeBatch: vi.fn(async () => {}),
    setUserVersion: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
    ...(options.withWorkSlot
      ? {
          acquireWorkSlot: vi.fn(async () => {
            await slotGrant.promise;
            return release;
          }),
        }
      : {}),
  } as unknown as SqliteDriver;
  return {
    driver,
    close,
    query,
    execute,
    release,
    finishClose: closed.settle,
    failClose: closed.fail,
    grantSlot: slotGrant.settle,
  };
};

const openDb = (fake: ReturnType<typeof fakeDriver>) =>
  Database.open({ driver: fake.driver, schema, name: 'close.db' });

describe('Database.close drains accepted work', () => {
  it('waits for a running write', async () => {
    const fake = fakeDriver();
    const db = await openDb(fake);
    const gate = deferred();
    const writing = db.write(async () => {
      await gate.promise;
    });

    const closing = db.close();
    await settleMicrotasks();
    expect(fake.close).not.toHaveBeenCalled();

    gate.settle();
    await writing;
    await settleMicrotasks();
    fake.finishClose();
    await closing;
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('waits for a running read', async () => {
    const fake = fakeDriver();
    const db = await openDb(fake);
    const gate = deferred();
    const reading = db.read(async () => {
      await gate.promise;
    });

    const closing = db.close();
    await settleMicrotasks();
    expect(fake.close).not.toHaveBeenCalled();

    gate.settle();
    await reading;
    await settleMicrotasks();
    fake.finishClose();
    await closing;
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('waits for work parked in acquireWorkSlot, and for its release', async () => {
    const fake = fakeDriver({ withWorkSlot: true });
    const db = await openDb(fake);
    // Parked before the queue: the slot has not been granted yet, so
    // nothing about this block is visible to the queue.
    const writing = db.write(async () => {});

    const closing = db.close();
    await settleMicrotasks();
    expect(fake.close).not.toHaveBeenCalled();

    fake.grantSlot();
    await writing;
    await settleMicrotasks();
    expect(fake.release).toHaveBeenCalledTimes(1);
    fake.finishClose();
    await closing;
    expect(fake.close).toHaveBeenCalledTimes(1);
    // the slot was released before the driver went away
    expect(fake.release.mock.invocationCallOrder[0]).toBeLessThan(
      fake.close.mock.invocationCallOrder[0]!,
    );
  });

  it('refuses new read, write, and external changes once close is requested', async () => {
    const fake = fakeDriver();
    const db = await openDb(fake);
    const closing = db.close();

    await expect(db.write(async () => 1)).rejects.toThrow(/closing/);
    await expect(db.read(async () => 1)).rejects.toThrow(/closing/);
    await expect(db.applyExternalChanges({})).rejects.toThrow(/closing/);
    expect(fake.execute).not.toHaveBeenCalled();

    fake.finishClose();
    await closing;
  });
});

describe('Database.close drains direct core work', () => {
  it('waits for a query already in flight', async () => {
    const fake = fakeDriver();
    const db = await openDb(fake);
    const rows = deferred<Row[]>();
    fake.query.mockImplementationOnce(() => rows.promise);

    const fetching = db.get(tasks).query().fetch();
    const closing = db.close();
    await settleMicrotasks();
    expect(fake.close).not.toHaveBeenCalled();

    rows.settle([]);
    await fetching;
    await settleMicrotasks();
    fake.finishClose();
    await closing;
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('waits for a local-storage read already in flight', async () => {
    const fake = fakeDriver();
    const db = await openDb(fake);
    const rows = deferred<Row[]>();
    fake.query.mockImplementationOnce(() => rows.promise);

    const reading = db.localStorage.get('cursor');
    const closing = db.close();
    await settleMicrotasks();
    expect(fake.close).not.toHaveBeenCalled();

    rows.settle([]);
    await reading;
    await settleMicrotasks();
    fake.finishClose();
    await closing;
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('lets an accepted write finish work it starts after close was requested', async () => {
    const fake = fakeDriver();
    const db = await openDb(fake);
    const gate = deferred();
    // The write is accepted before close. It issues a direct operation
    // afterwards, which must be allowed: close promised to finish this
    // block, and core cannot tell this call from an unrelated one.
    const writing = db.write(async () => {
      await gate.promise;
      return db.localStorage.get('inside');
    });

    const closing = db.close();
    await settleMicrotasks();
    gate.settle();

    await expect(writing).resolves.toBeNull();
    await settleMicrotasks();
    fake.finishClose();
    await closing;
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('refuses a direct operation started after teardown begins', async () => {
    const fake = fakeDriver();
    const db = await openDb(fake);
    const rows = deferred<Row[]>();
    fake.query.mockImplementationOnce(() => rows.promise);

    // In flight when close is requested: teardown starts and waits for it.
    const inFlight = db.localStorage.get('cursor');
    const closing = db.close();
    await settleMicrotasks();

    await expect(db.localStorage.get('other')).rejects.toThrow(/closing/);
    await expect(db.get(tasks).query().fetch()).rejects.toThrow(/closing/);

    rows.settle([]);
    await inFlight;
    await settleMicrotasks();
    fake.finishClose();
    await closing;
  });
});

describe('Database.close is one teardown', () => {
  it('shares one driver close between concurrent calls', async () => {
    const fake = fakeDriver();
    const db = await openDb(fake);

    const first = db.close();
    const second = db.close();
    await settleMicrotasks();
    fake.finishClose();
    await Promise.all([first, second]);

    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed teardown as the answer for later calls', async () => {
    const fake = fakeDriver();
    const db = await openDb(fake);

    const closing = db.close();
    await settleMicrotasks();
    fake.failClose(new Error('driver refused to close'));

    await expect(closing).rejects.toThrow(/refused to close/);
    // The driver may well still be open; a clean resolve would be a lie.
    await expect(db.close()).rejects.toThrow(/refused to close/);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });
});
