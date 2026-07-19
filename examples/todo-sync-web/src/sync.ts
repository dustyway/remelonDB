import { synchronize, type Database } from '@remelondb/core'
import { wire } from 'example-todo-sync/schema'

export type SyncStatus = 'syncing' | 'synced' | 'offline'

let status: SyncStatus = 'syncing'
const listeners = new Set<() => void>()
const setStatus = (next: SyncStatus): void => {
  if (status === next) return
  status = next
  for (const listener of listeners) listener()
}
export const getSyncStatus = (): SyncStatus => status
export const subscribeSyncStatus = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const post = async (path: string, body: unknown): Promise<unknown> => {
  const response = await fetch(`/sync/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
  return response.json()
}

// Server responses are validated with the same wire schemas the server
// validates requests with — neither side trusts the network.
// Any failure reads as "offline"; writes stay local and the next
// successful sync pushes them. A real app would distinguish network
// failures from protocol errors.
export const runSync = async (db: Database): Promise<void> => {
  try {
    await synchronize({
      database: db,
      pullChanges: async (args) =>
        wire.pullResult.parse(await post('pull', args)),
      pushChanges: async (args) =>
        wire.pushResult.parse(await post('push', args)),
    })
    setStatus('synced')
  } catch {
    setStatus('offline')
  }
}
