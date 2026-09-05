/**
 * After a successful push: flip pushed records to synced and destroy
 * pushed tombstones — except records the server rejected, and records
 * modified since the push snapshot (the areRecordsEqual gate): those stay
 * dirty and go out with the next push.
 *
 * Tombstones have no snapshot, so their gate is the stored state: a
 * pushed tombstone is destroyed only while the row is STILL a tombstone.
 * Another context may have destroyed it and re-created the id as live
 * during the push (a pull applying the server's re-creation); destroying
 * that live row would erase newer knowledge, and skipping is idempotent —
 * a delete the server already applied is a no-op to re-push.
 *
 * Must be called inside a database.write block. One atomic batch.
 */
import type { Database } from '../database/Database';
import type { BatchOperation } from '../database/encodeBatch';
import type { RawRecord } from '../rawRecord/index';
import { areRecordsEqual, queryRowsByIds } from './helpers';
import type { LocalChanges } from './fetchLocal';

export async function markLocalChangesAsSynced(
  database: Database,
  localChanges: LocalChanges,
  rejected?: { readonly [table: string]: readonly string[] },
): Promise<void> {
  const operations: BatchOperation[] = [];

  for (const [table, snapshots] of Object.entries(localChanges.dirtyRecords)) {
    const rejectedIds = new Set(rejected?.[table] ?? []);
    for (const { record, frozen } of snapshots) {
      if (rejectedIds.has(record.id)) {
        continue; // server refused it — stays dirty
      }
      if (!areRecordsEqual(record, frozen)) {
        continue; // modified during push — stays dirty, pushed next sync
      }
      const synced: RawRecord = { ...record, _status: 'synced', _changed: '' };
      operations.push({ type: 'update', table, raw: synced });
    }
  }

  for (const [table, tableChanges] of Object.entries(localChanges.changes)) {
    const rejectedIds = new Set(rejected?.[table] ?? []);
    const pushedIds = tableChanges.deleted.filter((id) => !rejectedIds.has(id));
    if (pushedIds.length === 0) {
      continue;
    }
    const stillTombstoned = new Set(
      (await queryRowsByIds(database, table, pushedIds))
        .filter((row) => row['_status'] === 'deleted')
        .map((row) => row['id']),
    );
    for (const id of pushedIds) {
      if (!stillTombstoned.has(id)) {
        continue; // destroyed or re-created mid-push — newer knowledge wins
      }
      operations.push({
        type: 'destroyPermanently',
        table,
        raw: { id, _status: 'deleted', _changed: '' },
      });
    }
  }

  await database.batch(operations);
}
