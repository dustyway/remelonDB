/**
 * The protocol engine: sync-wire.md implemented once over a SyncStore.
 * Produces SyncHandlers per scope — plain pull/push functions a route
 * handler or a test calls directly.
 */
import type {
  SyncChanges,
  SyncPullArgs,
  SyncPullResult,
  SyncPushArgs,
  SyncPushResult,
} from '@remelondb/core'
import type { StoredChange, SyncStore, SyncStoreTx, WireRow } from './store'

export interface SyncHandlers {
  pull(args: SyncPullArgs): Promise<SyncPullResult>
  push(args: SyncPushArgs): Promise<SyncPushResult>
}

export interface TableConfig {
  /** Per-record validation; false lands the id in `rejected`. */
  readonly validate?: (row: WireRow) => boolean
}

export interface SyncEngineOptions<Scope> {
  readonly store: SyncStore<Scope>
  readonly tables: { readonly [table: string]: TableConfig }
  /**
   * Cross-record checks (referential integrity across the push);
   * returns extra rejections by table. Runs after per-record
   * validation, before anything applies.
   */
  readonly crossValidate?: (
    tx: SyncStoreTx<Scope>,
    scope: Scope,
    rows: { readonly [table: string]: readonly WireRow[] },
  ) => Promise<{ readonly [table: string]: readonly string[] }>
}

const decodeCursor = (cursor: string): number | null => {
  const rev = Number(cursor)
  return Number.isInteger(rev) && rev >= 0 ? rev : null
}

const toChanges = (
  byTable: ReadonlyMap<string, readonly StoredChange[]>,
  exclude: ReadonlySet<string>,
): SyncChanges => {
  const changes: Record<
    string,
    { created: WireRow[]; updated: WireRow[]; deleted: string[] }
  > = {}
  for (const [table, stored] of byTable) {
    const set = { created: [], updated: [], deleted: [] } as (typeof changes)[string]
    for (const change of stored) {
      if (exclude.has(change.id)) continue
      if (change.row === null) set.deleted.push(change.id)
      else set.updated.push(change.row)
    }
    changes[table] = set
  }
  return changes
}

/**
 * The wire protocol's semantics over a `SyncStore`: cursors, the push
 * interleave, per-row validation and rejection, scoping. Storage is the
 * adapter's job; every obligation that can be wrong lives here, once.
 *
 * @example
 * ```ts
 * const engine = createSyncEngine({
 *   store: createMemoryStore(),
 *   tables: { todos: { validate: (row) => Todo.safeParse(row).success } },
 * })
 * const handlers = engine.as(userId)   // { pull(args), push(args) }
 * ```
 * @category Engine
 */
export function createSyncEngine<Scope>(
  options: SyncEngineOptions<Scope>,
): { as(scope: Scope): SyncHandlers } {
  const tableNames = Object.keys(options.tables)

  const collectSince = async (
    tx: SyncStoreTx<Scope>,
    scope: Scope,
    since: number,
  ): Promise<Map<string, readonly StoredChange[]>> => {
    const byTable = new Map<string, readonly StoredChange[]>()
    for (const table of tableNames) {
      byTable.set(table, await tx.changedSince(table, scope, since))
    }
    return byTable
  }

  const as = (scope: Scope): SyncHandlers => ({
    pull: async (args) => {
      const since = args.cursor === null ? 0 : decodeCursor(args.cursor)
      return options.store.transaction(scope, 'pull', async (tx) => {
        const floor = await tx.gcFloor()
        const max = await tx.maxRev(scope)
        if (since === null || since < floor || since > max) {
          return { resyncRequired: true } // unknown or expired cursor
        }
        const effectiveSince = args.migration !== null ? 0 : since
        return {
          changes: toChanges(
            await collectSince(tx, scope, effectiveSince),
            new Set(),
          ),
          cursor: String(Math.max(since, max)),
        }
      })
    },

    push: async (args) => {
      const since = decodeCursor(args.cursor)
      if (since === null) return { conflict: true }

      // partition the request per table; unusable ids cannot be named
      // in `rejected`, so they are a malformed request (thrown)
      const rejected: Record<string, string[]> = {}
      const parsed = tableNames.map((table) => {
        const change = args.changes[table]
        const rows: WireRow[] = []
        for (const raw of [
          ...(change?.created ?? []),
          ...(change?.updated ?? []),
        ]) {
          const id = raw['id']
          if (typeof id !== 'string' || id.length === 0) {
            throw new Error('sync push: record without a usable id')
          }
          const row = raw as WireRow
          if (options.tables[table]?.validate?.(row) === false) {
            ;(rejected[table] ??= []).push(id)
          } else {
            rows.push(row)
          }
        }
        return {
          table,
          rows,
          deletes: [...(change?.deleted ?? [])],
        }
      })

      return options.store.transaction(scope, 'push', async (tx) => {
        // ownership rejections precede the stale check: cursors are
        // horizons over the scope's own rows, so a foreign row's rev is
        // incomparable and must not force conflict loops
        for (const entry of parsed) {
          const ids = [...entry.rows.map((r) => r.id), ...entry.deletes]
          if (ids.length === 0) continue
          const foreign = new Set(await tx.foreignIds(entry.table, scope, ids))
          if (foreign.size > 0) {
            ;(rejected[entry.table] ??= []).push(...foreign)
            entry.rows = entry.rows.filter((r) => !foreign.has(r.id))
            entry.deletes = entry.deletes.filter((id) => !foreign.has(id))
          }
        }
        if (options.crossValidate) {
          const rowsByTable = Object.fromEntries(
            parsed.map((entry) => [entry.table, entry.rows]),
          )
          const extra = await options.crossValidate(tx, scope, rowsByTable)
          for (const [table, ids] of Object.entries(extra)) {
            if (ids.length === 0) continue
            const drop = new Set(ids)
            ;(rejected[table] ??= []).push(...ids)
            const entry = parsed.find((p) => p.table === table)
            if (entry) entry.rows = entry.rows.filter((r) => !drop.has(r.id))
          }
        }

        // conflict dominates what remains (the contract's MUST)
        for (const entry of parsed) {
          const ids = [...entry.rows.map((r) => r.id), ...entry.deletes]
          if (ids.length === 0) continue
          const revs = await tx.currentRevs(entry.table, scope, ids)
          for (const rev of revs.values()) {
            if (rev > since) return { conflict: true }
          }
        }

        for (const entry of parsed) {
          if (entry.rows.length > 0) {
            await tx.upsert(entry.table, scope, entry.rows)
          }
        }
        for (const entry of parsed) {
          if (entry.deletes.length > 0) {
            await tx.tombstone(entry.table, scope, entry.deletes)
          }
        }

        const rejectedField =
          Object.keys(rejected).length > 0 ? { rejected } : {}
        const floor = await tx.gcFloor()
        // the fast path needs the COMPLETE interleave; below the floor
        // deletions are gone from the window — degrade (the obligation
        // the formal model found)
        if (since < floor) {
          return { cursor: null, changes: null, ...rejectedField }
        }
        const requestIds = new Set(
          parsed
            .flatMap((entry) => [
              ...entry.rows.map((r) => r.id),
              ...entry.deletes,
            ])
            .concat(Object.values(rejected).flat()),
        )
        return {
          cursor: String(await tx.maxRev(scope)),
          changes: toChanges(
            await collectSince(tx, scope, since),
            requestIds,
          ),
          ...rejectedField,
        }
      })
    },
  })

  return { as }
}
