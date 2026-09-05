/**
 * Applies a pulled changeset (docs/sync-design.md, "Client engine notes").
 * Decision tree per remote change, all committed in one atomic batch:
 *
 * created  → exists live: treat as update (anomaly, logged)
 *          → exists as tombstone: destroy tombstone, create fresh
 *          → missing: create as synced
 * updated  → exists live: per-column conflict resolution
 *          → tombstone: ignore (local deletion wins, pushed later)
 *          → missing: create (anomaly unless sendCreatedAsUpdated)
 * deleted  → always destroys, even over local changes
 *
 * With `replacement: true` (resync), local synced records absent from each
 * table's snapshot are destroyed as well; dirty records are kept.
 *
 * Must be called inside a database.write block.
 */
import type { Database } from '../database/Database';
import type { BatchOperation } from '../database/encodeBatch';
import type { TableSchema } from '../schema/index';
import {
  sanitizedRaw,
  type DirtyRaw,
  type RawRecord,
} from '../rawRecord/index';
import {
  areRecordsEqual,
  changedColumns,
  decodeWireRaw,
  queryRows,
  queryRowsByIds,
} from './helpers';
import type { SyncChanges } from './types';

export type ConflictResolver = (
  table: string,
  local: RawRecord,
  remote: DirtyRaw,
  resolved: RawRecord,
) => RawRecord;

export interface ApplyRemoteOptions {
  readonly sendCreatedAsUpdated?: boolean;
  readonly conflictResolver?: ConflictResolver;
  /** Resync mode: destroy local synced records absent from the snapshot. */
  readonly replacement?: boolean;
  readonly log?: (message: string) => void;
}

const remoteId = (dirty: DirtyRaw): string => {
  const id = dirty['id'];
  if (typeof id !== 'string' || id === '') {
    throw new Error('applyRemoteChanges: remote record has no string id');
  }
  return id;
};

/** Remote base, local values for locally-changed columns on top. */
function resolveConflict(
  local: RawRecord,
  remote: DirtyRaw,
  table: TableSchema,
): RawRecord {
  const resolved = sanitizedRaw(
    {
      ...remote,
      id: local.id,
      _status: local._status,
      _changed: local._changed,
    },
    table,
  );
  for (const column of changedColumns(local)) {
    resolved[column] = local[column] ?? null;
  }
  return resolved;
}

