/**
 * createDatabaseManager: concurrent inits share one open, failures
 * stay retryable, and a superseded attempt's onTakenOver can never
 * touch a newer database.
 */
import { describe, expect, it, vi } from 'vitest';
import { createDatabaseManager } from '../index';
import type { Database } from '../index';

/** A controllable open factory: resolve/reject per attempt, callbacks captured. */
const fakeOpen = () => {
  const attempts: Array<{
    resolve: (db: Database) => void;
    reject: (error: Error) => void;
    onTakenOver: () => void;
  }> = [];
  const open = vi.fn((onTakenOver: () => void) => {
    return new Promise<Database>((resolve, reject) => {
      attempts.push({ resolve, reject, onTakenOver });
    });
  });
  return { open, attempts };
};

const someDb = () => ({}) as Database;

/** A database whose close is observable. The manager closes through
 * Database.close, which drains the work the database accepted. */
const dbWithDriver = () => {
  const close = vi.fn(async () => {});
  return { db: { close } as unknown as Database, close };
};

describe('createDatabaseManager', () => {
  it('walks idle -> loading -> ready and serves the database', async () => {
    const { open, attempts } = fakeOpen();
    const manager = createDatabaseManager({ open });
    expect(manager.state.status).toBe('idle');
    expect(() => manager.database).toThrow(/not initialized/);

    const states: string[] = [];
    manager.subscribe((state) => states.push(state.status));
    expect(states).toEqual(['idle']); // current state emitted on subscribe

    const initPromise = manager.init();
    expect(manager.state.status).toBe('loading');

    const db = someDb();
    attempts[0]!.resolve(db);
    expect(await initPromise).toBe(db);
    expect(manager.state.status).toBe('ready');
    expect(manager.database).toBe(db);
    expect(states).toEqual(['idle', 'loading', 'ready']);
  });

  it('deduplicates concurrent init: one open, shared result', async () => {
    const { open, attempts } = fakeOpen();
    const manager = createDatabaseManager({ open });
    const first = manager.init();
    const second = manager.init(); // double-clicked retry, second caller, ...
    expect(open).toHaveBeenCalledTimes(1);

    const db = someDb();
    attempts[0]!.resolve(db);
    expect(await first).toBe(db);
    expect(await second).toBe(db);

    // ready: further init calls return the same database without opening
    expect(await manager.init()).toBe(db);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('a failed open is retryable, not cached forever', async () => {
    const { open, attempts } = fakeOpen();
    const manager = createDatabaseManager({ open });

    const first = manager.init();
    attempts[0]!.reject(new Error('no storage'));
    await expect(first).rejects.toThrow('no storage');
    expect(manager.state.status).toBe('error');
    expect(manager.state.error?.message).toBe('no storage');

    const second = manager.init(); // the Retry button
    expect(open).toHaveBeenCalledTimes(2);
    const db = someDb();
    attempts[1]!.resolve(db);
    expect(await second).toBe(db);
    expect(manager.state.status).toBe('ready');
  });

  it('takeover flips the state and revokes the database', async () => {
    const { open, attempts } = fakeOpen();
    const manager = createDatabaseManager({ open });
    const init = manager.init();
    attempts[0]!.resolve(someDb());
    await init;

    attempts[0]!.onTakenOver();
    expect(manager.state.status).toBe('taken-over');
    expect(() => manager.database).toThrow(/taken over/);
  });

  it('a stale attempt cannot clobber a healthy database (epoch currency)', async () => {
    const { open, attempts } = fakeOpen();
    const manager = createDatabaseManager({ open });

    // first life: open, get taken over
    const first = manager.init();
    attempts[0]!.resolve(someDb());
    await first;
    attempts[0]!.onTakenOver();
    expect(manager.state.status).toBe('taken-over');

    // second life: reclaim ("use here instead")
    const second = manager.init();
    expect(open).toHaveBeenCalledTimes(2);
    const db2 = someDb();
    attempts[1]!.resolve(db2);
    await second;
    expect(manager.state.status).toBe('ready');

    // the FIRST life's callback fires late — it must be ignored
    attempts[0]!.onTakenOver();
    expect(manager.state.status).toBe('ready');
    expect(manager.database).toBe(db2);
  });
});

describe('close()', () => {
  it('tears down the open database and returns to idle', async () => {
    const { open, attempts } = fakeOpen();
    const manager = createDatabaseManager({ open });
    const init = manager.init();
    const { db, close } = dbWithDriver();
    attempts[0]!.resolve(db);
    await init;

    await manager.close();

    expect(close).toHaveBeenCalledTimes(1);
    expect(manager.state.status).toBe('idle');
    expect(() => manager.database).toThrow(/not initialized/);
  });

  it('discards a late-resolving open with cleanup (the delayed-init race)', async () => {
    const { open, attempts } = fakeOpen();
    const manager = createDatabaseManager({ open });
    const init = manager.init();

    const closing = manager.close(); // logout while the open is in flight
    expect(manager.state.status).toBe('idle'); // state clears at once

    const { db, close } = dbWithDriver();
    attempts[0]!.resolve(db); // ...and now it arrives

    await closing; // close waits for the late arrival's cleanup
    await expect(init).rejects.toThrow(/closed/);
    expect(close).toHaveBeenCalledTimes(1); // the late arrival was cleaned up
    expect(manager.state.status).toBe('idle');
    expect(() => manager.database).toThrow(/not initialized/);
  });

  it('a rejection landing after close stays quiet', async () => {
    const { open, attempts } = fakeOpen();
    const manager = createDatabaseManager({ open });
    const init = manager.init();
    const closing = manager.close();
    attempts[0]!.reject(new Error('boom'));
    await closing;
    await expect(init).rejects.toThrow('boom');
    expect(manager.state.status).toBe('idle'); // not error: nobody owns it
  });

  it('is idempotent, and a no-op when idle', async () => {
    const { open } = fakeOpen();
    const manager = createDatabaseManager({ open });
    await manager.close();
    await manager.close();
    expect(manager.state.status).toBe('idle');
    expect(open).not.toHaveBeenCalled();
  });

  it('re-init after close opens fresh (re-login)', async () => {
    const { open, attempts } = fakeOpen();
    const manager = createDatabaseManager({ open });
    const first = manager.init();
    const a = dbWithDriver();
    attempts[0]!.resolve(a.db);
    await first;
    await manager.close();

    const second = manager.init();
    expect(open).toHaveBeenCalledTimes(2);
    const b = dbWithDriver();
    attempts[1]!.resolve(b.db);
    expect(await second).toBe(b.db);
    expect(manager.database).toBe(b.db);
    expect(manager.state.status).toBe('ready');
  });
});

/**
 * The logout/re-login race: close() used to resolve while an open it
 * owned could still produce a database, and that database's teardown
 * was detached, so the owner had nothing to wait for before opening the
 * same file again.
 */
describe('close() during a pending open', () => {
  /** A database whose driver close the test settles by hand. */
  const slowDb = () => {
    let settle!: (failure?: Error) => void;
    const closed = new Promise<void>((resolve, reject) => {
      settle = (failure?: Error) => {
        failure ? reject(failure) : resolve();
      };
    });
    const close = vi.fn(() => closed);
    return {
      db: { close } as unknown as Database,
      close,
      finishClose: settle,
    };
  };

  /** Let pending microtasks run without settling anything of our own. */
  const settleMicrotasks = () =>
    new Promise((resolve) => setTimeout(resolve, 0));

  it('stays pending until the open lands', async () => {
    const { open, attempts } = fakeOpen();
    const manager = createDatabaseManager({ open });
    void manager.init();

    let closed = false;
    const closing = manager.close().then(() => {
      closed = true;
    });

    await settleMicrotasks();
    expect(closed).toBe(false); // the open has not landed yet

    attempts[0]!.resolve(dbWithDriver().db);
    await closing;
    expect(closed).toBe(true);
  });

  it('closes the late database before it resolves', async () => {
    const { open, attempts } = fakeOpen();
    const manager = createDatabaseManager({ open });
    const init = manager.init();

    const closing = manager.close();
    const late = slowDb();
    attempts[0]!.resolve(late.db);

    await settleMicrotasks();
    expect(late.close).toHaveBeenCalledTimes(1);
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await settleMicrotasks();
    expect(closed).toBe(false); // still tearing the late database down

    late.finishClose();
    await closing;
    await expect(init).rejects.toThrow(/closed during initialization/);
  });

  it('waits for an open that fails, then resolves', async () => {
    const { open, attempts } = fakeOpen();
    const manager = createDatabaseManager({ open });
    const init = manager.init();

    const closing = manager.close();
    attempts[0]!.reject(new Error('open failed'));

    await expect(closing).resolves.toBeUndefined();
    await expect(init).rejects.toThrow('open failed');
    expect(manager.state.status).toBe('idle');
  });

  it('reports a failed teardown of the late database', async () => {
    const { open, attempts } = fakeOpen();
    const manager = createDatabaseManager({ open });
    const init = manager.init();

    const closing = manager.close();
    const late = slowDb();
    attempts[0]!.resolve(late.db);
    await settleMicrotasks();
    late.finishClose(new Error('driver refused to close'));

    // close() owns the teardown failure; init() keeps its own error.
    await expect(closing).rejects.toThrow(/refused to close/);
    await expect(init).rejects.toThrow(/closed during initialization/);
    // The database may well still be open, so a later close() must not
    // answer with a clean resolve it cannot back up.
    await expect(manager.close()).rejects.toThrow(/refused to close/);
  });

  it('gives concurrent calls the same teardown, not an early resolve', async () => {
    const { open, attempts } = fakeOpen();
    const manager = createDatabaseManager({ open });
    const init = manager.init();
    const late = slowDb();

    const first = manager.close();
    // A second caller — a retry, or an owner unsure whether it already
    // closed — must not get a promise that resolves while the teardown
    // is still running.
    const second = manager.close();
    let secondResolved = false;
    void second.then(() => {
      secondResolved = true;
    });

    attempts[0]!.resolve(late.db);
    await settleMicrotasks();
    expect(secondResolved).toBe(false);

    late.finishClose();
    await Promise.all([first, second]);
    expect(secondResolved).toBe(true);
    expect(late.close).toHaveBeenCalledTimes(1);
    await expect(init).rejects.toThrow(/closed during initialization/);
  });

  it('refuses to re-open while a close is running', async () => {
    const { open, attempts } = fakeOpen();
    const manager = createDatabaseManager({ open });
    void manager.init();

    const closing = manager.close(); // still waiting on the pending open
    // Opening here would ask the manager to sequence itself against its
    // own teardown. A spent manager is replaced, not reused.
    await expect(manager.init()).rejects.toThrow(/closing or failed to close/);
    expect(open).toHaveBeenCalledTimes(1);

    attempts[0]!.resolve(dbWithDriver().db);
    await closing;
  });

  it('stays spent after a failed close, rather than half-reopening', async () => {
    const { open, attempts } = fakeOpen();
    const manager = createDatabaseManager({ open });
    const init = manager.init();

    const closing = manager.close();
    const late = slowDb();
    attempts[0]!.resolve(late.db);
    await settleMicrotasks();
    late.finishClose(new Error('driver refused to close'));

    await expect(closing).rejects.toThrow(/refused to close/);
    await expect(init).rejects.toThrow(/closed during initialization/);

    // Re-opening would strand that database: a later close() answers
    // with the old failure and would never reach the new driver.
    await expect(manager.init()).rejects.toThrow(/closing or failed to close/);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('refuses an init() issued from the idle notification itself', async () => {
    const { open, attempts } = fakeOpen();
    const manager = createDatabaseManager({ open });
    const init = manager.init();
    attempts[0]!.resolve(dbWithDriver().db);
    await init;

    // A subscriber that reacts to `idle` by reopening (a banner, a
    // retry loop) runs synchronously inside close(). The guard has to
    // be in place before that notification, or this init() opens a
    // second database under the close that just started.
    let reopen: Promise<Database> | null = null;
    manager.subscribe((state) => {
      if (state.status === 'idle' && !reopen) {
        reopen = manager.init();
      }
    });
    reopen = null; // the subscribe-time emission was 'ready', not idle

    await manager.close();
    expect(reopen).not.toBeNull();
    await expect(reopen).rejects.toThrow(/closing or failed to close/);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
