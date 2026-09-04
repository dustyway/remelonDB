/**
 * The Postgres SyncStore (docs/server-design.md) over drizzle-orm:
 * config per table, methods generated. The store earns the seam's
 * obligations with a global revision sequence, a per-scope advisory
 * lock on push, and tombstones that never resurrect.
 */
import {
  and,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  sql,
} from 'drizzle-orm';
import type { InferInsertModel, SQL } from 'drizzle-orm';
import type {
  PgColumn,
  PgDatabase,
  PgQueryResultHKT,
  PgTable,
} from 'drizzle-orm/pg-core';
import type {
  StoredChange,
  SyncStore,
  SyncStoreTx,
  WireRow,
} from '@remelondb/server';

export type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;
export type DrizzleTx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

/**
 * Scoped-query replacements for tables whose scope is derived (e.g. a
 * child owned through its parent). Config-only tables never need these.
 */
export interface TableOverrides<Scope> {
  changedSince?(
    tx: DrizzleTx,
    scope: Scope,
    since: number,
  ): Promise<readonly StoredChange[]>;
  currentRevs?(
    tx: DrizzleTx,
    scope: Scope,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, number>>;
  foreignIds?(
    tx: DrizzleTx,
    scope: Scope,
    ids: readonly string[],
  ): Promise<readonly string[]>;
  tombstonedIds?(
    tx: DrizzleTx,
    scope: Scope,
    ids: readonly string[],
  ): Promise<readonly string[]>;
  /** This table's contribution to the scope's highest revision. */
  maxRev?(tx: DrizzleTx, scope: Scope): Promise<number>;
  upsert?(tx: DrizzleTx, scope: Scope, rows: readonly WireRow[]): Promise<void>;
  tombstone?(
    tx: DrizzleTx,
    scope: Scope,
    ids: readonly string[],
  ): Promise<void>;
}

/**
 * One synced table. Machinery columns are the store's contract: a text
 * `id` primary key (client-minted), a bigint `rev`, a nullable
 * `deletedAt` tombstone marker, and — unless the scoped queries are
 * overridden — a `scope` column the sync scope filters on. Every other
 * column passes through untouched; when column names match wire names
 * the default mapping is identity and the table syncs with no mapper
 * code.
 */
export interface DrizzleTableConfig<Scope> {
  readonly table: PgTable;
  readonly id: PgColumn;
  readonly rev: PgColumn;
  readonly deletedAt: PgColumn;
  /** Omit only when `overrides` supplies every scoped query. */
  readonly scope?: PgColumn;
  /** Row (drizzle property keys) -> wire row; defaults to identity minus machinery columns. */
  readonly toWire?: (row: Record<string, unknown>) => WireRow;
  /** Wire row -> column values (drizzle property keys); defaults to identity. */
  readonly fromWire?: (row: WireRow) => Record<string, unknown>;
  /** Column names written on insert but never overwritten on conflict. */
  readonly insertOnly?: readonly string[];
  /**
   * Column values (drizzle property keys) applied when a row is
   * tombstoned. The wire never ships a tombstone's columns, so scrubbed
   * content is immediately gone for every device — erasure (GDPR) comes
   * from scrubbing, not from GC.
   */
  readonly scrub?: Record<string, unknown>;
  readonly overrides?: TableOverrides<Scope>;
}

/** The SQL column names of a concrete Drizzle table. */
type ColumnNamesOf<T extends PgTable> =
  T['_']['columns'][keyof T['_']['columns']]['_']['name'];

/**
 * A schema-aware {@link DrizzleTableConfig} builder: `scrub` keys and
 * value types are checked against the table's insert model and
 * `insertOnly` entries against its real column names, so a typo or a
 * wrong-typed scrub value fails at compile time instead of syncing
 * garbage. Purely a type-level helper — it returns the config as-is.
 */
export function drizzleSyncTable<Scope, T extends PgTable>(config: {
  readonly table: T;
  readonly id: PgColumn;
  readonly rev: PgColumn;
  readonly deletedAt: PgColumn;
  readonly scope?: PgColumn;
  readonly toWire?: (row: Record<string, unknown>) => WireRow;
  readonly fromWire?: (row: WireRow) => Record<string, unknown>;
  readonly insertOnly?: readonly ColumnNamesOf<T>[];
  readonly scrub?: Partial<InferInsertModel<T>>;
  readonly overrides?: TableOverrides<Scope>;
}): DrizzleTableConfig<Scope> {
  return config;
}

export interface DrizzleStoreOptions<Scope> {
  readonly db: DrizzleDb;
  readonly tables: { readonly [table: string]: DrizzleTableConfig<Scope> };
  /** Postgres sequence stamping revisions; defaults to `remelon_rev`. */
  readonly revSequence?: string;
  /** Bookkeeping table holding the gc floor; defaults to `remelon_sync_meta`. */
  readonly metaTable?: string;
  /**
   * Maps a scope to the advisory-lock key serializing its pushes.
   * Defaults to a 64-bit hash of `String(scope)`; collisions only
   * over-serialize, never corrupt.
   */
  readonly lockKey?: (scope: Scope) => bigint;
}

interface UserColumn {
  readonly key: string;
  readonly name: string;
}

interface Prepared<Scope> {
  readonly cfg: DrizzleTableConfig<Scope>;
  readonly idKey: string;
  readonly revKey: string;
  readonly deletedKey: string;
  readonly scopeKey: string | null;
  readonly userColumns: readonly UserColumn[];
  readonly updateColumns: readonly UserColumn[];
  readonly toWire: (row: Record<string, unknown>) => WireRow;
  readonly fromWire: (row: WireRow) => Record<string, unknown>;
}

const fnv64 = (input: string): bigint => {
  let hash = 0xcbf29ce484222325n;
  for (const char of input) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- `for...of` over a string yields one non-empty code point at a time, so index 0 exists.
    hash ^= BigInt(char.codePointAt(0)!);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return BigInt.asIntN(64, hash);
};

// The driver hands back either the rows themselves or a { rows } wrapper,
// depending on the dialect; Array.isArray widens the first branch to any[].
const rowsOf = (result: unknown): Record<string, unknown>[] =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  Array.isArray(result)
    ? result
    : // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the dialect's own result type, per the comment above.
      (result as { rows: Record<string, unknown>[] }).rows;

const excluded = (column: string): SQL => sql.raw(`excluded."${column}"`);

// Drizzle infers an operator's operand type from a statically known column.
// These columns arrive as runtime config (`PgColumn`), so that inference has
// nothing to work with and collapses to `never`. Identity at runtime.
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the reason is the paragraph above; it applies to every operand this store builds.
const operand = (value: unknown) => value as never;

const prepare = <Scope>(
  name: string,
  cfg: DrizzleTableConfig<Scope>,
): Prepared<Scope> => {
  const columns = getTableColumns(cfg.table);
  function keyOf(column: PgColumn): string;
  function keyOf(column: PgColumn | undefined): string | null;
  function keyOf(column: PgColumn | undefined): string | null {
    if (!column) return null;
    for (const [key, candidate] of Object.entries(columns)) {
      if (candidate === column) return key;
    }
    throw new Error(
      `store-drizzle: table '${name}' config references a column not on its table`,
    );
  }
  const idKey = keyOf(cfg.id);
  const revKey = keyOf(cfg.rev);
  const deletedKey = keyOf(cfg.deletedAt);
  const scopeKey = keyOf(cfg.scope);
  if (!scopeKey) {
    const o = cfg.overrides ?? {};
    if (!(o.changedSince && o.currentRevs && o.foreignIds && o.maxRev)) {
      throw new Error(
        `store-drizzle: table '${name}' has no scope column; ` +
          'overrides must supply changedSince, currentRevs, foreignIds and maxRev',
      );
    }
  }
  const machinery = new Set([
    idKey,
    revKey,
    deletedKey,
    ...(scopeKey ? [scopeKey] : []),
  ]);
  const userColumns: UserColumn[] = Object.entries(columns)
    .filter(([key]) => !machinery.has(key))
    .map(([key, column]) => ({ key, name: column.name }));
  const insertOnly = new Set(cfg.insertOnly ?? []);
  const byName = new Map(userColumns.map((column) => [column.name, column]));
  return {
    cfg,
    idKey,
    revKey,
    deletedKey,
    scopeKey,
    userColumns,
    updateColumns: userColumns.filter((column) => !insertOnly.has(column.name)),
    toWire:
      cfg.toWire ??
      ((row) => {
        const wire: Record<string, unknown> = { id: row[idKey] };
        for (const column of userColumns) wire[column.name] = row[column.key];
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- WireRow adds only `id: string` to a raw row, and the id column is the table's text primary key.
        return wire as WireRow;
      }),
    fromWire:
      cfg.fromWire ??
      ((row) => {
        const values: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) {
          if (key === 'id') continue;
          const column = byName.get(key);
          if (column) values[column.key] = value;
        }
        return values;
      }),
  };
};

