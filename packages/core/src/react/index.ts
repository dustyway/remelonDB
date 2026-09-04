/**
 * React bindings for the database manager and queries. A separate
 * subpath (like `./zod`) so core itself never depends on react — this
 * module loads only when imported, and react is an optional peer.
 *
 * Queries are data, and the hooks lean on that: `useQuery` keys its
 * subscription on the query's *structure* (table + description), so
 * rebuilding an equivalent query every render is free and there is no
 * dependency array to forget. All hooks are tear-safe via
 * useSyncExternalStore.
 */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createRunSync, createSyncController } from '../index';
import type {
  Database,
  DatabaseManager,
  DatabaseManagerState,
  SyncController,
  SyncControllerOptions,
  SyncControllerState,
  SynchronizeOptions,
} from '../index';
import type { Query } from '../database/Query';

type Unsubscribe = () => void;

// ---------------------------------------------------------------------------
// Provider

const ManagerContext = createContext<DatabaseManager | null>(null);

/**
 * Provide a database manager to the zero-argument hooks below.
 *
 *     <DatabaseProvider manager={manager}><App /></DatabaseProvider>
 */
export function DatabaseProvider(props: {
  manager: DatabaseManager;
  children?: ReactNode;
}) {
  return createElement(
    ManagerContext.Provider,
    { value: props.manager },
    props.children,
  );
}