export async function applyRemoteChanges(
  database: Database,
  remoteChanges: SyncChanges,
  options: ApplyRemoteOptions = {},
): Promise<void> {
  const log = options.log ?? (() => {});
  const operations: BatchOperation[] = [];

  for (const [table, tableChanges] of Object.entries(remoteChanges)) {
    if (!database.schema.tables[table]) {
      log(
        `sync: ignoring changes for unknown table '${table}' (forward compat)`,
      );
      continue;
    }
    if (database.schema.tables[table].localOnly) {
      throw new Error(
        `sync: server response names local-only table '${table}'`,
      );
    }
    const collection = database.get(table);
    const schema = collection.schema;

    // Normalize before applying: the wire contract imposes last-wins on
    // the backend for pushes, and a pull naming one id twice used to
    // insert twice, wedge on the UNIQUE constraint, and repeat forever.
    // Deleted supersedes updated supersedes created; within a bucket the
    // last occurrence wins.
    const lastById = (rows: readonly DirtyRaw[]): DirtyRaw[] => [
      ...new Map(rows.map((row) => [remoteId(row), row])).values(),
    ];
    const deletedIds = new Set(tableChanges.deleted);
    const updatedRows = lastById(
      tableChanges.updated.map((row) => decodeWireRaw(row, schema)),
    ).filter((row) => !deletedIds.has(remoteId(row)));
    const updatedIds = new Set(updatedRows.map(remoteId));
    const createdRows = lastById(
      tableChanges.created.map((row) => decodeWireRaw(row, schema)),
    ).filter((row) => {
      const id = remoteId(row);
      return !deletedIds.has(id) && !updatedIds.has(id);
    });
    if (
      createdRows.length !== tableChanges.created.length ||
      updatedRows.length !== tableChanges.updated.length
    ) {
      log(`sync: normalized duplicate ids in '${table}' changeset`);
    }

    // One lookup for everything this table's changeset references.
    const referencedIds = [
      ...createdRows.map(remoteId),
      ...updatedRows.map(remoteId),
      ...tableChanges.deleted,
    ];
    const localState = new Map<string, 'live' | 'tombstone'>();
    const liveRecords = new Map<string, RawRecord>();
    // A replacement reads the whole table, and every live row it reads
    // ends up in the identity map. That is not churn worth avoiding: a
    // row the snapshot carries needs its record for conflict resolution,
    // and a synced row the snapshot omits needs one to be destroyed and
    // announced. Only locally dirty rows outside the snapshot are
    // materialized for nothing, and that set is the unpushed changes,
    // not the table.
    if (referencedIds.length > 0 || options.replacement) {
      const rows = options.replacement
        ? await queryRows(database, table, [])
        : await queryRowsByIds(database, table, referencedIds);
      for (const row of rows) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- a driver row's values are SqlValue; every table's id column is text, and the cache throws on a row whose id is not a string.
        const id = row['id'] as string;
        if (row['_status'] === 'deleted') {
          localState.set(id, 'tombstone');
        } else {
          localState.set(id, 'live');
          liveRecords.set(id, collection.cache.recordFromRow(row, schema));
        }
      }
    }

    // The v1 protocol mandates full records on the wire (docs/sync-design.md);
    // a sparse record would silently clobber local values with schema
    // defaults, so a nonconforming server is rejected loudly instead.
    const requireFullRecord = (dirty: DirtyRaw): void => {
      for (const column of schema.columnArray) {
        if (!(column.name in dirty)) {
          throw new Error(
            `sync: sparse record from server for '${table}/${String(dirty['id'])}' — ` +
              `missing column '${column.name}'. The protocol requires full records.`,
          );
        }
      }
    };

    const createAsSynced = (dirty: DirtyRaw): BatchOperation => {
      const raw = sanitizedRaw(
        { ...dirty, _status: 'synced', _changed: '' },
        schema,
      );
      raw._status = 'synced';
      raw._changed = '';
      return { type: 'create', table, raw };
    };

    const updateResolved = (local: RawRecord, dirty: DirtyRaw): void => {
      // Created rows track edits made after creation in _changed. Using the
      // server row as the base lets a push accepted before an interrupted
      // mark reconcile later remote updates without losing local edits.
      let resolved = resolveConflict(local, dirty, schema);
      if (options.conflictResolver) {
        resolved = options.conflictResolver(table, local, dirty, resolved);
      }
      // echo/no-op absorption: skip writes that change nothing
      if (
        (local._status === 'synced' || local._status === 'created') &&
        areRecordsEqual(local, resolved)
      ) {
        return;
      }
      operations.push({ type: 'update', table, raw: resolved });
    };

    for (const dirty of createdRows) {
      requireFullRecord(dirty);
      const id = remoteId(dirty);
      const state = localState.get(id);
      if (state === 'live') {
        if (!options.replacement) {
          // in replacement mode every record arrives as created — expected
          log(
            `sync: server created '${table}/${id}' but it exists — treating as update`,
          );
        }
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- 'live' is recorded in the same loop that fills liveRecords, so the two maps agree on this id.
        updateResolved(liveRecords.get(id)!, dirty);
      } else if (state === 'tombstone') {
        // the offline delete wins locally and is pushed later, exactly as
        // the updated bucket and the resync path always treated it —
        // destroying the tombstone here silently resurrected the record
        // and lost the user's delete (sync_model.qnt takes the remote
        // only for local status none or synced)
        log(
          `sync: server created '${table}/${id}' over local tombstone — the local delete stands`,
        );
      } else {
        operations.push(createAsSynced(dirty));
      }
    }

    for (const dirty of updatedRows) {
      requireFullRecord(dirty);
      const id = remoteId(dirty);
      const state = localState.get(id);
      if (state === 'live') {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- 'live' is recorded in the same loop that fills liveRecords, so the two maps agree on this id.
        updateResolved(liveRecords.get(id)!, dirty);
      } else if (state === 'tombstone') {
        // local deletion wins locally; it will be pushed later
      } else {
        if (!options.sendCreatedAsUpdated) {
          log(`sync: server updated unknown '${table}/${id}' — creating it`);
        }
        operations.push(createAsSynced(dirty));
      }
    }

    for (const id of deletedIds) {
      if (localState.has(id)) {
        // remote deletion always wins — over local changes and tombstones
        operations.push({
          type: 'destroyPermanently',
          table,
          raw: { id, _status: 'deleted', _changed: '' },
        });
      }
    }

    if (options.replacement) {
      const snapshotIds = new Set([
        ...createdRows.map(remoteId),
        ...updatedRows.map(remoteId),
        // already destroyed by the deleted loop; destroying twice
        // double-notifies observers for one row
        ...deletedIds,
      ]);
      for (const [id, record] of liveRecords) {
        if (!snapshotIds.has(id) && record._status === 'synced') {
          operations.push({ type: 'destroyPermanently', table, raw: record });
        }
      }
    }
  }

  await database.batch(operations);
}
