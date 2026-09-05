/**
 * The sync orchestrator (docs/sync-design.md):
 *
 *   pull → apply (guarded write) → fetch local → push → mark synced
 *
 * Guards: the cursor is re-read inside each write block and compared to
 * the one the phase started from — a mismatch means another synchronize()
 * committed in between, and this one aborts. Records modified while a
 * push is in flight fail the equality gate and stay dirty. Push conflicts
 * loop back to pull, bounded by conflictRetries.
 */
import type { Database } from '../database/Database';
import { runDirect } from '../database/directWork';
import { throwIfAborted } from '../utils/abort';
import { stepsForMigration } from '../schema/migrations';
import { applyRemoteChanges, type ConflictResolver } from './applyRemote';
import { fetchLocalChanges } from './fetchLocal';
import { markLocalChangesAsSynced } from './markAsSynced';
import type {
  Cursor,
  MigrationSyncChanges,
  SyncChanges,
  SyncPullArgs,
  SyncPullResult,
  SyncPushArgs,
  SyncPushResult,
} from './types';

export const CURSOR_KEY = '__sync_cursor';
export const LAST_SCHEMA_VERSION_KEY = '__sync_last_schema_version';

/**
 * What a synchronize() run did. Callers branch on this instead of
 * parsing log lines.
 * @category Sync
 */
export interface SynchronizeResult {
  /**
   * 'unavailable' when another context held the sync lease and nothing
   * ran; 'lost' when the lease expired mid-run and another context took
   * it — the push (if any) landed server-side, local changes stay dirty,
   * and the next run reconciles idempotently.
   */
  readonly lease: 'acquired' | 'unavailable' | 'lost';
  /** The server demanded a full resync and a replacement pull happened. */
  readonly resynced: boolean;
  /** Remote rows applied locally: pull phases plus interleaved push changes. */
  readonly pulled: number;
  /** Local rows the server accepted (sent minus per-record rejections). */
  readonly pushed: number;
  /** Local rows the server rejected; they stay dirty. */
  readonly rejected: number;
  /**
   * The rejected rows' ids, per table — identity for the count above,
   * so an application can surface WHICH record needs attention instead
   * of only how many. Empty object when nothing was rejected.
   */
  readonly rejectedRecords: Readonly<Record<string, readonly string[]>>;
  /** Extra pull→push rounds forced by push conflicts. */
  readonly retryCount: number;
}

const countRows = (changes: SyncChanges | null | undefined): number => {
  if (!changes) return 0;
  let total = 0;
  for (const table of Object.values(changes)) {
    total += table.created.length + table.updated.length + table.deleted.length;
  }
  return total;
};

export interface SynchronizeOptions {
  readonly database: Database;
  readonly pullChanges: (
    args: SyncPullArgs,
    signal?: AbortSignal,
  ) => Promise<SyncPullResult>;
  readonly pushChanges?: (
    args: SyncPushArgs,
    signal?: AbortSignal,
  ) => Promise<SyncPushResult>;
  /** Validate each untrusted pull response before core inspects or applies it. */
  readonly validatePullResult?: (result: unknown) => SyncPullResult;
  /** Validate each untrusted push response before core inspects or applies it. */
  readonly validatePushResult?: (result: unknown) => SyncPushResult;
  readonly conflictResolver?: ConflictResolver;
  readonly sendCreatedAsUpdated?: boolean;
  /** Opt into migration pulls; the version before your first synced migration. */
  readonly migrationsEnabledAtVersion?: number;
  /** Max pull→push rounds when the server reports push conflicts (default 5). */
  readonly conflictRetries?: number;
  /**
   * Cancels the run between protocol phases and is handed to the
   * transport so in-flight requests can abort. A write in progress is
   * never interrupted; the engine stops before the next phase instead.
   */
  readonly signal?: AbortSignal;
  readonly log?: (message: string) => void;
}

const getCursor = async (database: Database): Promise<Cursor | null> =>
  database.localStorage.get(CURSOR_KEY);

