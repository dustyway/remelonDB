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
} from 'react'
import type { Database, DatabaseManager, DatabaseManagerState } from '../index'
import type { Query } from '../database/Query'

type Unsubscribe = () => void

// ---------------------------------------------------------------------------
// Provider

const ManagerContext = createContext<DatabaseManager | null>(null)

/**
 * Provide a database manager to the zero-argument hooks below.
 *
 *     <DatabaseProvider manager={manager}><App /></DatabaseProvider>
 */
export function DatabaseProvider(props: {
  manager: DatabaseManager
  children?: ReactNode
}) {
  return createElement(
    ManagerContext.Provider,
    { value: props.manager },
    props.children,
  )
}

function useManager(manager?: DatabaseManager): DatabaseManager {
  const fromContext = useContext(ManagerContext)
  const resolved = manager ?? fromContext
  if (!resolved) {
    throw new Error(
      'remelonDB: no database manager. Pass one explicitly or wrap the tree in <DatabaseProvider>.',
    )
  }
  return resolved
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
export function useDatabaseState(manager?: DatabaseManager): DatabaseManagerState {
  const m = useManager(manager)
  return useSyncExternalStore(
    (onStoreChange) => m.subscribe(onStoreChange),
    () => m.state,
    () => m.state,
  )
}

/**
 * The open database, or null until the manager reaches `ready`.
 *
 *     const db = useDatabase()
 *     const { data } = useQuery(db && getDecksQuery(db))
 */
export function useDatabase(manager?: DatabaseManager): Database | null {
  const m = useManager(manager)
  return useSyncExternalStore(
    (onStoreChange) => m.subscribe(onStoreChange),
    () => (m.state.status === 'ready' ? m.database : null),
    () => null,
  )
}

// ---------------------------------------------------------------------------
// Query hooks

export interface QueryResult<M> {
  readonly data: M[]
  readonly isLoading: boolean
  readonly error: Error | null
}

export interface QueryCountResult {
  readonly data: number
  readonly isLoading: boolean
  readonly error: Error | null
}

/** Shared refcounted store: starts the observation on first subscriber,
 * stops it when the last one leaves, caches the latest snapshot. */
function createStore<T>(
  initial: T,
  start: (set: (value: T) => void) => Unsubscribe,
) {
  let value = initial
  let stop: Unsubscribe | null = null
  const listeners = new Set<() => void>()
  return {
    subscribe(listener: () => void): Unsubscribe {
      listeners.add(listener)
      if (listeners.size === 1) {
        stop = start((next) => {
          value = next
          for (const l of listeners) l()
        })
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && stop) {
          stop()
          stop = null
          value = initial
        }
      }
    },
    snapshot: () => value,
    idle: () => listeners.size === 0,
  }
}

const LOADING: QueryResult<never> = { data: [], isLoading: true, error: null }
const NO_QUERY: QueryResult<never> = { data: [], isLoading: false, error: null }
const noStore = {
  subscribe: (_: () => void): Unsubscribe => () => {},
  snapshot: () => NO_QUERY,
}

/** Structural identity: same table, same clauses → same subscription. */
function queryKey(query: Query<unknown>): string {
  return `${query.collection.schema.name}:${JSON.stringify(query.description)}`
}

/**
 * Shared per-database registry: components observing structurally equal
 * queries share one live observation (refcounted, removed when the last
 * subscriber leaves). This is what keeps a screen with five widgets on
 * the same query at one subscription instead of five.
 */
const registries = new WeakMap<object, Map<string, ReturnType<typeof createStore<never>>>>()

function sharedStore<T>(
  database: object,
  key: string,
  make: () => ReturnType<typeof createStore<T>>,
): ReturnType<typeof createStore<T>> {
  let registry = registries.get(database)
  if (!registry) {
    registry = new Map()
    registries.set(database, registry)
  }
  let store = registry.get(key) as ReturnType<typeof createStore<T>> | undefined
  if (!store) {
    const created = make()
    store = {
      subscribe(listener) {
        const stop = created.subscribe(listener)
        return () => {
          stop()
          if (created.idle()) registry!.delete(key)
        }
      },
      snapshot: created.snapshot,
      idle: created.idle,
    }
    registry.set(key, store as ReturnType<typeof createStore<never>>)
  }
  return store
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
  readonly data: T
  readonly isLoading: boolean
  readonly error: Error | null
}

