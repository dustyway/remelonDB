/**
 * React bindings for the database manager. A separate subpath (like
 * `./zod`) so core itself never depends on react — this module loads
 * only when imported, and react is an optional peer.
 */
import { useSyncExternalStore } from 'react'
import type { DatabaseManager, DatabaseManagerState } from '../index'

/**
 * Subscribe a component to a manager's lifecycle state. Tear-safe via
 * useSyncExternalStore; re-renders exactly on state transitions.
 *
 *     const { status, error } = useDatabaseState(manager)
 */
export function useDatabaseState(manager: DatabaseManager): DatabaseManagerState {
  return useSyncExternalStore(
    (onStoreChange) => manager.subscribe(onStoreChange),
    () => manager.state,
    () => manager.state,
  )
}