function useManager(manager?: DatabaseManager): DatabaseManager {
  const fromContext = useContext(ManagerContext);
  const resolved = manager ?? fromContext;
  if (!resolved) {
    throw new Error(
      'remelonDB: no database manager. Pass one explicitly or wrap the tree in <DatabaseProvider>.',
    );
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Manager hooks

/**
 * Subscribe a component to a manager's lifecycle state. Tear-safe via
 * useSyncExternalStore; re-renders exactly on state transitions. The
 * manager argument is optional inside a `<DatabaseProvider>`.
 *
 *     const { status, error } = useDatabaseState()
 */
export function useDatabaseState(
  manager?: DatabaseManager,
): DatabaseManagerState {
  const m = useManager(manager);
  // stable per manager: a fresh subscribe function every render would
  // make useSyncExternalStore resubscribe on every render
  const subscribe = useCallback(
    (onStoreChange: () => void) => m.subscribe(onStoreChange),
    [m],
  );
  return useSyncExternalStore(
    subscribe,
    () => m.state,
    () => m.state,
  );
}

/**
 * Subscribe a component to a sync controller's state. Tear-safe via
 * useSyncExternalStore; re-renders exactly on state transitions.
 *
 *     const { status, lastResult } = useSyncState(controller)
 */
export function useSyncState(controller: SyncController): SyncControllerState {
  const subscribe = useCallback(
    (onStoreChange: () => void) => controller.subscribe(onStoreChange),
    [controller],
  );
  return useSyncExternalStore(
    subscribe,
    () => controller.state,
    () => controller.state,
  );
}

/**
 * The open database, or null until the manager reaches `ready`.
 *
 *     const db = useDatabase()
 *     const { data } = useQuery(db && getDecksQuery(db))
 */
export function useDatabase(manager?: DatabaseManager): Database | null {
  const m = useManager(manager);
  const subscribe = useCallback(
    (onStoreChange: () => void) => m.subscribe(onStoreChange),
    [m],
  );
  return useSyncExternalStore(
    subscribe,
    () => (m.state.status === 'ready' ? m.database : null),
    () => null,
  );
}

// ---------------------------------------------------------------------------
// Session hook

export interface SessionDatabaseOptions {
  /** Null while signed out, and while the session check is still running:
   * a user id that might change on the next tick must not open a file. */
  readonly userId: string | null;
  /** Build the manager for a user. Read when a session starts. */
  readonly createManager: (userId: string) => DatabaseManager;
  /** What `synchronize` needs, minus the database and the signal. */
  readonly sync: Omit<SynchronizeOptions, 'database' | 'signal'>;
  /** Passed through to `createSyncController`. */
  readonly controller?: Omit<SyncControllerOptions, 'runSync'>;
}

export interface SessionDatabase {
  readonly manager: DatabaseManager | null;
  readonly syncController: SyncController | null;
  /**
   * A teardown that failed. The database it owned may still be open, so
   * no replacement is started: opening a second one over the same file
   * is what this hook exists to prevent. Sticky, like the manager's own
   * failed close.
   */
  readonly closeError: Error | null;
}

/**
 * Own one database and one sync controller for the signed-in user.
 *
 *     const { manager, syncController } = useSessionDatabase({
 *       userId, createManager, sync: { pullChanges, pushChanges },
 *       controller: { triggers },
 *     })
 *
 * Headless: it renders nothing, so the caller wraps the tree in
 * `<DatabaseProvider manager={manager}>` once the manager exists.
 *
 * **Where you call this is part of the contract.** The queue that makes
 * the next open wait for the previous close lives in this hook, so it
 * lives exactly as long as the component that calls it. Call it from a
 * component that stays mounted across session *and* route changes, and
 * let route layouts read the manager from context. Calling it inside a
 * layout that navigation unmounts brings back the race it prevents: the
 * queue is empty again on remount, and the next open has nothing to
 * wait for. Routers destroy and recreate a layout faster than any close
 * finishes.
 *
 * A session's manager is not created until the previous session's close
 * has finished, so a caller never holds a manager it could open ahead of
 * that teardown. Cleanup closes immediately rather than queueing, so a
 * logout during a slow open still invalidates it.
 *
 * Sync attaches whenever the database is ready and detaches when it is
 * not, rather than following one `init()` call. A database recovered by
 * something else — an error banner's retry, say — still gets sync, and
 * a reopen after an error hands back a different `Database`, so the
 * controller is rebuilt against it.
 *
 * `createManager`, `sync`, and `controller` are read when a session
 * starts. Changing them affects the next session, not the running one.
 */
export function useSessionDatabase(
  options: SessionDatabaseOptions,
): SessionDatabase {
  const { userId } = options;
  // Read at session start, not at render: a caller passing fresh object
  // literals must not restart the database it already opened.
  const latest = useRef(options);
  latest.current = options;
  // Closes only. One session's teardown finishes before the next one
  // opens, and a rejected tail stays rejected — the database may still
  // be open, so no replacement is started.
  const closeTail = useRef<Promise<void>>(Promise.resolve());
  const [owned, setOwned] = useState<{
    userId: string;
    manager: DatabaseManager;
    syncController: SyncController | null;
  } | null>(null);
  const [closeError, setCloseError] = useState<Error | null>(null);

  useEffect(() => {
    if (!userId) {
      return;
    }
    const { createManager, sync, controller } = latest.current;
    let live = true;
    let manager: DatabaseManager | null = null;
    let attached: SyncController | null = null;
    let unsubscribe: (() => void) | null = null;

    void closeTail.current.then(
      () => {
        if (!live) {
          return;
        }
        const opened = createManager(userId);
        manager = opened;
        setCloseError(null);
        setOwned({ userId, manager: opened, syncController: null });

        unsubscribe = opened.subscribe((state) => {
          if (!live) {
            return;
          }
          if (state.status !== 'ready') {
            // The database this controller runs against is gone. A
            // reopen produces a different one, so it cannot be reused.
            if (attached) {
              attached.dispose();
              attached = null;
              setOwned({ userId, manager: opened, syncController: null });
            }
            return;
          }
          if (attached) {
            return;
          }
          const started = createSyncController({
            ...controller,
            runSync: createRunSync({ ...sync, database: opened.database }),
          });
          attached = started;
          setOwned({ userId, manager: opened, syncController: started });
          started.start();
        });

        // The manager's state carries the error; nothing to do here.
        void opened.init().then(
          () => {},
          () => {},
        );
      },
      () => {
        // The previous teardown failed, so this session gets no
        // database. Cleanup reported the error when it happened; a
        // logout has no next session to report it otherwise.
      },
    );

    return () => {
      live = false;
      unsubscribe?.();
      // Before the close, so an in-flight sync is aborted through its
      // signal rather than writing into a database that is going away.
      attached?.dispose();
      const closing = manager;
      if (closing) {
        // Immediately, not behind anything: close() is what invalidates
        // an open still in flight, and queueing it would let that open
        // land unopposed.
        const closed = closing.close();
        closeTail.current = closed; // stays rejected if it fails
        void closed.catch((error: unknown) => {
          // Reported here rather than where the next session waits: a
          // logout has no next session, and the failure still matters.
          setCloseError(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
      }
      setOwned((current) => (current?.manager === closing ? null : current));
    };
  }, [userId]);

  // Tagged with its owner: on a session change React renders once with
  // the old state before the effect cleans it up, and that render must
  // not hand out the previous account's database.
  return owned?.userId === userId
    ? {
        manager: owned.manager,
        syncController: owned.syncController,
        closeError,
      }
    : { manager: null, syncController: null, closeError };
}

// ---------------------------------------------------------------------------
// Query hooks

export interface QueryResult<M> {
  readonly data: M[];
  readonly isLoading: boolean;
  readonly error: Error | null;
  /**
   * True while `keepPreviousData` is showing the previous query's rows
   * because the current query has not delivered yet. Always false
   * without the option.
   */
  readonly isPreviousData: boolean;
}

export interface QueryCountResult {
  readonly data: number;
  readonly isLoading: boolean;
  readonly error: Error | null;
}

/** Shared refcounted store: starts the observation on first subscriber,
 * stops it when the last one leaves, caches the latest snapshot. */
function createStore<T>(
  initial: T,
  start: (set: (value: T) => void) => Unsubscribe,
) {
  let value = initial;
  let stop: Unsubscribe | null = null;
  const listeners = new Set<() => void>();
  return {
    // An arrow rather than a method so callers can hand subscribe straight
    // to useSyncExternalStore; it closes over `listeners`, never `this`.
    subscribe: (listener: () => void): Unsubscribe => {
      listeners.add(listener);
      if (listeners.size === 1) {
        stop = start((next) => {
          value = next;
          for (const l of listeners) l();
        });
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && stop) {
          stop();
          stop = null;
          value = initial;
        }
      };
    },
    snapshot: () => value,
    idle: () => listeners.size === 0,
  };
}

const LOADING: QueryResult<never> = {
  data: [],
  isLoading: true,
  error: null,
  isPreviousData: false,
};
const NO_QUERY: QueryResult<never> = {
  data: [],
  isLoading: false,
  error: null,
  isPreviousData: false,
};
const noStore = {
  subscribe: (): Unsubscribe => () => {},
  snapshot: () => NO_QUERY,
};

/** Structural identity: same table, same clauses → same subscription. */
function queryKey(query: Query<unknown>): string {
  return `${query.collection.schema.name}:${JSON.stringify(query.description)}`;
}

/**
 * Shared per-database registry: components observing structurally equal
 * queries share one live observation (refcounted, removed when the last
 * subscriber leaves). This is what keeps a screen with five widgets on
 * the same query at one subscription instead of five.
 */
const registries = new WeakMap<
  object,
  Map<string, ReturnType<typeof createStore<never>>>
>();

function sharedStore<T>(
  database: object,
  key: string,
  make: () => ReturnType<typeof createStore<T>>,
): ReturnType<typeof createStore<T>> {
  let registry = registries.get(database);
  if (!registry) {
    registry = new Map();
    registries.set(database, registry);
  }
  let store = registry.get(key) as
    ReturnType<typeof createStore<T>> | undefined;
  if (!store) {
    const created = make();
    store = {
      subscribe(listener) {
        const stop = created.subscribe(listener);
        return () => {
          stop();
          if (created.idle()) registry.delete(key);
        };
      },
      snapshot: created.snapshot,
      idle: created.idle,
    };
    registry.set(key, store as ReturnType<typeof createStore<never>>);
  }
  return store;
}

/**
 * Subscribe to a query's results. Re-renders whenever matching local
 * data changes — user writes and applied sync pulls alike. The query
 * may be rebuilt every render: subscriptions are keyed on the query's
 * structure, not its object identity, so there is no dependency array.
 * Pass null/undefined while the database is not ready.
 *
 *     const db = useDatabase()
 *     const { data: decks, isLoading } = useQuery(db && getDecksQuery(db))
 */
export interface SelectedResult<T> {
  readonly data: T;
  readonly isLoading: boolean;
  readonly error: Error | null;
  /** See {@link QueryResult.isPreviousData}. */
  readonly isPreviousData: boolean;
}

export interface UseQueryOptions<M, T> {
  /**
   * Derive the rendered value from the rows. Runs when the rows
   * change (per consumer, so different components can select
   * differently from one shared subscription); must be pure.
   * Changing the function recomputes the selected value without
   * restarting the shared query observation.
   */
  select?: (rows: M[]) => T;
  /**
   * When the query's structure changes (a new search term, another
   * page), keep rendering the previous query's rows until the new one
   * delivers, instead of dropping to an empty `isLoading` state. The
   * transition is visible as `isPreviousData: true`; `isLoading` stays
   * reserved for having nothing renderable. An error from the new
   * query surfaces immediately, with the previous rows still rendered.
   *
   * Retention is strictly per consumer: the previous rows never enter
   * the shared query store, so another component reaching the same
   * query never sees them. Retained rows are dropped the moment the
   * database object changes or the query becomes null.
   *
   * For a periodically re-parameterized query over a bounded row set
   * (a due-by-now clause), prefer a stable query plus `select`: it
   * recomputes locally instead of restarting the observation on every
   * tick. This option is for queries that must change — search,
   * pagination — where the row set can't be pulled whole.
   */
  keepPreviousData?: boolean;
}

// The select overload comes FIRST and is spelled out concretely: a
// literal carrying both options must meet the select signature before
// the select-less overload, or the select callback loses its
// contextual type and `(rows) => rows.length` stops inferring M[].
export function useQuery<M, T>(
  query: Query<M> | null | undefined,
  options: {
    select: (rows: M[]) => T;
    keepPreviousData?: boolean;
  },
): SelectedResult<T>;
export function useQuery<M>(
  query: Query<M> | null | undefined,
  options?: { keepPreviousData?: boolean },
): QueryResult<M>;
export function useQuery<M, T>(
  query: Query<M> | null | undefined,
  options?: UseQueryOptions<M, T>,
): QueryResult<M> | SelectedResult<T> {
  const database = query ? query.collection.database : null;
  const key = query ? queryKey(query) : null;
  // The first structurally-equal query instance is captured for the
  // subscription; later equivalent instances are deliberately ignored,
  // which is why `query` is not in the dependency list.
  const store = useMemo(() => {
    if (!query || !database || !key) return noStore;
    return sharedStore<QueryResult<M>>(database, `q:${key}`, () => {
      let latest: M[] = [];
      return createStore<QueryResult<M>>(LOADING, (set) =>
        query.observe(
          (data) => {
            latest = data;
            set({ data, isLoading: false, error: null, isPreviousData: false });
          },
          (error) => {
            set({
              data: latest,
              isLoading: false,
              error,
              isPreviousData: false,
            });
          },
        ),
      );
    });
  }, [database, key]);
  const raw = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
    store.snapshot,
  );

  // keepPreviousData retention is deliberately consumer-local: a ref in
  // this hook instance, never the shared store, so one consumer's
  // placeholder rows cannot leak into another consumer of the same key.
  // The ref is only written in the commit-phase effect below — a render
  // React abandons must not decide what this consumer retains — so the
  // render path just reads the last committed entry and re-checks every
  // guard against the current props.
  const keep = options?.keepPreviousData === true;
  const heldRef = useRef<{ db: object; key: string; data: M[] } | null>(null);
  useEffect(() => {
    // Retention is dropped when the option is off or the database is
    // no longer the one the rows came from. A null query has a null
    // database, so "query became null" is the same clear — and it must
    // happen here, not just be filtered at render time, or the rows
    // could resurface when their database comes back later.
    if (
      !keep ||
      (heldRef.current !== null && heldRef.current.db !== database)
    ) {
      heldRef.current = null;
    }
    if (keep && database && key && !raw.isLoading && raw.error === null) {
      heldRef.current = { db: database, key, data: raw.data };
    }
  }, [keep, database, key, raw]);
  const held = heldRef.current;
  // Previous rows show while the current key has not succeeded yet —
  // loading, or failed before its first delivery. Success always wins.
  // The db guard repeats here because the effect clear lands one commit
  // later than the render that switched databases.
  const previous =
    keep &&
    held !== null &&
    held.db === database &&
    held.key !== key &&
    (raw.isLoading || raw.error !== null)
      ? held
      : null;

  const select = options?.select;
  return useMemo<QueryResult<M> | SelectedResult<T>>(() => {
    const presented: QueryResult<M> = previous
      ? {
          data: previous.data,
          isLoading: false,
          error: raw.error,
          isPreviousData: true,
        }
      : raw;
    if (!select) return presented;
    return {
      isLoading: presented.isLoading,
      error: presented.error,
      isPreviousData: presented.isPreviousData,
      data: select(presented.data),
    };
  }, [raw, select, previous]);
}

/**
 * Subscribe to a query's result count via the engine's cheaper count
 * observation, including loading and error state. Same structural keying
 * and retained-last-success behavior as `useQuery`.
 *
 *     const { data: due, error } = useQueryCountResult(query)
 */
export function useQueryCountResult(
  query: Query<unknown> | null | undefined,
): QueryCountResult {
  const database = query ? query.collection.database : null;
  const key = query ? queryKey(query) : null;
  // As in useQueryResult: the captured query instance is the first
  // structurally-equal one, so `query` is not a dependency.
  const store = useMemo(() => {
    if (!query || !database || !key) return null;
    return sharedStore<QueryCountResult>(database, `c:${key}`, () => {
      let latest = 0;
      return createStore<QueryCountResult>(
        { data: 0, isLoading: true, error: null },
        (set) =>
          query.observeCount(
            (data) => {
              latest = data;
              set({ data, isLoading: false, error: null });
            },
            (error) => {
              set({ data: latest, isLoading: false, error });
            },
          ),
      );
    });
  }, [database, key]);
  return useSyncExternalStore(
    store ? store.subscribe : noStore.subscribe,
    store ? store.snapshot : () => NO_COUNT,
    store ? store.snapshot : () => NO_COUNT,
  );
}

const NO_COUNT: QueryCountResult = {
  data: 0,
  isLoading: false,
  error: null,
};

/** Backward-compatible convenience form; use `useQueryCountResult` when
 * loading and error state matter. */
export function useQueryCount(
  query: Query<unknown> | null | undefined,
): number {
  return useQueryCountResult(query).data;
}

// ---------------------------------------------------------------------------
// Mutations

/** State and entry points returned by {@link useMutation}. */
export interface UseMutationResult<Args extends unknown[], Result> {
  /**
   * Fire-and-observe: returns void, so a floating call is safe by
   * construction. Failure never becomes an unhandled rejection; it
   * lands in `error`.
   */
  mutate: (...args: Args) => void;
  /**
   * Awaitable form with normal promise semantics: resolves with the
   * mutation result, rejects with the original error. For workflows
   * that must continue only after success (close a dialog once the
   * write commits). Drives the same state as `mutate`.
   */
  mutateAsync: (...args: Args) => Promise<Result>;
  /** Result of the most recent completed invocation that still owns state. */
  data: Result | undefined;
  /** Failure of the owning invocation; cleared when a new one starts. */
  error: unknown;
  /** True while any tracked invocation is in flight. */
  isPending: boolean;
  /** Back to idle: clears data and error, in-flight completions are ignored. */
  reset: () => void;
}

/**
 * The write-side counterpart of `useQuery`: wrap an async write and get
 * pending/error state instead of a bare promise to babysit.
 *
 *     const { mutate, isPending, error } = useMutation(
 *       (title: string) => db.write(() => db.get(Deck).create({ title })),
 *     )
 *
 * Ownership under overlap: the latest invocation owns `data` and
 * `error`; completions of superseded or reset invocations only drain
 * `isPending`. The mutation function is read at call time, so a
 * re-render with a new closure is picked up without re-subscribing.
 */
export function useMutation<Args extends unknown[], Result>(
  mutationFn: (...args: Args) => Promise<Result> | Result,
): UseMutationResult<Args, Result> {
  const [state, setState] = useState<{
    data: Result | undefined;
    error: unknown;
    pendingCount: number;
  }>(IDLE_MUTATION);

  const fnRef = useRef(mutationFn);
  fnRef.current = mutationFn;
  // generation guards ownership: bumped by each invocation and by reset,
  // so stale completions cannot write data/error. era guards pending:
  // reset zeroes the counter and starts a new era, so completions from
  // before the reset must not drain what they no longer belong to.
  // mountedRef guards against state updates after unmount.
  const generationRef = useRef(0);
  const eraRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const mutateAsync = useCallback(async (...args: Args): Promise<Result> => {
    const generation = ++generationRef.current;
    const era = eraRef.current;
    if (mountedRef.current) {
      setState((s) => ({
        ...s,
        error: null,
        pendingCount: s.pendingCount + 1,
      }));
    }
    const settle = (
      apply: (s: {
        data: Result | undefined;
        error: unknown;
        pendingCount: number;
      }) => { data: Result | undefined; error: unknown },
    ) => {
      if (!mountedRef.current) return;
      if (eraRef.current !== era) return;
      setState((s) => ({
        ...(generationRef.current === generation ? apply(s) : s),
        pendingCount: s.pendingCount - 1,
      }));
    };
    try {
      const result = await fnRef.current(...args);
      settle((s) => ({ ...s, data: result, error: null }));
      return result;
    } catch (error) {
      settle((s) => ({ ...s, error }));
      throw error;
    }
  }, []);

  const mutate = useCallback(
    (...args: Args): void => {
      mutateAsync(...args).catch(() => {
        // failure is owned by the hook state; a floating mutate is safe
      });
    },
    [mutateAsync],
  );

  const reset = useCallback(() => {
    generationRef.current++;
    eraRef.current++;
    setState(IDLE_MUTATION);
  }, []);

  return {
    mutate,
    mutateAsync,
    data: state.data,
    error: state.error,
    isPending: state.pendingCount > 0,
    reset,
  };
}

const IDLE_MUTATION = {
  data: undefined,
  error: null,
  pendingCount: 0,
};
