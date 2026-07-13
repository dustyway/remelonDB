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
import type { Database } from '../database/Database'
import { stepsForMigration } from '../schema/migrations'
import { applyRemoteChanges, type ConflictResolver } from './applyRemote'
import { fetchLocalChanges } from './fetchLocal'
import { markLocalChangesAsSynced } from './markAsSynced'
import type {
  Cursor,
  MigrationSyncChanges,
  SyncPullArgs,
  SyncPullResult,
  SyncPushArgs,
  SyncPushResult,
} from './types'

export const CURSOR_KEY = '__sync_cursor'
export const LAST_SCHEMA_VERSION_KEY = '__sync_last_schema_version'

export interface SynchronizeOptions {
  readonly database: Database
  readonly pullChanges: (args: SyncPullArgs) => Promise<SyncPullResult>
  readonly pushChanges?: (args: SyncPushArgs) => Promise<SyncPushResult>
  readonly conflictResolver?: ConflictResolver
  readonly sendCreatedAsUpdated?: boolean
  /** Opt into migration pulls; the version before your first synced migration. */
  readonly migrationsEnabledAtVersion?: number
  /** Max pull→push rounds when the server reports push conflicts (default 5). */
  readonly conflictRetries?: number
  readonly log?: (message: string) => void
}

const getCursor = async (database: Database): Promise<Cursor | null> =>
  database.localStorage.get(CURSOR_KEY)

async function migrationInfo(
  database: Database,
  enabledAtVersion: number | undefined,
  isFirstSync: boolean,
): Promise<{ migration: MigrationSyncChanges | null; shouldSaveVersion: boolean }> {
  const currentVersion = database.schema.version
  if (isFirstSync) {
    return { migration: null, shouldSaveVersion: true }
  }
  if (enabledAtVersion === undefined) {
    return { migration: null, shouldSaveVersion: false }
  }
  const stored = await database.localStorage.get(LAST_SCHEMA_VERSION_KEY)
  const migrateFrom = stored !== null ? Number(stored) : enabledAtVersion
  if (migrateFrom >= currentVersion) {
    return { migration: null, shouldSaveVersion: false }
  }
  const { migrations } = database
  if (!migrations) {
    throw new Error('synchronize: migrationsEnabledAtVersion set but the database has no migrations')
  }
  const steps = stepsForMigration(migrations, {
    from: migrateFrom,
    to: currentVersion,
  })
  if (steps === null) {
    throw new Error(
      `synchronize: no migration path from synced schema version ${migrateFrom} to ${currentVersion}`,
    )
  }
  const tables: string[] = []
  const columnsByTable = new Map<string, Set<string>>()
  for (const step of steps) {
    if (step.type === 'create_table') {
      tables.push(step.schema.name)
    } else if (step.type === 'add_columns' && !tables.includes(step.table)) {
      const set = columnsByTable.get(step.table) ?? new Set()
      step.columns.forEach((column) => set.add(column.name))
      columnsByTable.set(step.table, set)
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
  }
}

const inFlight = new WeakMap<Database, Promise<void>>()

/**
 * Concurrent calls for the same database coalesce: a call arriving while
 * a sync is running joins it (the runner's options apply). The in-write
 * cursor re-check below stays as the guard against out-of-band writers
 * (another tab or process sharing the database).
 */
export function synchronize(options: SynchronizeOptions): Promise<void> {
  const running = inFlight.get(options.database)
  if (running) {
    return running
  }
  const run = runSynchronize(options).finally(() =>
    inFlight.delete(options.database),
  )
  inFlight.set(options.database, run)
  return run
}

async function runSynchronize(options: SynchronizeOptions): Promise<void> {
  const { database, log = () => {} } = options
  const retries = options.conflictRetries ?? 5

  for (let attempt = 1; attempt <= retries; attempt++) {
    // ---- pull phase ----
    const pullCursor = await getCursor(database)
    const { migration, shouldSaveVersion } = await migrationInfo(
      database,
      options.migrationsEnabledAtVersion,
      pullCursor === null,
    )
    let pullResult = await options.pullChanges({
      cursor: pullCursor,
      schemaVersion: database.schema.version,
      migration,
    })
    let replacement = false
    if ('resyncRequired' in pullResult) {
      log('sync: server requires a full resync — re-pulling from scratch')
      pullResult = await options.pullChanges({
        cursor: null,
        schemaVersion: database.schema.version,
        migration: null,
      })
      if ('resyncRequired' in pullResult) {
        throw new Error('synchronize: server demanded resync for a null cursor')
      }
      replacement = true
    }
    const pulled = pullResult

    await database.write(async () => {
      if ((await getCursor(database)) !== pullCursor) {
        throw new Error(
          'synchronize: another synchronize() committed during the pull — aborting',
        )
      }
      await applyRemoteChanges(database, pulled.changes, {
        ...(options.conflictResolver
          ? { conflictResolver: options.conflictResolver }
          : {}),
        ...(options.sendCreatedAsUpdated ? { sendCreatedAsUpdated: true } : {}),
        replacement,
        log,
      })
      await database.localStorage.set(CURSOR_KEY, pulled.cursor)
      if (shouldSaveVersion) {
        await database.localStorage.set(
          LAST_SCHEMA_VERSION_KEY,
          String(database.schema.version),
        )
      }
    })

    // ---- push phase ----
    if (!options.pushChanges) {
      return
    }
    const localChanges = await fetchLocalChanges(database)
    if (localChanges.isEmpty) {
      return
    }
    const pushResult = await options.pushChanges({
      changes: localChanges.changes,
      cursor: pulled.cursor,
    })
    if ('conflict' in pushResult) {
      log(`sync: push conflict (attempt ${attempt}/${retries}) — re-pulling`)
      continue
    }
    if (pushResult.cursor !== null && pushResult.changes === null) {
      throw new Error(
        'synchronize: push returned a cursor without interleaved changes — a backend must return both or neither (see docs/sync-design.md)',
      )
    }

    await database.write(async () => {
      await markLocalChangesAsSynced(database, localChanges, pushResult.rejected)
      if (pushResult.cursor !== null && pushResult.changes !== null) {
        if ((await getCursor(database)) !== pulled.cursor) {
          log('sync: cursor moved during push — skipping cursor adoption')
          return
        }
        await applyRemoteChanges(database, pushResult.changes, { log })
        await database.localStorage.set(CURSOR_KEY, pushResult.cursor)
      }
    })
    return
  }

  throw new Error(
    `synchronize: push still conflicting after ${retries} attempts — giving up`,
  )
}
