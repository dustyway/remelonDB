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
  useContext,
  useMemo,
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
