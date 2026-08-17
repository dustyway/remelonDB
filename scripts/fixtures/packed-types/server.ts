// Inference pins for the packed server + zod adapter declarations.
import type { SyncPullResult, SyncPushResult } from '@remelondb/core'
import { syncSchemas, zodTable } from '@remelondb/core/zod'
import { createMemoryStore, createSyncEngine } from '@remelondb/server'
import { z } from 'zod'

const Item = z.object({ name: z.string() })
const items = zodTable('items', Item)
items.columns.name.type satisfies string

const engine = createSyncEngine({
  store: createMemoryStore(),
  tables: { items: { validate: (row) => Item.safeParse(row).success } },
})
const handlers = engine.as('user-1')
void (handlers.pull({
  cursor: null,
  schemaVersion: 1,
  migration: null,
}) satisfies Promise<SyncPullResult>)
void (handlers.push({ changes: {}, cursor: '0' }) satisfies Promise<SyncPushResult>)

const schemas = syncSchemas({ items: Item })
void schemas.pullResult

export {}
