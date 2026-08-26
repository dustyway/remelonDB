// @vitest-environment jsdom
/**
 * useSessionDatabase over *real* managers. The managers come from
 * createDatabaseManager with a hand-driven open, so DatabaseManager's
 * epoch and late-open rules are part of what is under test. A fake
 * manager whose init() resolves at once hides the case this hook most
 * has to get right: a logout while an open is still pending.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createElement, StrictMode } from 'react';
import type { ReactNode } from 'react';
import { createDatabaseManager } from '../index';
import type { Database, SyncController } from '../index';

// The hook builds its controller through these; capture what it makes.
const controllers: Array<{
  start: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  runSyncOptions: unknown;
}> = [];

vi.mock('../index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../index')>();
  return {
    ...actual,
    createRunSync: (options: unknown) => options,
    createSyncController: (options: { runSync: unknown }) => {
      const controller = {
        start: vi.fn(),
        dispose: vi.fn(),
        runSyncOptions: options.runSync,
      };
      controllers.push(controller);
      return controller as unknown as SyncController;
    },
  };
});

const { useSessionDatabase } = await import('./index');

const tick = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

/** A database whose close the test settles by hand. */
const makeDatabase = (tag: string) => {
  let release!: () => void;
  let fail!: (error: Error) => void;
  const held = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  let hold = false;
  const close = vi.fn(() => (hold ? held : Promise.resolve()));
  return {
    close,
    holdClose: () => {
      hold = true;
    },
    releaseClose: release,
    failClose: fail,
    database: { tag, close } as unknown as Database,
  };
};

/** A real manager whose open the test resolves or rejects by hand. */
const makeManager = (tag: string) => {
  const db = makeDatabase(tag);
  const opens: Array<{
    resolve: (database: Database) => void;
    reject: (error: Error) => void;
  }> = [];
  let takeOver: (() => void) | null = null;
  const open = vi.fn(
    (onTakenOver: () => void) =>
      new Promise<Database>((resolve, reject) => {
        takeOver = onTakenOver;
        opens.push({ resolve, reject });
      }),
  );
  const second = makeDatabase(`${tag}-2`);
  return {
    tag,
    db,
    second,
    takeOver: async () => {
      takeOver?.();
      await tick();
    },
    manager: createDatabaseManager({ open }),
    openCount: () => open.mock.calls.length,
    ready: async (which = 0) => {
      opens[which]!.resolve(db.database);
      await tick();
      return db.database;
    },
    resolveWith: (database: Database, which = 0) => {
      opens[which]!.resolve(database);
    },
    failOpen: async (message = 'no storage', which = 0) => {
      opens[which]!.reject(new Error(message));
      await tick();
    },
  };
};

const renderSession = (
  managers: ReturnType<typeof makeManager>[],
  initialUserId: string | null,
  options: { strict?: boolean } = {},
) => {
  let made = 0;
  const createManager = vi.fn(() => managers[made++]!.manager);
  const wrapper = options.strict
    ? ({ children }: { children: ReactNode }) =>
        createElement(StrictMode, null, children)
    : undefined;
  const view = renderHook(
    ({ userId }: { userId: string | null }) =>
      useSessionDatabase({
        userId,
        createManager,
        sync: { pullChanges: 'p', pushChanges: 'q' } as never,
        controller: { intervalMs: null },
      }),
    {
      initialProps: { userId: initialUserId },
      ...(wrapper ? { wrapper } : {}),
    },
  );
  return { view, createManager };
};

beforeEach(() => {
  controllers.length = 0;
});

