import { SyncTransportError } from '../transport/index';

/** What one synchronization run reports back to the controller and UI. */
export interface RunSyncResult {
  readonly resynced: boolean;
  readonly rejected: number;
  readonly rejectedRecords: Readonly<Record<string, readonly string[]>>;
}

/**
 * The background loop around `synchronize` (the sibling of
 * `createDatabaseManager`, which owns the open/close lifecycle). Local
 * writes never wait for the network: the controller runs syncs in the
 * background — single flight, triggers coalesced — and exposes status
 * for the UI. `dispose()` is the logout hard-stop: it aborts the
 * in-flight run through the signal handed to `runSync`.
 *
 * `resync-required` is the post-recovery notice: `synchronize` handles a
 * server `resyncRequired` internally (replacement re-pull) and reports
 * that it happened; the next successful ordinary sync clears it.
 */
export type SyncControllerStatus =
  'idle' | 'syncing' | 'offline' | 'error' | 'resync-required';

export interface SyncControllerState {
  readonly status: SyncControllerStatus;
  readonly lastSyncAt: number | null;
  readonly error: string | null;
  /**
   * The value the failed run threw, for logging and diagnostics; null
   * when the last run did not fail. The message is a rendering of this
   * and loses everything else, including an Error's stack.
   */
  readonly cause: unknown;
  /** The last completed run, null before the first one. Rejections live
   * here; mapping them to a visible status is the app's decision. */
  readonly lastResult: RunSyncResult | null;
}

export interface SyncControllerOptions {
  /** Run one synchronization. The signal aborts a run whose owner is
   * gone (logout). Wrap `synchronize` yourself or use `createRunSync`. */
  readonly runSync: (signal?: AbortSignal) => Promise<RunSyncResult>;
  /** Background re-sync period; `null` disables the clock. For a fully
   * manual controller, skip start() and call syncNow() from your UI. */
  readonly intervalMs?: number | null;
  readonly debounceMs?: number;
  /** Subscribe platform wake-ups (online, foreground) to `fire`; return
   * the unsubscribe. Called by start(), cleaned up by dispose(). */
  readonly triggers?: (fire: () => void) => () => void;
  /** A thrown error that means "the session is gone": automatic syncing
   * stops until syncNow() re-arms it. Default: a SyncTransportError with
   * status 401. */
  readonly isAuthError?: (error: unknown) => boolean;
  /** A thrown error that means "the network is down" rather than a
   * fault. Default: a SyncTransportError without a status. */
  readonly isOfflineError?: (error: unknown) => boolean;
}

export interface SyncController {
  readonly state: SyncControllerState;
  subscribe(listener: (state: SyncControllerState) => void): () => void;
  /** Begin: initial sync, then interval and platform triggers. */
  start(): void;
  /** A local write happened; sync soon (debounced). */
  notifyLocalWrite(): void;
  /** Manual trigger; also re-arms after an auth error. */
  syncNow(): void;
  /** Stop everything, forever. The logout/account-change path. */
  dispose(): void;
}

const defaultIsAuthError = (error: unknown): boolean =>
  error instanceof SyncTransportError && error.status === 401;
const defaultIsOfflineError = (error: unknown): boolean =>
  error instanceof SyncTransportError && error.status === undefined;

export function createSyncController(
  options: SyncControllerOptions,
): SyncController {
  const intervalMs =
    options.intervalMs === undefined ? 60_000 : options.intervalMs;
  const debounceMs = options.debounceMs ?? 2_000;
  const isAuthError = options.isAuthError ?? defaultIsAuthError;
  const isOfflineError = options.isOfflineError ?? defaultIsOfflineError;

  let state: SyncControllerState = {
    status: 'idle',
    lastSyncAt: null,
    error: null,
    cause: null,
    lastResult: null,
  };
  const listeners = new Set<(state: SyncControllerState) => void>();
  let disposed = false;
  let running = false;
  let rerunQueued = false;
  let authBlocked = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let inFlight: AbortController | null = null;
  let unsubscribeTriggers: (() => void) | null = null;

  const setState = (next: Partial<SyncControllerState>): void => {
    state = { ...state, ...next };
    for (const listener of [...listeners]) {
      listener(state);
    }
  };

  const run = (): void => {
    if (disposed || running) {
      rerunQueued = running ? true : rerunQueued;
      return;
    }
    running = true;
    setState({ status: 'syncing' });
    inFlight = new AbortController();
    options
      .runSync(inFlight.signal)
      .then(
        (result) => {
          if (disposed) return;
          setState({
            status: result.resynced ? 'resync-required' : 'idle',
            lastSyncAt: Date.now(),
            error: null,
            cause: null,
            lastResult: result,
          });
        },
        (error: unknown) => {
          if (disposed) return;
          const message =
            error instanceof Error ? error.message : String(error);
          if (isAuthError(error)) {
            // the session is gone: stop the machinery, the auth layer
            // owns what happens next; a manual retry re-arms
            authBlocked = true;
            setState({ status: 'error', error: message, cause: error });
            return;
          }
          if (isOfflineError(error)) {
            setState({ status: 'offline', error: message, cause: error });
            return;
          }
          setState({ status: 'error', error: String(error), cause: error });
        },
      )
      .finally(() => {
        running = false;
        inFlight = null;
        if (rerunQueued && !disposed) {
          rerunQueued = false;
          run();
        }
      });
  };

  const autoTrigger = (): void => {
    if (disposed || authBlocked) return;
    run();
  };

  return {
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    start() {
      if (disposed) return;
      unsubscribeTriggers = options.triggers?.(autoTrigger) ?? null;
      if (intervalMs !== null) {
        intervalTimer = setInterval(autoTrigger, intervalMs);
      }
      run();
    },
    notifyLocalWrite() {
      if (disposed || authBlocked) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        autoTrigger();
      }, debounceMs);
    },
    syncNow() {
      if (disposed) return;
      authBlocked = false; // the human (or a fresh login) re-arms it
      run();
    },
    dispose() {
      disposed = true;
      inFlight?.abort(); // the database is about to close under us
      if (debounceTimer) clearTimeout(debounceTimer);
      if (intervalTimer) clearInterval(intervalTimer);
      unsubscribeTriggers?.();
      unsubscribeTriggers = null;
      listeners.clear();
    },
  };
}

import { synchronize, type SynchronizeOptions } from './synchronize';

/**
 * Adapt `synchronize` to the controller's `runSync`: same options, minus
 * the signal, which the controller supplies per run.
 */
export function createRunSync(
  options: Omit<SynchronizeOptions, 'signal'>,
): (signal?: AbortSignal) => Promise<RunSyncResult> {
  return async (signal?: AbortSignal) => {
    const result = await synchronize({
      ...options,
      ...(signal ? { signal } : {}),
    });
    return {
      resynced: result.resynced,
      rejected: result.rejected,
      rejectedRecords: result.rejectedRecords,
    };
  };
}