async function migrationInfo(
  database: Database,
  enabledAtVersion: number | undefined,
  isFirstSync: boolean,
): Promise<{
  migration: MigrationSyncChanges | null;
  shouldSaveVersion: boolean;
}> {
  const currentVersion = database.schema.version;
  if (isFirstSync) {
    return { migration: null, shouldSaveVersion: true };
  }
  if (enabledAtVersion === undefined) {
    return { migration: null, shouldSaveVersion: false };
  }
  const stored = await database.localStorage.get(LAST_SCHEMA_VERSION_KEY);
  const migrateFrom = stored !== null ? Number(stored) : enabledAtVersion;
  if (migrateFrom >= currentVersion) {
    return { migration: null, shouldSaveVersion: false };
  }
  const { migrations } = database;
  if (!migrations) {
    throw new Error(
      'synchronize: migrationsEnabledAtVersion set but the database has no migrations',
    );
  }
  const steps = stepsForMigration(migrations, {
    from: migrateFrom,
    to: currentVersion,
  });
  if (steps === null) {
    throw new Error(
      `synchronize: no migration path from synced schema version ${migrateFrom} to ${currentVersion}`,
    );
  }
  const tables: string[] = [];
  const columnsByTable = new Map<string, Set<string>>();
  for (const step of steps) {
    if (step.type === 'create_table') {
      tables.push(step.schema.name);
    } else if (step.type === 'add_columns' && !tables.includes(step.table)) {
      const set = columnsByTable.get(step.table) ?? new Set();
      step.columns.forEach((column) => set.add(column.name));
      columnsByTable.set(step.table, set);
    }
  }
  return {
    migration: {
      from: migrateFrom,
      tables,
      columns: [...columnsByTable].map(([table, columns]) => ({
        table,
        columns: [...columns],
      })),
    },
    shouldSaveVersion: true,
  };
}

const inFlight = new WeakMap<Database, Promise<SynchronizeResult>>();

/**
 * Run one full sync: pull remote changes, apply them (per-column
 * conflict resolution), push local changes, mark them synced. Wire up
 * `pullChanges`/`pushChanges` to your transport; shapes are the wire
 * protocol's (docs/sync-wire.md).
 *
 * Concurrent calls for the same database coalesce: a call arriving while
 * a sync is running joins it (the runner's options apply). The in-write
 * cursor re-check stays as the guard against out-of-band writers
 * (another tab or process sharing the database).
 *
 * @example
 * ```ts
 * await synchronize({
 *   database: db,
 *   pullChanges: async (args) => postJson('/sync/pull', args),
 *   pushChanges: async (args) => postJson('/sync/push', args),
 * })
 * ```
 * @category Sync
 */
export function synchronize(
  options: SynchronizeOptions,
): Promise<SynchronizeResult> {
  const running = inFlight.get(options.database);
  if (running) {
    return running;
  }
  const run = runSynchronize(options).finally(() =>
    inFlight.delete(options.database),
  );
  inFlight.set(options.database, run);
  return run;
}