/**
 * A SyncStore over drizzle/Postgres. Tombstone retention is not yet
 * bounded by `gc(floor)`; until the first call the floor is 0 and every
 * cursor is served.
 * @category Store seam
 */
export interface DrizzleStore<Scope> extends SyncStore<Scope> {
  /**
   * Prune tombstones with rev <= floor and raise the persisted floor
   * (never lowered). Cursors below the floor then degrade to resync.
   * The caller picks the floor — retention policy stays the app's.
   */
  gc(floor: number): Promise<void>;
}

const IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/;

// Unique (23505) and foreign-key (23503) violations are content refusals the
// wire contract owes the client as per-record rejections, not thrown 500s.
// Drivers differ in where they put the SQLSTATE, so walk the cause chain.
const CONSTRAINT_CODES = new Set(['23505', '23503']);
const isConstraintViolation = (error: unknown): boolean => {
  for (let e = error, depth = 0; e && depth < 5; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && CONSTRAINT_CODES.has(code)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
};

/** @category Store seam */
export function createDrizzleStore<Scope>(
  options: DrizzleStoreOptions<Scope>,
): DrizzleStore<Scope> {
  const sequence = options.revSequence ?? 'remelon_rev';
  if (!IDENTIFIER.test(sequence)) {
    throw new Error(`store-drizzle: invalid sequence name '${sequence}'`);
  }
  const meta = options.metaTable ?? 'remelon_sync_meta';
  if (!IDENTIFIER.test(meta)) {
    throw new Error(`store-drizzle: invalid meta table name '${meta}'`);
  }
  const lockKey = options.lockKey ?? ((scope: Scope) => fnv64(String(scope)));
  const tables = new Map<string, Prepared<Scope>>(
    Object.entries(options.tables).map(([name, cfg]) => [
      name,
      prepare(name, cfg),
    ]),
  );
  const tableOf = (name: string): Prepared<Scope> => {
    const prepared = tables.get(name);
    if (!prepared) throw new Error(`store-drizzle: unknown table '${name}'`);
    return prepared;
  };

  const nextRev = async (tx: DrizzleTx): Promise<number> => {
    const rows = rowsOf(
      await tx.execute(sql.raw(`select nextval('${sequence}') as rev`)),
    );
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- `select nextval(...)` returns exactly one row.
    return Number(rows[0]!['rev']);
  };

  const txFor = (tx: DrizzleTx): SyncStoreTx<Scope> => ({
    changedSince: async (name, txScope, since) => {
      const p = tableOf(name);
      if (p.cfg.overrides?.changedSince)
        return p.cfg.overrides.changedSince(tx, txScope, since);
      const rows = (await tx
        .select()
        .from(p.cfg.table)
        .where(
          and(
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- `prepare` rejects a scope-less table unless it overrides this very method, and the override path returned above.
            eq(p.cfg.scope!, operand(txScope)),
            gt(p.cfg.rev, operand(since)),
          ),
        )) as Record<string, unknown>[];
      return rows.map((row) => ({
        id: String(row[p.idKey]),
        rev: Number(row[p.revKey]),
        row: row[p.deletedKey] == null ? p.toWire(row) : null,
      }));
    },
    maxRev: async (txScope) => {
      let max = 0;
      for (const p of tables.values()) {
        const contribution = p.cfg.overrides?.maxRev
          ? await p.cfg.overrides.maxRev(tx, txScope)
          : Number(
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- a `coalesce(max(...), 0)` aggregate returns exactly one row.
              rowsOf(
                await tx.execute(
                  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- `prepare` rejects a scope-less table unless it overrides this very method, and the override path returned above.
                  sql`select coalesce(max(${p.cfg.rev}), 0) as rev from ${p.cfg.table} where ${p.cfg.scope!} = ${txScope}`,
                ),
              )[0]!['rev'],
            );
        if (contribution > max) max = contribution;
      }
      return max;
    },
    currentRevs: async (name, txScope, ids) => {
      const p = tableOf(name);
      if (p.cfg.overrides?.currentRevs)
        return p.cfg.overrides.currentRevs(tx, txScope, ids);
      if (ids.length === 0) return new Map();
      // tombstones included: a client editing a server-deleted row must conflict
      const rows = await tx
        .select({ id: p.cfg.id, rev: p.cfg.rev })
        .from(p.cfg.table)
        .where(
          and(
            inArray(p.cfg.id, operand([...ids])),
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- `prepare` rejects a scope-less table unless it overrides this very method, and the override path returned above.
            eq(p.cfg.scope!, operand(txScope)),
          ),
        );
      return new Map(rows.map((row) => [String(row.id), Number(row.rev)]));
    },
    foreignIds: async (name, txScope, ids) => {
      const p = tableOf(name);
      if (p.cfg.overrides?.foreignIds)
        return p.cfg.overrides.foreignIds(tx, txScope, ids);
      if (ids.length === 0) return [];
      const rows = await tx
        .select({ id: p.cfg.id })
        .from(p.cfg.table)
        .where(
          and(
            inArray(p.cfg.id, operand([...ids])),
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- `prepare` rejects a scope-less table unless it overrides this very method, and the override path returned above.
            ne(p.cfg.scope!, operand(txScope)),
          ),
        );
      return rows.map((row) => String(row.id));
    },
    tombstonedIds: async (name, txScope, ids) => {
      const p = tableOf(name);
      if (p.cfg.overrides?.tombstonedIds)
        return p.cfg.overrides.tombstonedIds(tx, txScope, ids);
      if (ids.length === 0) return [];
      const rows = await tx
        .select({ id: p.cfg.id })
        .from(p.cfg.table)
        .where(
          and(
            inArray(p.cfg.id, operand([...ids])),
            isNotNull(p.cfg.deletedAt),
            p.cfg.scope ? eq(p.cfg.scope, operand(txScope)) : undefined,
          ),
        );
      return rows.map((row) => String(row.id));
    },
    upsert: async (name, txScope, wireRows) => {
      const p = tableOf(name);
      if (p.cfg.overrides?.upsert)
        return p.cfg.overrides.upsert(tx, txScope, wireRows);
      if (wireRows.length === 0) return;
      const rev = await nextRev(tx);
      const values = wireRows.map((row) => ({
        ...p.fromWire(row),
        [p.idKey]: row.id,
        [p.revKey]: rev,
        ...(p.scopeKey ? { [p.scopeKey]: txScope } : {}),
      }));
      const set: Record<string, SQL> = { [p.revKey]: excluded(p.cfg.rev.name) };
      for (const column of p.updateColumns)
        set[column.key] = excluded(column.name);
      const apply = (subset: typeof values, on: DrizzleTx) =>
        on
          .insert(p.cfg.table)
          .values(subset)
          .onConflictDoUpdate({
            target: p.cfg.id,
            set: set,
            // never resurrect a tombstone, never touch its rev — and never
            // touch another scope's row: an id collision across scopes is
            // a no-op here, the way a tombstone collision is. (`and` of two
            // defined operands never yields undefined; the ?? satisfies
            // exactOptionalPropertyTypes without an assertion.)
            setWhere: p.cfg.scope
              ? (and(
                  isNull(p.cfg.deletedAt),
                  eq(p.cfg.scope, operand(txScope)),
                ) ?? isNull(p.cfg.deletedAt))
              : isNull(p.cfg.deletedAt),
          });
      // Fast path: the whole batch in one statement, inside a savepoint so
      // a constraint violation cannot poison the outer push transaction.
      try {
        await tx.transaction((sp) => apply(values, sp));
        return;
      } catch (error) {
        if (!isConstraintViolation(error)) throw error;
      }
      // Slow path, only after a violation: row by row, each in its own
      // savepoint, collecting the ids the database refuses. The wire
      // contract turns these into per-record rejections: a refused row
      // leaves no trace and the rest of the batch still applies.
      const refused: string[] = [];
      for (const value of values) {
        try {
          await tx.transaction((sp) => apply([value], sp));
        } catch (error) {
          if (!isConstraintViolation(error)) throw error;
          refused.push(String((value as Record<string, unknown>)[p.idKey]));
        }
      }
      return refused;
    },
    tombstone: async (name, txScope, ids) => {
      const p = tableOf(name);
      if (p.cfg.overrides?.tombstone)
        return p.cfg.overrides.tombstone(tx, txScope, ids);
      if (ids.length === 0) return;
      const rev = await nextRev(tx);
      await tx
        .update(p.cfg.table)
        .set({
          [p.deletedKey]: sql`now()`,
          [p.revKey]: rev,
          ...(p.cfg.scrub ?? {}),
        })
        .where(
          and(
            inArray(p.cfg.id, operand([...ids])),
            isNull(p.cfg.deletedAt),
            p.cfg.scope ? eq(p.cfg.scope, operand(txScope)) : undefined,
          ),
        );
    },
    gcFloor: async () => floorOf(tx),
  });

  const floorOf = async (tx: DrizzleTx): Promise<number> => {
    const rows = rowsOf(
      await tx.execute(
        sql.raw(`select value from ${meta} where key = 'gc_floor'`),
      ),
    );
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by the length check on the same line.
    return rows.length === 0 ? 0 : Number(rows[0]!['value']);
  };

  return {
    transaction: (scope, mode, work) =>
      options.db.transaction(
        async (tx) => {
          // Lock before any read: under 'read committed' each statement
          // sees data committed before it, so once the lock is granted
          // this push reads the previous push's commit. 'repeatable
          // read' would pin the snapshot at the lock statement itself —
          // taken while still waiting — and serialize into stale reads.
          if (mode === 'push') {
            await tx.execute(
              sql.raw(
                `select pg_advisory_xact_lock(${lockKey(scope).toString()})`,
              ),
            );
          }
          return work(txFor(tx));
        },
        mode === 'pull' ? { isolationLevel: 'repeatable read' } : undefined,
      ),
    gc: async (floor) => {
      const target = Math.trunc(floor);
      if (!Number.isFinite(target) || target < 0) {
        throw new Error(`store-drizzle: invalid gc floor '${floor}'`);
      }
      await options.db.transaction(async (tx) => {
        await tx.execute(
          sql.raw(
            `insert into ${meta} (key, value) values ('gc_floor', ${target}) ` +
              `on conflict (key) do update set value = greatest(${meta}.value, excluded.value)`,
          ),
        );
        // the persisted floor may already be higher; prune to it, not to
        // the argument, so gc never resurrects served history
        const effective = await floorOf(tx);
        // Tombstones can reference each other across tables (a tombstoned
        // child holds its FK, tombstoning is an UPDATE), and config order
        // knows nothing about dependencies. Each table prunes inside its
        // own savepoint so an FK refusal skips that table for this pass
        // instead of rolling back the transaction, and passes repeat until
        // none makes progress. A tombstone still referenced by a live row
        // legitimately survives; the floor is already persisted and served
        // history never shrinks either way.
        let progressed = true;
        while (progressed) {
          progressed = false;
          for (const p of tables.values()) {
            try {
              const pruned = await tx.transaction((sp) =>
                sp
                  .delete(p.cfg.table)
                  .where(
                    and(
                      isNotNull(p.cfg.deletedAt),
                      lte(p.cfg.rev, operand(effective)),
                    ),
                  )
                  .returning({ id: p.cfg.id }),
              );
              if (pruned.length > 0) progressed = true;
            } catch {
              // an FK still points here; a later pass or a later gc gets it
            }
          }
        }
      });
    },
  };
}
