/**
 * The in-memory SyncStore: the seam's executable illustration and a
 * test double for client code. Single-threaded, so snapshot consistency
 * and per-scope push serialization hold trivially; a real adapter earns
 * them with transactions and a per-scope lock.
 */
import type { StoredChange, SyncStore, SyncStoreTx, WireRow } from './store'

interface Stored {
  readonly row: WireRow
  readonly rev: number
  readonly deleted: boolean
}

export interface MemoryStore extends SyncStore<string> {
  /** Prune tombstones with rev <= floor and refuse older cursors. */
  gc(floor: number): void
}

/**
 * The in-process reference `SyncStore`: complete protocol semantics, no
 * persistence. Right for demos, tests, and as the model for real
 * adapters; state lives and dies with the process.
 * @category Store seam
 */
export function createMemoryStore(): MemoryStore {
  // scope -> table -> id -> row state
  const scopes = new Map<string, Map<string, Map<string, Stored>>>()
  let rev = 0
  let floor = 0

  const tableOf = (scope: string, table: string): Map<string, Stored> => {
    let tables = scopes.get(scope)
    if (!tables) scopes.set(scope, (tables = new Map()))
    let rows = tables.get(table)
    if (!rows) tables.set(table, (rows = new Map()))
    return rows
  }

  const txFor = (scope: string): SyncStoreTx<string> => ({
    changedSince: async (table, txScope, since) => {
      const changes: StoredChange[] = []
      for (const stored of tableOf(txScope, table).values()) {
        if (stored.rev <= since) continue
        changes.push({
          id: stored.row.id,
          rev: stored.rev,
          row: stored.deleted ? null : stored.row,
        })
      }
      return changes
    },
    maxRev: async (txScope) => {
      let max = 0
      const tables = scopes.get(txScope)
      for (const rows of tables?.values() ?? []) {
        for (const stored of rows.values()) {
          if (stored.rev > max) max = stored.rev
        }
      }
      return max
    },
    currentRevs: async (table, txScope, ids) => {
      const rows = tableOf(txScope, table)
      const revs = new Map<string, number>()
      for (const id of ids) {
        const stored = rows.get(id)
        if (stored) revs.set(id, stored.rev)
      }
      return revs
    },
    foreignIds: async (table, txScope, ids) => {
      const foreign: string[] = []
      for (const [otherScope, tables] of scopes) {
        if (otherScope === txScope) continue
        const rows = tables.get(table)
        if (!rows) continue
        for (const id of ids) {
          if (rows.has(id)) foreign.push(id)
        }
      }
      return foreign
    },
    upsert: async (table, txScope, rows) => {
      const stored = tableOf(txScope, table)
      const batchRev = ++rev
      for (const row of rows) {
        const existing = stored.get(row.id)
        if (existing?.deleted) continue // tombstones stay dead
        stored.set(row.id, { row, rev: batchRev, deleted: false })
      }
    },
    tombstone: async (table, txScope, ids) => {
      const stored = tableOf(txScope, table)
      const batchRev = ++rev
      for (const id of ids) {
        const existing = stored.get(id)
        if (!existing || existing.deleted) continue // no-op
        stored.set(id, { ...existing, rev: batchRev, deleted: true })
      }
    },
    gcFloor: async () => floor,
  })

  return {
    transaction: async (scope, _mode, work) => work(txFor(scope)),
    gc: (newFloor: number) => {
      floor = Math.max(floor, newFloor)
      for (const tables of scopes.values()) {
        for (const rows of tables.values()) {
          for (const [id, stored] of rows) {
            if (stored.deleted && stored.rev <= floor) rows.delete(id)
          }
        }
      }
    },
  }
}