export function useQuery<M>(
  query: Query<M> | null | undefined,
): QueryResult<M>
export function useQuery<M, T>(
  query: Query<M> | null | undefined,
  options: {
    /**
     * Derive the rendered value from the rows. Runs when the rows
     * change (per consumer, so different components can select
     * differently from one shared subscription); must be pure. The
     * Changing the function recomputes the selected value without
     * restarting the shared query observation.
     */
    select: (rows: M[]) => T
  },
): SelectedResult<T>
export function useQuery<M, T>(
  query: Query<M> | null | undefined,
  options?: { select?: (rows: M[]) => T },
): QueryResult<M> | SelectedResult<T> {
  const database = query ? query.collection.database : null
  const key = query ? queryKey(query) : null
  // The first structurally-equal query instance is captured for the
  // subscription; later equivalent instances are deliberately ignored.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const store = useMemo(() => {
    if (!query || !database || !key) return noStore
    return sharedStore<QueryResult<M>>(database, `q:${key}`, () => {
      let latest: M[] = []
      return createStore<QueryResult<M>>(LOADING as QueryResult<M>, (set) =>
        query.observe(
          (data) => {
            latest = data
            set({ data, isLoading: false, error: null })
          },
          (error) => set({ data: latest, isLoading: false, error }),
        ),
      )
    })
  }, [database, key])
  const raw = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
    store.snapshot,
  ) as QueryResult<M>
  const select = options?.select
  return useMemo<QueryResult<M> | SelectedResult<T>>(() => {
    if (!select) return raw
    return { isLoading: raw.isLoading, error: raw.error, data: select(raw.data) }
  }, [raw, select])
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
  const database = query ? query.collection.database : null
  const key = query ? queryKey(query) : null
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const store = useMemo(() => {
    if (!query || !database || !key) return null
    return sharedStore<QueryCountResult>(database, `c:${key}`, () => {
      let latest = 0
      return createStore<QueryCountResult>(
        { data: 0, isLoading: true, error: null },
        (set) =>
          query.observeCount(
            (data) => {
              latest = data
              set({ data, isLoading: false, error: null })
            },
            (error) => set({ data: latest, isLoading: false, error }),
          ),
      )
    })
  }, [database, key])
  return useSyncExternalStore(
    store ? store.subscribe : noStore.subscribe,
    store ? store.snapshot : () => NO_COUNT,
    store ? store.snapshot : () => NO_COUNT,
  ) as QueryCountResult
}

const NO_COUNT: QueryCountResult = {
  data: 0,
  isLoading: false,
  error: null,
}

/** Backward-compatible convenience form; use `useQueryCountResult` when
 * loading and error state matter. */
export function useQueryCount(
  query: Query<unknown> | null | undefined,
): number {
  return useQueryCountResult(query).data
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
  mutate: (...args: Args) => void
  /**
   * Awaitable form with normal promise semantics: resolves with the
   * mutation result, rejects with the original error. For workflows
   * that must continue only after success (close a dialog once the
   * write commits). Drives the same state as `mutate`.
   */
  mutateAsync: (...args: Args) => Promise<Result>
  /** Result of the most recent completed invocation that still owns state. */
  data: Result | undefined
  /** Failure of the owning invocation; cleared when a new one starts. */
  error: unknown
  /** True while any tracked invocation is in flight. */
  isPending: boolean
  /** Back to idle: clears data and error, in-flight completions are ignored. */
  reset: () => void
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
    data: Result | undefined
    error: unknown
    pendingCount: number
  }>(IDLE_MUTATION)

  const fnRef = useRef(mutationFn)
  fnRef.current = mutationFn
  // generation guards ownership: bumped by each invocation and by reset,
  // so stale completions cannot write data/error. mountedRef guards
  // against state updates after unmount.
  const generationRef = useRef(0)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const mutateAsync = useCallback(async (...args: Args): Promise<Result> => {
    const generation = ++generationRef.current
    if (mountedRef.current) {
      setState((s) => ({ ...s, error: null, pendingCount: s.pendingCount + 1 }))
    }
    const settle = (
      apply: (s: {
        data: Result | undefined
        error: unknown
        pendingCount: number
      }) => { data: Result | undefined; error: unknown },
    ) => {
      if (!mountedRef.current) return
      setState((s) => ({
        ...(generationRef.current === generation ? apply(s) : s),
        pendingCount: s.pendingCount - 1,
      }))
    }
    try {
      const result = await fnRef.current(...args)
      settle((s) => ({ ...s, data: result, error: null }))
      return result
    } catch (error) {
      settle((s) => ({ ...s, error }))
      throw error
    }
  }, [])

  const mutate = useCallback(
    (...args: Args): void => {
      mutateAsync(...args).catch(() => {
        // failure is owned by the hook state; a floating mutate is safe
      })
    },
    [mutateAsync],
  )

  const reset = useCallback(() => {
    generationRef.current++
    setState((s) => ({ ...IDLE_MUTATION, pendingCount: s.pendingCount }))
  }, [])

  return {
    mutate,
    mutateAsync,
    data: state.data,
    error: state.error,
    isPending: state.pendingCount > 0,
    reset,
  }
}

const IDLE_MUTATION = {
  data: undefined,
  error: null,
  pendingCount: 0,
}
