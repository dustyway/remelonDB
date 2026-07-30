/**
 * A small state machine around Database.open, so apps don't hand-roll
 * one: concurrent init() calls share a single in-flight open (cleared
 * in a finally, so a failed open stays retryable), and each attempt is
 * epoch-tagged so a superseded attempt's onTakenOver cannot touch a
 * newer database. Framework-free and driver-agnostic: the `open`
 * factory wires the takeover callback wherever the platform wants it.
 * React bindings live in `@remelondb/core/react`.
 */
import type { Database } from './Database'

export type DatabaseManagerStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'error'
  | 'taken-over'

export interface DatabaseManagerState {
  readonly status: DatabaseManagerStatus
  readonly error: Error | null
}

export interface DatabaseManagerOptions {
  /** Open the database; wire `onTakenOver` into the driver if the
   * platform has takeover semantics. Called once per (re)init attempt. */
  readonly open: (onTakenOver: () => void) => Promise<Database>
}

export interface DatabaseManager {
  /** Current lifecycle state; stable object, replaced on change. */
  readonly state: DatabaseManagerState
  /** The open database. Throws before ready and after a takeover. */
  readonly database: Database
  /** Open (or reopen after error/takeover). Concurrent calls share one
   * attempt; when ready, resolves with the existing database. */
  init(): Promise<Database>
  /** Listen for state changes. Emits the current state immediately.
   * Returns the unsubscribe function. */
  subscribe(listener: (state: DatabaseManagerState) => void): () => void
}

export function createDatabaseManager(
  options: DatabaseManagerOptions,
): DatabaseManager {
  let state: DatabaseManagerState = { status: 'idle', error: null }
  let database: Database | null = null
  let initPromise: Promise<Database> | null = null
  let epoch = 0
  const listeners = new Set<(state: DatabaseManagerState) => void>()

  const setState = (next: DatabaseManagerState): void => {
    state = next
    for (const listener of [...listeners]) {
      listener(state)
    }
  }

  const init = (): Promise<Database> => {
    if (database) {
      return Promise.resolve(database)
    }
    if (initPromise) {
      return initPromise
    }
    const attempt = ++epoch
    setState({ status: 'loading', error: null })
    initPromise = options
      .open(() => {
        if (attempt !== epoch) {
          return // a stale life's takeover — a newer attempt owns the state
        }
        database = null
        setState({
          status: 'taken-over',
          error: new Error(
            'Database taken over by another tab — call init() to reclaim it',
          ),
        })
      })
      .then(
        (opened) => {
          database = opened
          setState({ status: 'ready', error: null })
          return opened
        },
        (error: unknown) => {
          const wrapped =
            error instanceof Error ? error : new Error(String(error))
          setState({ status: 'error', error: wrapped })
          throw wrapped
        },
      )
      .finally(() => {
        initPromise = null
      })
    return initPromise
  }

  return {
    get state() {
      return state
    },
    get database() {
      if (!database) {
        throw new Error(
          state.status === 'taken-over'
            ? 'Database was taken over by another tab — call init() to reclaim it'
            : 'Database is not initialized — call init() first',
        )
      }
      return database
    },
    init,
    subscribe(listener) {
      listeners.add(listener)
      listener(state)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
