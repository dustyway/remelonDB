import { Platform } from 'react-native'
import { synchronize, type Database } from '@remelondb/core'
import { wire } from 'example-todo-sync/schema'

// Android emulators reach the host machine at 10.0.2.2; iOS simulators
// share the host's localhost. A device on your network needs your
// machine's LAN address here.
const BASE =
  Platform.OS === 'android' ? 'http://10.0.2.2:8787' : 'http://localhost:8787'

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
  const response = await fetch(`${BASE}/sync/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
  return response.json()
}

// Same shape as the web client's sync.ts: wire-validated handlers, and
// any failure reads as "offline" — writes stay local until a sync lands.
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
