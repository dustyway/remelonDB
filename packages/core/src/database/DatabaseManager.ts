/**
 * A small state machine around Database.open, so apps don't hand-roll
 * one: concurrent init() calls share a single in-flight open (cleared
 * in a finally, so a failed open stays retryable), and each attempt is
 * epoch-tagged so a superseded attempt's onTakenOver cannot touch a
 * newer database. Framework-free and driver-agnostic: the `open`
 * factory wires the takeover callback wherever the platform wants it.
 * React bindings live in `@remelondb/core/react`.
 */
import type { Database } from './Database';

export type DatabaseManagerStatus =
  'idle' | 'loading' | 'ready' | 'error' | 'taken-over';

export interface DatabaseManagerState {
  readonly status: DatabaseManagerStatus;
  readonly error: Error | null;
}

export interface DatabaseManagerOptions {
  /** Open the database; wire `onTakenOver` into the driver if the
   * platform has takeover semantics. Called once per (re)init attempt. */
  readonly open: (onTakenOver: () => void) => Promise<Database>;
}

export interface DatabaseManager {
  /** Current lifecycle state; stable object, replaced on change. */
  readonly state: DatabaseManagerState;
  /** The open database. Throws before ready and after a takeover. */
  readonly database: Database;
  /** Open (or reopen after error/takeover). Concurrent calls share one
   * attempt; when ready, resolves with the existing database. */
  init(): Promise<Database>;
  /** Tear down: close the open database and return to `idle` so a
   * later init() (another account, a re-login) starts fresh. An open
   * still in flight is discarded when it lands — closed immediately,
   * its init() rejecting — so a slow open can never resurrect a
   * database after logout.
   *
   * Resolves only once nothing this manager opened is still open,
   * including a database that arrived after the call: await it and the
   * file is free, which is what lets an owner open the same database
   * next. A failure closing that late arrival rejects here rather than
   * reporting a clean teardown, and a failed teardown is kept: every
   * later close() reports it rather than claiming a cleanup that did
   * not happen. Concurrent calls share one teardown.
   *
   * init() rejects while a close is running, and for good once one
   * has failed: reusing a manager whose teardown failed would leave
   * the next close() with no honest answer. Await the close before
   * replacing the manager — starting a second one over the same
   * database while the first still closes is the race this fixes.
   * After a close that succeeded the manager is back at idle and
   * init() opens fresh. */
  close(): Promise<void>;
  /** Listen for state changes. Emits the current state immediately.
   * Returns the unsubscribe function. */
  subscribe(listener: (state: DatabaseManagerState) => void): () => void;
}

export function createDatabaseManager(
  options: DatabaseManagerOptions,
): DatabaseManager {
  let state: DatabaseManagerState = { status: 'idle', error: null };
  let database: Database | null = null;
  let initPromise: Promise<Database> | null = null;
  let epoch = 0;
  /** A failure closing a database that arrived after close() began.
   * close() owns it: init() has its own error to report. */
  let lateCloseError: Error | null = null;
  let closePromise: Promise<void> | null = null;
  const listeners = new Set<(state: DatabaseManagerState) => void>();

  const setState = (next: DatabaseManagerState): void => {
    state = next;
    for (const listener of [...listeners]) {
      listener(state);
    }
  };

  const init = (): Promise<Database> => {
    if (closePromise) {
      // A close is running, or one failed and this manager's database
      // may still be open. Opening here would need this manager to
      // sequence itself against its own teardown, and every state that
      // adds has a way to go wrong. Await that close first: replacing
      // the manager while it runs just moves the race between two
      // managers over one file.
      return Promise.reject(
        new Error(
          'Database manager is closing or failed to close — await close() before replacing it',
        ),
      );
    }
    if (database) {
      return Promise.resolve(database);
    }
    if (initPromise) {
      return initPromise;
    }
    const attempt = ++epoch;
    setState({ status: 'loading', error: null });
    const promise = options
      .open(() => {
        if (attempt !== epoch) {
          return; // a stale life's takeover — a newer attempt owns the state
        }
        database = null;
        setState({
          status: 'taken-over',
          error: new Error(
            'Database taken over by another tab — call init() to reclaim it',
          ),
        });
      })
      .then(
        async (opened) => {
          if (attempt !== epoch) {
            // The manager was closed while this open was in flight: the
            // late arrival must not become anyone's database. Awaited,
            // not detached, so close() can wait for this promise and
            // know the file is free — a caller that opens the same
            // database next would otherwise race this teardown.
            try {
              await opened.driver.close();
            } catch (error) {
              lateCloseError =
                error instanceof Error ? error : new Error(String(error));
            }
            throw new Error(
              'Database manager was closed during initialization',
            );
          }
          database = opened;
          setState({ status: 'ready', error: null });
          return opened;
        },
        (error: unknown) => {
          const wrapped =
            error instanceof Error ? error : new Error(String(error));
          if (attempt === epoch) {
            setState({ status: 'error', error: wrapped });
          }
          throw wrapped;
        },
      )
      .finally(() => {
        if (initPromise === promise) {
          initPromise = null;
        }
      });
    initPromise = promise;
    return promise;
  };

  return {
    get state() {
      return state;
    },
    get database() {
      if (!database) {
        throw new Error(
          state.status === 'taken-over'
            ? 'Database was taken over by another tab — call init() to reclaim it'
            : 'Database is not initialized — call init() first',
        );
      }
      return database;
    },
    init,
    close() {
      // One teardown per close, so a caller that closes twice — a retry,
      // an owner unsure whether it already closed — waits for the same
      // work instead of tearing the driver down twice. A failed one is
      // kept for good: the database may still be open, and answering
      // the next caller with a clean resolve would be a lie.
      if (closePromise) {
        return closePromise;
      }
      epoch++; // in-flight opens and stale takeovers are now nobody's
      // The wrapped promise, not the raw options.open(...) result: only
      // this one settles after the stale branch above has awaited
      // driver.close(), which is what makes waiting for it mean the
      // file is free. Nothing chains behind it, so awaiting it cannot
      // deadlock.
      const pendingInit = initPromise;
      initPromise = null;
      const current = database;
      database = null;
      const closing = (async () => {
        if (current) {
          await current.driver.close();
        }
        if (pendingInit) {
          // Both outcomes: a failed open is the init() caller's error,
          // not this one's. Settlement is the signal that no late
          // database is still open.
          await pendingInit.then(
            () => {},
            () => {},
          );
        }
        if (lateCloseError) {
          const failure = lateCloseError;
          lateCloseError = null;
          throw failure;
        }
      })();
      // The guard goes in before anyone is told. A subscriber that
      // reacts to `idle` by calling init() must find this close, not an
      // open door.
      closePromise = closing;
      if (state.status !== 'idle') {
        setState({ status: 'idle', error: null });
      }
      // Released only on success. A rejected teardown stays the answer
      // for every later close(), and init() refuses while it stands:
      // a manager that could not close is not one to reopen.
      void closing.then(
        () => {
          if (closePromise === closing) {
            closePromise = null;
          }
        },
        () => {},
      );
      return closing;
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
