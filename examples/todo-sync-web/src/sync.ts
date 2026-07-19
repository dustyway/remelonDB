import { synchronize, type Database } from '@remelondb/core'
import { wire } from 'example-todo-sync/schema'

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
export const runSync = (db: Database): Promise<void> =>
  synchronize({
    database: db,
    pullChanges: async (args) => wire.pullResult.parse(await post('pull', args)),
    pushChanges: async (args) => wire.pushResult.parse(await post('push', args)),
  }).catch((error: unknown) => {
    console.warn('sync failed (will retry):', error)
  })
