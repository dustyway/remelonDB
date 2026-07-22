import { useEffect, useState } from 'react'
import { synchronize, type Database } from '@remelondb/core'
import { wire } from './schema'

// The entire React bridge: observe() is the reactivity, this hook only
// pipes emissions into state. Callers must memoize the query — a new
// object every render would resubscribe every render.
export function useQuery<R>(query: {
  observe(onChange: (records: R[]) => void): () => void
}): R[] {
  const [records, setRecords] = useState<R[]>([])
  useEffect(() => query.observe(setRecords), [query])
  return records
}

export type SyncStatus = 'syncing' | 'synced' | 'offline'

// Shared by the web and native clients; `base` is the only platform
// difference — web syncs same-origin (''), native needs an absolute
// host. Server responses are validated with the same wire schemas the
// server validates requests with — neither side trusts the network.
// Any failure reads as "offline"; writes stay local and the next
// successful sync pushes them. A real app would distinguish network
// failures from protocol errors.
export function createSync(base: string) {
  let status: SyncStatus = 'syncing'
  const listeners = new Set<() => void>()
  const setStatus = (next: SyncStatus): void => {
    if (status === next) return
    status = next
    for (const listener of listeners) listener()
  }

  const post = async (path: string, body: unknown): Promise<unknown> => {
    const response = await fetch(`${base}/sync/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
    return response.json()
  }

  return {
    getSyncStatus: (): SyncStatus => status,
    subscribeSyncStatus: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    runSync: async (db: Database): Promise<void> => {
      try {
        await synchronize({
          database: db,
          // sync lifecycle in the console (conflict retries, resyncs) —
          // the e2e acts assert on these lines
          log: (message) => console.log(message),
          pullChanges: async (args) =>
            wire.pullResult.parse(await post('pull', args)),
          pushChanges: async (args) =>
            wire.pushResult.parse(await post('push', args)),
        })
        setStatus('synced')
      } catch {
        setStatus('offline')
      }
    },
  }
}
