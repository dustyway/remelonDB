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

/**
 * A request the engine cannot express in a protocol reply (sync-wire.md
 * treats it as malformed). Transports match on the class instead of the
 * message and answer 400.
 * @category Engine
 */
export class SyncProtocolError extends Error {
  constructor(
    readonly code: 'unusable-id',
    message: string,
  ) {
    super(message)
    this.name = 'SyncProtocolError'
  }
}

export interface TableConfig {
  /** Per-record validation; false lands the id in `rejected`. */
  readonly validate?: (row: WireRow) => boolean
  /**
   * Rows may only be created: a write naming an id that already exists
   * in the scope (live or tombstoned) is rejected by id. Deletes still
   * apply, so parent cascades keep working.
   */
  readonly appendOnly?: boolean
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
  /**
   * Like `crossValidate`, but sees the FULL proposed change set —
   * upserts and deletions — so referential rules can reject a delete.
   * Returned ids are rejected whether they name a row or a deletion.
   * Both hooks may be configured; their rejections merge.
   */
  readonly crossValidateChanges?: (
    tx: SyncStoreTx<Scope>,
    scope: Scope,
    changes: {
      readonly [table: string]: {
        readonly rows: readonly WireRow[]
        readonly deleted: readonly string[]
      }
    },
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
      const full = args.cursor === null
      const decoded = args.cursor === null ? 0 : decodeCursor(args.cursor)
      return options.store.transaction(scope, 'pull', async (tx) => {
        const floor = await tx.gcFloor()
        // pruning can drop a scope's live max below the floor (the
        // tombstone held it) and a quiet scope's max may never reach a
        // global floor; served history extends to the floor, so cursors
        // live in [floor, effMax] and issued cursors never fall below it
        const effMax = Math.max(await tx.maxRev(scope), floor)
        // a full pull is always complete: a snapshot carries no
        // deletions, so pruned tombstones cannot be missing from it
        if (decoded === null || (!full && (decoded < floor || decoded > effMax))) {
          return { resyncRequired: true } // unknown or expired cursor
        }
        const since = decoded
        const effectiveSince = args.migration !== null ? 0 : since
        return {
          changes: toChanges(
            await collectSince(tx, scope, effectiveSince),
            new Set(),
          ),
          cursor: String(Math.max(since, effMax)),
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
        // created/updated are advisory labels over the same upsert, so a
        // changeset stating one id twice means the last statement wins —
        // batch stores cannot touch the same row twice in one upsert
        const byId = new Map<string, WireRow>()
        for (const raw of [
          ...(change?.created ?? []),
          ...(change?.updated ?? []),
        ]) {
          const id = raw['id']
          if (typeof id !== 'string' || id.length === 0) {
            throw new SyncProtocolError('unusable-id', 'sync push: record without a usable id')
          }
          byId.set(id, raw as WireRow)
        }
        // a deletion is the terminal statement for its id: an id named in
        // `deleted` supersedes any created/updated content in the same
        // push. Without this, a rejection of the upsert half (validation,
        // append-only, a storage constraint) would leave the deletion
        // live, and the push would report the id rejected while applying
        // one of its effects anyway
        const deletes = [...new Set(change?.deleted ?? [])]
        for (const id of deletes) byId.delete(id)
        const rows: WireRow[] = []
        for (const row of byId.values()) {
          if (options.tables[table]?.validate?.(row) === false) {
            ;(rejected[table] ??= []).push(row.id)
          } else {
            rows.push(row)
          }
        }
        return { table, rows, deletes }
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
        const applyExtraRejections = (extra: {
          readonly [table: string]: readonly string[]
        }): void => {
          for (const [table, ids] of Object.entries(extra)) {
            if (ids.length === 0) continue
            const drop = new Set(ids)
            ;(rejected[table] ??= []).push(...ids)
            const entry = parsed.find((p) => p.table === table)
            if (entry) {
              entry.rows = entry.rows.filter((r) => !drop.has(r.id))
              entry.deletes = entry.deletes.filter((id) => !drop.has(id))
            }
          }
        }
        if (options.crossValidate) {
          const rowsByTable = Object.fromEntries(
            parsed.map((entry) => [entry.table, entry.rows]),
          )
          applyExtraRejections(await options.crossValidate(tx, scope, rowsByTable))
        }
        if (options.crossValidateChanges) {
          const changesByTable = Object.fromEntries(
            parsed.map((entry) => [
              entry.table,
              { rows: entry.rows, deleted: entry.deletes },
            ]),
          )
          applyExtraRejections(
            await options.crossValidateChanges(tx, scope, changesByTable),
          )
        }

        // conflict dominates what remains (the contract's MUST)
        const revsByTable = new Map<string, ReadonlyMap<string, number>>()
        for (const entry of parsed) {
          const ids = [...entry.rows.map((r) => r.id), ...entry.deletes]
          if (ids.length === 0) continue
          const revs = await tx.currentRevs(entry.table, scope, ids)
          revsByTable.set(entry.table, revs)
          for (const rev of revs.values()) {
            if (rev > since) return { conflict: true }
          }
        }

        // past the conflict check every named rev is <= cursor, so a
        // write aimed at a tombstone would silently no-op in the store
        // (upsert MUST NOT resurrect) and an append-only table would
        // swallow the change; both must be visible in `rejected` or the
        // client marks a refused write as synced and diverges for good
        for (const entry of parsed) {
          if (entry.rows.length === 0) continue
          const drop = new Set(
            await tx.tombstonedIds(
              entry.table,
              scope,
              entry.rows.map((r) => r.id),
            ),
          )
          if (options.tables[entry.table]?.appendOnly) {
            const revs = revsByTable.get(entry.table)
            for (const row of entry.rows) {
              if (revs?.has(row.id)) drop.add(row.id)
            }
          }
          if (drop.size > 0) {
            ;(rejected[entry.table] ??= []).push(...drop)
            entry.rows = entry.rows.filter((r) => !drop.has(r.id))
            // a rejected id leaves no effect: unreachable after the
            // deleted-supersedes normalization, kept as the invariant
            entry.deletes = entry.deletes.filter((id) => !drop.has(id))
          }
        }

        for (const entry of parsed) {
          if (entry.rows.length > 0) {
            const refused = await tx.upsert(entry.table, scope, entry.rows)
            if (refused && refused.length > 0) {
              // storage said no (constraint violation): same lane as
              // validation refusals — never silent, never a 500
              ;(rejected[entry.table] ??= []).push(...refused)
              const drop = new Set(refused)
              // a rejected id leaves no effect: unreachable after the
              // deleted-supersedes normalization, kept as the invariant
              entry.deletes = entry.deletes.filter((id) => !drop.has(id))
            }
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
          // never issue a cursor below the floor (same rule as pull)
          cursor: String(Math.max(await tx.maxRev(scope), floor)),
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