describe('useSessionDatabase', () => {
  it('opens nothing without a user', () => {
    const { view, createManager } = renderSession([makeManager('a')], null);
    expect(view.result.current.manager).toBeNull();
    expect(view.result.current.syncController).toBeNull();
    expect(createManager).not.toHaveBeenCalled();
  });

  it('creates a manager and opens it for the signed-in user', async () => {
    const a = makeManager('a');
    const { view, createManager } = renderSession([a], 'user-a');
    await tick();

    expect(createManager).toHaveBeenCalledWith('user-a');
    expect(a.openCount()).toBe(1);
    expect(view.result.current.manager).toBe(a.manager);
  });

  it('attaches sync once the database is ready', async () => {
    const a = makeManager('a');
    const { view } = renderSession([a], 'user-a');
    await tick();
    expect(view.result.current.syncController).toBeNull();

    const database = await a.ready();

    expect(controllers).toHaveLength(1);
    expect(controllers[0]!.start).toHaveBeenCalledTimes(1);
    expect(view.result.current.syncController).toBe(controllers[0]);
    expect(controllers[0]!.runSyncOptions).toMatchObject({ database });
  });

  it('attaches sync when something else recovers the database', async () => {
    const a = makeManager('a');
    const { view } = renderSession([a], 'user-a');
    await tick();
    await a.failOpen();
    expect(controllers).toHaveLength(0);
    expect(a.manager.state.status).toBe('error');

    // an error banner's Retry calls init() on the manager itself
    await act(async () => {
      void a.manager.init();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await a.ready(1);

    expect(controllers).toHaveLength(1);
    expect(controllers[0]!.start).toHaveBeenCalledTimes(1);
    expect(view.result.current.syncController).toBe(controllers[0]);
  });

  it('disposes sync before closing, on a session change', async () => {
    const a = makeManager('a');
    const b = makeManager('b');
    const { view } = renderSession([a, b], 'user-a');
    await tick();
    await a.ready();

    view.rerender({ userId: 'user-b' });
    await tick();

    expect(controllers[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(a.db.close).toHaveBeenCalledTimes(1);
    expect(controllers[0]!.dispose.mock.invocationCallOrder[0]!).toBeLessThan(
      a.db.close.mock.invocationCallOrder[0]!,
    );
  });

  it('closes at once when the session ends during a pending open', async () => {
    const a = makeManager('a');
    const { view } = renderSession([a, makeManager('b')], 'user-a');
    await tick();
    expect(a.openCount()).toBe(1); // in flight, never resolved

    view.rerender({ userId: null });
    await tick();

    // close() is what invalidates that open. Queueing the close behind
    // it would let the database arrive with nobody to close it.
    expect(a.manager.state.status).toBe('idle');
    await a.ready();
    expect(a.db.close).toHaveBeenCalledTimes(1);
    expect(view.result.current.manager).toBeNull();
  });

  it('does not create the next manager until the previous close finishes', async () => {
    const a = makeManager('a');
    const b = makeManager('b');
    a.db.holdClose();
    const { view, createManager } = renderSession([a, b], 'user-a');
    await tick();
    await a.ready();

    view.rerender({ userId: 'user-b' });
    await tick();

    // Not merely un-opened: not created at all. A caller handed the
    // manager could call init() on it and step around this wait.
    expect(createManager).toHaveBeenCalledTimes(1);
    expect(b.openCount()).toBe(0);
    expect(view.result.current.manager).toBeNull();

    await act(async () => {
      a.db.releaseClose();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(createManager).toHaveBeenCalledTimes(2);
    expect(b.openCount()).toBe(1);
    expect(view.result.current.manager).toBe(b.manager);
  });

  it('never hands out the previous account on the render after a switch', async () => {
    const a = makeManager('a');
    const { view } = renderSession([a, makeManager('b')], 'user-a');
    await tick();
    await a.ready();
    expect(view.result.current.manager).toBe(a.manager);

    view.rerender({ userId: 'user-b' });
    expect(view.result.current.manager === a.manager).toBe(false);
    expect(view.result.current.syncController).toBeNull();
  });

  it('rebuilds the controller when the database is revoked and reclaimed', async () => {
    const a = makeManager('a');
    const { view } = renderSession([a], 'user-a');
    await tick();
    const first = await a.ready();
    expect(controllers).toHaveLength(1);

    // another tab takes the database over: the manager revokes it
    await a.takeOver();
    expect(a.manager.state.status).toBe('taken-over');
    expect(controllers[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(view.result.current.syncController).toBeNull();

    // reclaiming opens again, and hands back a different Database
    await act(async () => {
      void a.manager.init();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      a.resolveWith(a.second.database, 1);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(controllers).toHaveLength(2);
    expect(controllers[1]!.runSyncOptions).toMatchObject({
      database: a.second.database,
    });
    expect(controllers[1]!.runSyncOptions).not.toMatchObject({
      database: first,
    });
    expect(view.result.current.syncController).toBe(controllers[1]);
  });

  it('reports a close that fails on logout, with no next session to carry it', async () => {
    const a = makeManager('a');
    a.db.holdClose();
    const { view } = renderSession([a], 'user-a');
    await tick();
    await a.ready();

    view.rerender({ userId: null });
    await tick();
    await act(async () => {
      a.db.failClose(new Error('driver refused to close'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Nothing follows a logout, so the failure has to surface here or
    // nowhere.
    expect(view.result.current.closeError?.message).toMatch(/refused to close/);
    expect(view.result.current.manager).toBeNull();
  });

  it('closes the database and clears state on logout', async () => {
    const a = makeManager('a');
    const { view } = renderSession([a], 'user-a');
    await tick();
    await a.ready();

    view.rerender({ userId: null });
    await tick();

    expect(controllers[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(a.db.close).toHaveBeenCalledTimes(1);
    expect(view.result.current.manager).toBeNull();
    expect(view.result.current.syncController).toBeNull();
  });

  it('refuses a replacement after a close that failed', async () => {
    const a = makeManager('a');
    const b = makeManager('b');
    a.db.holdClose();
    const { view, createManager } = renderSession([a, b], 'user-a');
    await tick();
    await a.ready();

    view.rerender({ userId: 'user-b' });
    await tick();
    await act(async () => {
      a.db.failClose(new Error('driver refused to close'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // That database may still be open. A second one over the same file
    // is what this hook exists to prevent, so it reports instead.
    expect(createManager).toHaveBeenCalledTimes(1);
    expect(b.openCount()).toBe(0);
    expect(view.result.current.manager).toBeNull();
    expect(view.result.current.closeError?.message).toMatch(/refused to close/);
  });

  it('keeps refusing on the session after that', async () => {
    const a = makeManager('a');
    a.db.holdClose();
    const { view, createManager } = renderSession(
      [a, makeManager('b'), makeManager('c')],
      'user-a',
    );
    await tick();
    await a.ready();

    view.rerender({ userId: 'user-b' });
    await tick();
    await act(async () => {
      a.db.failClose(new Error('driver refused to close'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    view.rerender({ userId: 'user-c' });
    await tick();

    expect(createManager).toHaveBeenCalledTimes(1);
    expect(view.result.current.manager).toBeNull();
    expect(view.result.current.closeError).not.toBeNull();
  });

  it('ignores a database that becomes ready after cleanup', async () => {
    const a = makeManager('a');
    const { view } = renderSession([a], 'user-a');
    await tick();

    view.rerender({ userId: null });
    await tick();
    await a.ready();

    expect(controllers).toHaveLength(0);
    expect(view.result.current.syncController).toBeNull();
  });

  it('opens one database under StrictMode', async () => {
    const a = makeManager('a');
    const { view, createManager } = renderSession(
      [a, makeManager('b')],
      'user-a',
      { strict: true },
    );
    await tick();
    await a.ready();

    // React's development-only double effect does not run in this
    // build, so this checks only that StrictMode changes nothing: one
    // manager, one controller, nothing closed. The cleanup-and-restart
    // it would produce goes through the close tail, covered by 'does
    // not create the next manager until the previous close finishes',
    // and by the cancellation covered in 'ignores a database that
    // becomes ready after cleanup'.
    expect(createManager).toHaveBeenCalledTimes(1);
    expect(a.db.close).not.toHaveBeenCalled();
    expect(controllers).toHaveLength(1);
    expect(view.result.current.manager).toBe(a.manager);
  });

  it('does not restart the session when option identity changes', async () => {
    const a = makeManager('a');
    const managers = [a, makeManager('b')];
    let made = 0;
    const view = renderHook(
      ({ userId, tag }: { userId: string; tag: string }) =>
        useSessionDatabase({
          userId,
          createManager: () => managers[made++]!.manager,
          // a fresh object literal every render
          sync: { pullChanges: tag, pushChanges: tag } as never,
          controller: { intervalMs: null },
        }),
      { initialProps: { userId: 'user-a', tag: 'one' } },
    );
    await tick();
    await a.ready();
    expect(made).toBe(1);

    view.rerender({ userId: 'user-a', tag: 'two' });
    await tick();

    expect(made).toBe(1);
    expect(a.db.close).not.toHaveBeenCalled();
    expect(view.result.current.manager).toBe(a.manager);
  });

  it('keeps the same database across re-renders with the same session', async () => {
    const a = makeManager('a');
    const { view, createManager } = renderSession([a], 'user-a');
    await tick();
    await a.ready();

    // what a route change under a stable owner looks like
    view.rerender({ userId: 'user-a' });
    view.rerender({ userId: 'user-a' });
    await tick();

    expect(createManager).toHaveBeenCalledTimes(1);
    expect(a.db.close).not.toHaveBeenCalled();
    expect(view.result.current.manager).toBe(a.manager);
  });
});
