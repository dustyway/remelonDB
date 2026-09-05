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
} from '@remelondb/core';
import type { StoredChange, SyncStore, SyncStoreTx, WireRow } from './store';

export interface SyncHandlers {
  pull(args: SyncPullArgs): Promise<SyncPullResult>;
  push(args: SyncPushArgs): Promise<SyncPushResult>;
}

/**
 * A request the engine cannot express in a protocol reply (sync-wire.md
 * treats it as malformed). Transports match on the class instead of the
 * message and answer 400.
 * @category Engine
 */
export class SyncProtocolError extends Error {
  constructor(
    readonly code: 'unusable-id' | 'invalid-rejection',
    message: string,
  ) {
    super(message);
    this.name = 'SyncProtocolError';
  }
}

export interface TableConfig {
  /** Per-record validation; false lands the id in `rejected`. */
  readonly validate?: (row: WireRow) => boolean;
  /**
   * Rows may only be created: a write naming an id that already exists
   * in the scope (live or tombstoned) is rejected by id. Deletes still
   * apply, so parent cascades keep working.
   */
  readonly appendOnly?: boolean;
}

export interface SyncEngineOptions<Scope> {
  readonly store: SyncStore<Scope>;
  readonly tables: { readonly [table: string]: TableConfig };
  /**
   * Cross-record checks (referential integrity across the push);
   * returns extra rejections by table. Runs after per-record
   * validation, before anything applies.
   */
  readonly crossValidate?: (
    tx: SyncStoreTx<Scope>,
    scope: Scope,
    rows: { readonly [table: string]: readonly WireRow[] },
  ) => Promise<{ readonly [table: string]: readonly string[] }>;
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
        readonly rows: readonly WireRow[];
        readonly deleted: readonly string[];
      };
    },
  ) => Promise<{ readonly [table: string]: readonly string[] }>;
}

const decodeCursor = (cursor: string): number | null => {
  const rev = Number(cursor);
  return Number.isInteger(rev) && rev >= 0 ? rev : null;
};

