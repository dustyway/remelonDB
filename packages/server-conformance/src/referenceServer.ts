/**
 * In-memory reference implementation of the sync wire protocol
 * (docs/sync-wire.md): a revision counter for the cursor, per-user row
 * stores, tombstones with a GC floor, whole-push conflict, per-record
 * rejection via injected validators, and the push fast path (cursor +
 * interleave, degrading below the floor). Single-threaded, so the
 * commit-order obligation holds trivially.
 *
 * It exists to prove the conformance suite against a known-good server
 * and as the executable illustration of the backend obligations. It is
 * not a persistence layer.
 */
import type {
  SyncChanges,
  SyncPullArgs,
  SyncPullResult,
  SyncPushArgs,
  SyncPushResult,
} from '@remelondb/core'
import type { DirtyRaw } from '@remelondb/core'

interface StoredRow {
  readonly row: DirtyRaw & { id: string }
  readonly rev: number
  readonly deleted: boolean
}

export interface ReferenceServerOptions {
  /** Per-table record validators; a false verdict lands the id in `rejected`. */
  readonly validate?: {
    readonly [table: string]: (row: DirtyRaw) => boolean
  }
}

export interface SyncHandlers {
  pull(args: SyncPullArgs): Promise<SyncPullResult>
  push(args: SyncPushArgs): Promise<SyncPushResult>
}

export interface ReferenceServer {
  /** The protocol operations, authenticated as `user`. */
  as(user: string): SyncHandlers
  /** Prune tombstones with rev <= floor and refuse older cursors. */
  gc(floor: number): void
}

/**
 * A complete in-memory sync server (engine + memory store) used as the
 * conformance suite's reference subject; handy as a test double for
 * client development too.
 */
export function createReferenceServer(
  options: ReferenceServerOptions = {},
): ReferenceServer {
  const users = new Map<string, Map<string, Map<string, StoredRow>>>()
  let rev = 0
  let gcFloor = 0

  const tablesOf = (user: string): Map<string, Map<string, StoredRow>> => {
    const existing = users.get(user)
    if (existing) return existing
    const created = new Map<string, Map<string, StoredRow>>()
    users.set(user, created)
    return created
  }
  const tableOf = (user: string, table: string): Map<string, StoredRow> => {
    const tables = tablesOf(user)
    const existing = tables.get(table)
    if (existing) return existing
    const created = new Map<string, StoredRow>()
    tables.set(table, created)
    return created
  }

  const decodeCursor = (cursor: string): number | null => {
    const since = Number(cursor)
    return Number.isInteger(since) && since >= 0 && since <= rev ? since : null
  }

  const changesSince = (
    user: string,
    since: number,
    exclude: ReadonlySet<string>,
  ): SyncChanges => {
    const changes: Record<
      string,
      { created: DirtyRaw[]; updated: DirtyRaw[]; deleted: string[] }
    > = {}
    for (const [table, rows] of tablesOf(user)) {
      const set = { created: [], updated: [], deleted: [] } as (typeof changes)[string]
      for (const stored of rows.values()) {
        if (stored.rev <= since || exclude.has(stored.row.id)) continue
        if (stored.deleted) set.deleted.push(stored.row.id)
        else set.updated.push(stored.row)
      }
      changes[table] = set
    }
    return changes
  }

  const maxRevOf = (user: string): number => {
    let max = 0
    for (const rows of tablesOf(user).values()) {
      for (const stored of rows.values()) {
        if (stored.rev > max) max = stored.rev
      }
    }
    return max
  }

  const as = (user: string): SyncHandlers => ({
    // eslint-independent async signatures keep parity with real servers
    pull: async (args) => {
      const since = args.cursor === null ? 0 : decodeCursor(args.cursor)
      if (since === null || since < gcFloor) {
        return { resyncRequired: true }
      }
      const effectiveSince = args.migration !== null ? 0 : since
      return {
        changes: changesSince(user, effectiveSince, new Set()),
        cursor: String(Math.max(since, maxRevOf(user))),
      }
    },
    push: async (args) => {
      const since = decodeCursor(args.cursor)
      if (since === null) return { conflict: true }

      const requestIds = new Set<string>()
      for (const change of Object.values(args.changes)) {
        for (const row of [...change.created, ...change.updated]) {
          requestIds.add(String(row['id']))
        }
        for (const id of change.deleted) requestIds.add(id)
      }
      // conflict dominates: any pushed record already past the cursor
      for (const rows of tablesOf(user).values()) {
        for (const stored of rows.values()) {
          if (requestIds.has(stored.row.id) && stored.rev > since) {
            return { conflict: true }
          }
        }
      }

      const rejected: Record<string, string[]> = {}
      const batchRev = ++rev
      for (const [table, change] of Object.entries(args.changes)) {
        const rows = tableOf(user, table)
        const validate = options.validate?.[table]
        for (const raw of [...change.created, ...change.updated]) {
          const row = raw as DirtyRaw & { id: string }
          if (validate && !validate(row)) {
            ;(rejected[table] ??= []).push(row.id)
            continue
          }
          const existing = rows.get(row.id)
          if (existing?.deleted) continue // tombstones stay dead
          rows.set(row.id, { row, rev: batchRev, deleted: false })
        }
        for (const id of change.deleted) {
          const existing = rows.get(id)
          if (!existing || existing.deleted) continue // no-op
          rows.set(id, { ...existing, rev: batchRev, deleted: true })
        }
      }

      const rejectedField =
        Object.keys(rejected).length > 0 ? { rejected } : {}
      // the fast path needs the COMPLETE interleave; below the GC floor
      // deletions are gone from the window, so degrade
      if (since < gcFloor) {
        return { cursor: null, changes: null, ...rejectedField }
      }
      return {
        cursor: String(maxRevOf(user)),
        changes: changesSince(user, since, requestIds),
        ...rejectedField,
      }
    },
  })

  return {
    as,
    gc: (floor: number) => {
      gcFloor = Math.max(gcFloor, floor)
      for (const tables of users.values()) {
        for (const rows of tables.values()) {
          for (const [id, stored] of rows) {
            if (stored.deleted && stored.rev <= gcFloor) rows.delete(id)
          }
        }
      }
    },
  }
}