async function runSynchronize(
  options: SynchronizeOptions,
): Promise<SynchronizeResult> {
  const { database, log = () => {} } = options;
  const retries = options.conflictRetries ?? 5;
  throwIfAborted(options.signal);

  // Multi-tab: only the sync-lease holder runs; everyone else's tick is
  // a cheap no-op. Drivers without shared storage have no hook.
  // Read off the driver to test for presence; it is invoked below with
  // .call(database.driver, …), so `this` is never lost.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const requestSyncTurn = database.driver.requestSyncTurn;
  const turn = requestSyncTurn
    ? await runDirect(database, () => requestSyncTurn.call(database.driver))
    : undefined;
  if (turn === false) {
    log('sync turn denied — another context holds the sync lease');
    return {
      lease: 'unavailable',
      resynced: false,
      pulled: 0,
      pushed: 0,
      rejected: 0,
      rejectedRecords: {},
      retryCount: 0,
    };
  }

  let resynced = false;
  let pulledTotal = 0;

  for (let attempt = 1; attempt <= retries; attempt++) {
    // ---- pull phase ----
    throwIfAborted(options.signal);
    const pullCursor = await getCursor(database);
    const { migration, shouldSaveVersion } = await migrationInfo(
      database,
      options.migrationsEnabledAtVersion,
      pullCursor === null,
    );
    const pull = async (args: SyncPullArgs): Promise<SyncPullResult> => {
      const result: unknown = await options.pullChanges(args, options.signal);
      return options.validatePullResult
        ? options.validatePullResult(result)
        : // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the app's transport answers `unknown`; `validatePullResult` is the opt-in check for apps that want one, and the wire spec is the contract otherwise.
          (result as SyncPullResult);
    };
    let pullResult = await pull({
      cursor: pullCursor,
      schemaVersion: database.schema.version,
      migration,
    });
    let replacement = false;
    if ('resyncRequired' in pullResult) {
      log('sync: server requires a full resync — re-pulling from scratch');
      pullResult = await pull({
        cursor: null,
        schemaVersion: database.schema.version,
        migration: null,
      });
      if ('resyncRequired' in pullResult) {
        throw new Error(
          'synchronize: server demanded resync for a null cursor',
        );
      }
      replacement = true;
      resynced = true;
    }
    const pulled = pullResult;
    pulledTotal += countRows(pulled.changes);

    // abort before the apply write, never inside it
    throwIfAborted(options.signal);
    await database.write(async () => {
      if ((await getCursor(database)) !== pullCursor) {
        throw new Error(
          'synchronize: another synchronize() committed during the pull — aborting',
        );
      }
      await applyRemoteChanges(database, pulled.changes, {
        ...(options.conflictResolver
          ? { conflictResolver: options.conflictResolver }
          : {}),
        ...(options.sendCreatedAsUpdated ? { sendCreatedAsUpdated: true } : {}),
        replacement,
        log,
      });
      await database.localStorage.set(CURSOR_KEY, pulled.cursor);
      if (shouldSaveVersion) {
        await database.localStorage.set(
          LAST_SCHEMA_VERSION_KEY,
          String(database.schema.version),
        );
      }
    });

    const doneWithoutPush = (): SynchronizeResult => ({
      lease: 'acquired',
      resynced,
      pulled: pulledTotal,
      pushed: 0,
      rejected: 0,
      rejectedRecords: {},
      retryCount: attempt - 1,
    });

    // ---- push phase ----
    if (!options.pushChanges) {
      return doneWithoutPush();
    }
    const localChanges = await fetchLocalChanges(database);
    if (localChanges.isEmpty) {
      return doneWithoutPush();
    }
    throwIfAborted(options.signal);
    const unvalidatedPushResult: unknown = await options.pushChanges(
      {
        changes: localChanges.changes,
        cursor: pulled.cursor,
      },
      options.signal,
    );
    const pushResult = options.validatePushResult
      ? options.validatePushResult(unvalidatedPushResult)
      : // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- as with the pull above: `validatePushResult` is the opt-in check, the wire spec is the contract otherwise.
        (unvalidatedPushResult as SyncPushResult);
    if ('conflict' in pushResult) {
      log(`sync: push conflict (attempt ${attempt}/${retries}) — re-pulling`);
      continue;
    }
    if (pushResult.cursor !== null && pushResult.changes === null) {
      throw new Error(
        'synchronize: push returned a cursor without interleaved changes — a backend must return both or neither (see docs/sync-design.md)',
      );
    }

    // The turn was taken once at the start, and a slow push can outlive
    // the driver's lease. Re-confirm before the one write that destroys
    // local state: still ours (or expired, unclaimed) extends the lease;
    // taken by another context means that context has been syncing over
    // this database, and marking now would trust a stale snapshot.
    if (requestSyncTurn) {
      const stillOurs = await runDirect(database, () =>
        requestSyncTurn.call(database.driver),
      );
      if (!stillOurs) {
        log('sync turn lost during push — local changes stay dirty');
        return {
          lease: 'lost',
          resynced,
          pulled: pulledTotal,
          pushed: 0,
          rejected: 0,
          rejectedRecords: {},
          retryCount: attempt - 1,
        };
      }
    }

    await database.write(async () => {
      await markLocalChangesAsSynced(
        database,
        localChanges,
        pushResult.rejected,
      );
      if (pushResult.cursor !== null && pushResult.changes !== null) {
        if ((await getCursor(database)) !== pulled.cursor) {
          log('sync: cursor moved during push — skipping cursor adoption');
          return;
        }
        await applyRemoteChanges(database, pushResult.changes, {
          log,
          // the interleave can carry rows that are locally dirty but were
          // not in this push; they deserve the same resolver and created
          // handling the pull phase gives them
          ...(options.conflictResolver && {
            conflictResolver: options.conflictResolver,
          }),
          ...(options.sendCreatedAsUpdated && { sendCreatedAsUpdated: true }),
        });
        pulledTotal += countRows(pushResult.changes);
        await database.localStorage.set(CURSOR_KEY, pushResult.cursor);
      }
    });
    // one source for count and identity: tables with no rejections are
    // omitted, so `rejectedRecords` is {} exactly when `rejected` is 0
    const rejectedRecords: Record<string, readonly string[]> = {};
    for (const [table, ids] of Object.entries(pushResult.rejected ?? {})) {
      if (ids.length > 0) rejectedRecords[table] = [...ids];
    }
    const rejectedCount = Object.values(rejectedRecords).reduce(
      (total, ids) => total + ids.length,
      0,
    );
    return {
      lease: 'acquired',
      resynced,
      pulled: pulledTotal,
      pushed: countRows(localChanges.changes) - rejectedCount,
      rejected: rejectedCount,
      rejectedRecords,
      retryCount: attempt - 1,
    };
  }

  throw new Error(
    `synchronize: push still conflicting after ${retries} attempts — giving up`,
  );
}