const toChanges = (
  byTable: ReadonlyMap<string, readonly StoredChange[]>,
  exclude: ReadonlyMap<string, ReadonlySet<string>>,
): SyncChanges => {
  const changes: Record<
    string,
    { created: WireRow[]; updated: WireRow[]; deleted: string[] }
  > = {};
  for (const [table, stored] of byTable) {
    const set = {
      created: [],
      updated: [],
      deleted: [],
    } as (typeof changes)[string];
    const excludeIds = exclude.get(table);
    for (const change of stored) {
      if (excludeIds?.has(change.id)) continue;
      if (change.row === null) set.deleted.push(change.id);
      else set.updated.push(change.row);
    }
    changes[table] = set;
  }
  return changes;
};

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
export function createSyncEngine<Scope>(options: SyncEngineOptions<Scope>): {
  as(scope: Scope): SyncHandlers;
} {
  const tableNames = Object.keys(options.tables);

  const collectSince = async (
    tx: SyncStoreTx<Scope>,
    scope: Scope,
    since: number,
  ): Promise<Map<string, readonly StoredChange[]>> => {
    const byTable = new Map<string, readonly StoredChange[]>();
    for (const table of tableNames) {
      byTable.set(table, await tx.changedSince(table, scope, since));
    }
    return byTable;
  };

  const as = (scope: Scope): SyncHandlers => ({
    pull: async (args) => {
      const full = args.cursor === null;
      const decoded = args.cursor === null ? 0 : decodeCursor(args.cursor);
      return options.store.transaction(scope, 'pull', async (tx) => {
        const floor = await tx.gcFloor();
        // pruning can drop a scope's live max below the floor (the
        // tombstone held it) and a quiet scope's max may never reach a
        // global floor; served history extends to the floor, so cursors
        // live in [floor, effMax] and issued cursors never fall below it
        const effMax = Math.max(await tx.maxRev(scope), floor);
        // a full pull is always complete: a snapshot carries no
        // deletions, so pruned tombstones cannot be missing from it
        if (
          decoded === null ||
          (!full && (decoded < floor || decoded > effMax))
        ) {
          return { resyncRequired: true }; // unknown or expired cursor
        }
        const since = decoded;
        const effectiveSince = args.migration !== null ? 0 : since;
        return {
          changes: toChanges(
            await collectSince(tx, scope, effectiveSince),
            new Map(),
          ),
          cursor: String(Math.max(since, effMax)),
        };
      });
    },

    push: async (args) => {
      const since = decodeCursor(args.cursor);
      if (since === null) return { conflict: true };

      // partition the request per table; unusable ids cannot be named
      // in `rejected`, so they are a malformed request (thrown)
      const rejected: Record<string, string[]> = {};
      const parsed = tableNames.map((table) => {
        const change = args.changes[table];
        // created/updated are advisory labels over the same upsert, so a
        // changeset stating one id twice means the last statement wins —
        // batch stores cannot touch the same row twice in one upsert
        const byId = new Map<string, WireRow>();
        for (const raw of [
          ...(change?.created ?? []),
          ...(change?.updated ?? []),
        ]) {
          const id = raw['id'];
          if (typeof id !== 'string' || id.length === 0) {
            throw new SyncProtocolError(
              'unusable-id',
              'sync push: record without a usable id',
            );
          }
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the check above proves `raw['id']` is a non-empty string, which is all WireRow adds to DirtyRaw.
          byId.set(id, raw as WireRow);
        }
        // a deletion is the terminal statement for its id: an id named in
        // `deleted` supersedes any created/updated content in the same
        // push. Without this, a rejection of the upsert half (validation,
        // append-only, a storage constraint) would leave the deletion
        // live, and the push would report the id rejected while applying
        // one of its effects anyway
        const deletes = [...new Set(change?.deleted ?? [])];
        for (const id of deletes) byId.delete(id);
        // every id this changeset names, before validation splits it —
        // the conflict scan must see all of them, or a row rejected here
        // escapes the stale check and its newer server rev is never
        // delivered (permanent divergence)
        const allIds = [...byId.keys(), ...deletes];
        return { table, rows: [...byId.values()], deletes, allIds };
      });

      return options.store.transaction(scope, 'push', async (tx) => {
        // A push cursor above the served max cannot be honest: `rev >
        // since` would never fire and the conflict scan would be
        // disabled wholesale. Reject it, as the reference server does.
        const effMax = Math.max(await tx.maxRev(scope), await tx.gcFloor());
        if (since > effMax) return { conflict: true };

        // Ownership first: a foreign row is not this scope's, so its rev
        // is incomparable to a scope-horizon cursor. Reject and exclude
        // it from the conflict scan and everything after.
        for (const entry of parsed) {
          if (entry.allIds.length === 0) continue;
          const foreign = new Set(
            await tx.foreignIds(entry.table, scope, entry.allIds),
          );
          if (foreign.size > 0) {
            (rejected[entry.table] ??= []).push(...foreign);
            entry.rows = entry.rows.filter((r) => !foreign.has(r.id));
            entry.deletes = entry.deletes.filter((id) => !foreign.has(id));
            entry.allIds = entry.allIds.filter((id) => !foreign.has(id));
          }
        }

        // Conflict dominates, and it is checked over EVERY non-foreign
        // requested id — including ids a later step will reject. A row
        // modified server-side after the cursor answers conflict before
        // it is ever judged stale, so the client re-pulls the newer
        // content instead of silently advancing its cursor past it. The
        // revs are kept for the append-only check below.
        const revsByTable = new Map<string, ReadonlyMap<string, number>>();
        for (const entry of parsed) {
          if (entry.allIds.length === 0) continue;
          const revs = await tx.currentRevs(entry.table, scope, entry.allIds);
          revsByTable.set(entry.table, revs);
          for (const rev of revs.values()) {
            if (rev > since) return { conflict: true };
          }
        }

        for (const entry of parsed) {
          const validate = options.tables[entry.table]?.validate;
          if (!validate) continue;
          entry.rows = entry.rows.filter((row) => {
            if (validate(row)) return true;
            (rejected[entry.table] ??= []).push(row.id);
            return false;
          });
        }

        // A hook may only reject ids that are in the request, keyed by a
        // table that exists: a phantom id would tell the client to keep
        // a record it has no dirty copy of and drop the real one from the
        // interleave. A violation is a server bug, surfaced as one.
        const requestedByTable = new Map(
          parsed.map((entry) => [entry.table, new Set(entry.allIds)]),
        );
        const applyExtraRejections = (extra: {
          readonly [table: string]: readonly string[];
        }): void => {
          for (const [table, ids] of Object.entries(extra)) {
            if (ids.length === 0) continue;
            const requested = requestedByTable.get(table);
            if (!requested) {
              throw new SyncProtocolError(
                'invalid-rejection',
                `sync push: hook rejected ids for unknown table '${table}'`,
              );
            }
            for (const id of ids) {
              if (!requested.has(id)) {
                throw new SyncProtocolError(
                  'invalid-rejection',
                  `sync push: hook rejected '${table}/${id}', not in the request`,
                );
              }
            }
            const drop = new Set(ids);
            (rejected[table] ??= []).push(...ids);
            const entry = parsed.find((p) => p.table === table);
            if (entry) {
              entry.rows = entry.rows.filter((r) => !drop.has(r.id));
              entry.deletes = entry.deletes.filter((id) => !drop.has(id));
            }
          }
        };
        if (options.crossValidate) {
          const rowsByTable = Object.fromEntries(
            parsed.map((entry) => [entry.table, entry.rows]),
          );
          applyExtraRejections(
            await options.crossValidate(tx, scope, rowsByTable),
          );
        }
        if (options.crossValidateChanges) {
          const changesByTable = Object.fromEntries(
            parsed.map((entry) => [
              entry.table,
              { rows: entry.rows, deleted: entry.deletes },
            ]),
          );
          applyExtraRejections(
            await options.crossValidateChanges(tx, scope, changesByTable),
          );
        }

        // Every named rev is now <= cursor, so a write aimed at a
        // tombstone would silently no-op (upsert MUST NOT resurrect) and
        // an append-only table would swallow it; both must be visible in
        // `rejected` or the client marks a refused write as synced.
        for (const entry of parsed) {
          if (entry.rows.length === 0) continue;
          const drop = new Set(
            await tx.tombstonedIds(
              entry.table,
              scope,
              entry.rows.map((r) => r.id),
            ),
          );
          if (options.tables[entry.table]?.appendOnly) {
            const revs = revsByTable.get(entry.table);
            for (const row of entry.rows) {
              if (revs?.has(row.id)) drop.add(row.id);
            }
          }
          if (drop.size > 0) {
            (rejected[entry.table] ??= []).push(...drop);
            entry.rows = entry.rows.filter((r) => !drop.has(r.id));
            entry.deletes = entry.deletes.filter((id) => !drop.has(id));
          }
        }

        for (const entry of parsed) {
          if (entry.rows.length > 0) {
            const refused = await tx.upsert(entry.table, scope, entry.rows);
            if (refused && refused.length > 0) {
              (rejected[entry.table] ??= []).push(...refused);
              const drop = new Set(refused);
              entry.deletes = entry.deletes.filter((id) => !drop.has(id));
            }
          }
        }
        for (const entry of parsed) {
          if (entry.deletes.length > 0) {
            await tx.tombstone(entry.table, scope, entry.deletes);
          }
        }

        const rejectedField =
          Object.keys(rejected).length > 0 ? { rejected } : {};

        // Collect the interleave, THEN read the floor: a gc committing
        // during the collect prunes deletions from the window and raises
        // the floor past them, so reading the floor after the collect
        // turns that race into an honest degrade instead of a lost
        // delete. The exclusion is keyed by (table, id): a bare id set
        // would suppress the same id in a different table.
        const collected = await collectSince(tx, scope, since);
        const floor = await tx.gcFloor();
        if (since < floor) {
          return { cursor: null, changes: null, ...rejectedField };
        }
        const requestIds = new Map<string, ReadonlySet<string>>(
          parsed.map((entry) => [
            entry.table,
            new Set([
              ...entry.rows.map((r) => r.id),
              ...entry.deletes,
              ...(rejected[entry.table] ?? []),
            ]),
          ]),
        );
        return {
          cursor: String(Math.max(await tx.maxRev(scope), floor)),
          changes: toChanges(collected, requestIds),
          ...rejectedField,
        };
      });
    },
  });

  return { as };
}
