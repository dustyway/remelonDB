import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncTransportError } from '../transport/index';
import { createSyncController, type RunSyncResult } from './controller';

const ok: RunSyncResult = { resynced: false, rejected: 0, rejectedRecords: {} };

describe('sync controller', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = (runSync: (signal?: AbortSignal) => Promise<RunSyncResult>) => {
    const run = vi.fn(runSync);
    const triggerFire: { current: (() => void) | null } = { current: null };
    const controller = createSyncController({
      runSync: run,
      intervalMs: 60_000,
      debounceMs: 2_000,
      triggers: (fire) => {
        triggerFire.current = fire;
        return () => {
          triggerFire.current = null;
        };
      },
    });
    return { controller, run, triggerFire };
  };

  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  it('syncNow waits for success and returns the completed result', async () => {
    let release!: (result: RunSyncResult) => void;
    const { controller } = make(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const settled = vi.fn();
    const result = { ...ok, rejected: 1, rejectedRecords: { tasks: ['t1'] } };
    const promise = controller.syncNow();
    void promise.then(settled);
    await flush();
    expect(settled).not.toHaveBeenCalled();
    release(result);
    await expect(promise).resolves.toMatchObject({
      status: 'idle',
      lastResult: result,
    });
    expect((await promise).lastSyncAt).not.toBeNull();
  });

  it.each([
    [new Error('failed'), 'error'],
    [new SyncTransportError('offline'), 'offline'],
  ])(
    'syncNow resolves after %s instead of rejecting',
    async (error, status) => {
      const { controller } = make(async () => {
        throw error;
      });
      await expect(controller.syncNow()).resolves.toMatchObject({
        status,
        cause: error,
      });
    },
  );

  it('calls during a run share its follow-up and each run returns its own outcome', async () => {
    const releases: ((result: RunSyncResult) => void)[] = [];
    const { controller, run } = make(
      () =>
        new Promise((resolve) => {
          releases.push(resolve);
        }),
    );
    const first = controller.syncNow();
    const second = controller.syncNow();
    const third = controller.syncNow();
    expect(second).toBe(third);
    const settled = vi.fn();
    void second.then(settled);
    expect(run).toHaveBeenCalledTimes(1);
    releases[0]!(ok);
    await expect(first).resolves.toMatchObject({
      status: 'idle',
      lastResult: ok,
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(controller.state.status).toBe('syncing');
    expect(settled).not.toHaveBeenCalled();
    const recovered = { ...ok, resynced: true };
    releases[1]!(recovered);
    await expect(second).resolves.toMatchObject({
      status: 'resync-required',
      lastResult: recovered,
    });
    expect(await third).toBe(await second);
    expect((await first).status).toBe('idle');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('a synchronous runSync failure also resolves with an error outcome', async () => {
    const error = new Error('failed before returning a promise');
    const { controller } = make(() => {
      throw error;
    });
    await expect(controller.syncNow()).resolves.toMatchObject({
      status: 'error',
      cause: error,
    });
  });

  it('disposal resolves active and queued waiters even when the run ignores abort', async () => {
    const { controller, run } = make(() => new Promise(() => {}));
    const first = controller.syncNow();
    const second = controller.syncNow();
    controller.dispose();
    await expect(first).resolves.toBe(controller.state);
    await expect(second).resolves.toBe(controller.state);
    await expect(controller.syncNow()).resolves.toBe(controller.state);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a disposed idle controller resolves immediately without syncing', async () => {
    const { controller, run } = make(async () => ok);
    controller.dispose();
    await expect(controller.syncNow()).resolves.toBe(controller.state);
    expect(run).not.toHaveBeenCalled();
  });

  it('notifyLocalWrite still returns undefined', () => {
    const { controller } = make(async () => ok);
    const notify = vi.spyOn(controller, 'notifyLocalWrite');
    controller.notifyLocalWrite();
    expect(notify).toHaveReturnedWith(undefined);
    controller.dispose();
  });

  it('start syncs immediately: idle -> syncing -> idle with lastSyncAt', async () => {
    const { controller } = make(async () => ok);
    const seen: string[] = [];
    controller.subscribe((s) => seen.push(s.status));
    controller.start();
    await flush();
    expect(seen).toEqual(['idle', 'syncing', 'idle']);
    expect(controller.state.lastSyncAt).not.toBeNull();
    expect(controller.state.lastResult).toEqual(ok);
  });

  it('single flight: triggers during a run coalesce into one follow-up', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { controller, run } = make(async () => {
      await gate;
      return ok;
    });
    controller.start();
    void controller.syncNow();
    void controller.syncNow();
    void controller.syncNow();
    release();
    await flush();
    expect(run).toHaveBeenCalledTimes(2); // the run + one coalesced follow-up
  });

  it('local writes debounce into one run', async () => {
    const { controller, run } = make(async () => ok);
    controller.start();
    await flush();
    controller.notifyLocalWrite();
    controller.notifyLocalWrite();
    controller.notifyLocalWrite();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(run).toHaveBeenCalledTimes(2); // initial + one debounced
  });

  it('the interval and platform triggers cause runs', async () => {
    const { controller, run, triggerFire } = make(async () => ok);
    controller.start();
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);
    triggerFire.current?.();
    await flush();
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('an offline error reads as offline, recovery as idle', async () => {
    let fail = true;
    const error = new SyncTransportError('sync pull: network failure');
    const { controller } = make(async () => {
      if (fail) throw error;
      return ok;
    });
    controller.start();
    await flush();
    expect(controller.state.status).toBe('offline');
    expect(controller.state.cause).toBe(error);
    fail = false;
    void controller.syncNow();
    await flush();
    expect(controller.state.status).toBe('idle');
    expect(controller.state.cause).toBeNull();
  });

  it('a server error reads as error and keeps the message', async () => {
    const error = new SyncTransportError('sync push: HTTP 500', 500);
    const { controller } = make(async () => {
      throw error;
    });
    controller.start();
    await flush();
    expect(controller.state.status).toBe('error');
    expect(controller.state.error).toContain('HTTP 500');
    expect(controller.state.cause).toBe(error);
  });

  it('an auth error blocks automatic retries until a manual retry', async () => {
    let status: number | undefined = 401;
    const { controller, run, triggerFire } = make(async () => {
      if (status) throw new SyncTransportError('sync pull: HTTP 401', status);
      return ok;
    });
    controller.start();
    await flush();
    expect(controller.state.status).toBe('error');
    triggerFire.current?.();
    controller.notifyLocalWrite();
    await vi.advanceTimersByTimeAsync(62_000);
    expect(run).toHaveBeenCalledTimes(1); // everything automatic ignored
    status = undefined;
    void controller.syncNow();
    await flush();
    expect(controller.state.status).toBe('idle');
  });

  it('a custom isAuthError replaces the default', async () => {
    class SessionGone extends Error {}
    const run = vi.fn(async () => {
      throw new SessionGone('expired');
    });
    const controller = createSyncController({
      runSync: run,
      isAuthError: (e) => e instanceof SessionGone,
    });
    controller.start();
    await flush();
    controller.notifyLocalWrite();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('a resynced run surfaces as resync-required until the next sync', async () => {
    let resynced = true;
    const { controller } = make(async () => ({ ...ok, resynced }));
    controller.start();
    await flush();
    expect(controller.state.status).toBe('resync-required');
    resynced = false;
    void controller.syncNow();
    await flush();
    expect(controller.state.status).toBe('idle');
  });

  it('rejections are data on lastResult, not an error status', async () => {
    const { controller } = make(async () => ({
      ...ok,
      rejected: 1,
      rejectedRecords: { tasks: ['t1'] },
    }));
    controller.start();
    await flush();
    expect(controller.state.status).toBe('idle');
    expect(controller.state.lastResult?.rejectedRecords).toEqual({
      tasks: ['t1'],
    });
  });

  it('dispose aborts a sync that is still in flight', async () => {
    let aborted = false;
    const { controller } = make(
      (signal) =>
        new Promise<RunSyncResult>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    );
    controller.start();
    controller.dispose();
    await flush();
    expect(aborted).toBe(true);
    expect(controller.state.status).toBe('syncing'); // frozen; nobody updates a disposed controller
  });

  it('dispose stops every trigger and unsubscribes the platform hook', async () => {
    const { controller, run, triggerFire } = make(async () => ok);
    controller.start();
    await flush();
    controller.dispose();
    expect(triggerFire.current).toBeNull();
    controller.notifyLocalWrite();
    void controller.syncNow();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('manual control', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('intervalMs: null disables the clock but keeps start and triggers', async () => {
    const run = vi.fn(async () => ok);
    const fire: { current: (() => void) | null } = { current: null };
    const controller = createSyncController({
      runSync: run,
      intervalMs: null,
      triggers: (f) => {
        fire.current = f;
        return () => {};
      },
    });
    controller.start();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(run).toHaveBeenCalledTimes(1); // only the initial run
    fire.current?.();
    expect(run).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it('a never-started controller still syncs via syncNow', async () => {
    const run = vi.fn(async () => ok);
    const controller = createSyncController({ runSync: run });
    void controller.syncNow();
    await Promise.resolve();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    expect(controller.state.lastSyncAt).not.toBeNull();
    controller.dispose();
  });
});
