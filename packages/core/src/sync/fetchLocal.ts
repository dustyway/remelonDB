/**
 * The push-side snapshot: every dirty record (created/updated) and every
 * tombstone, per table, in wire shape — plus frozen copies of the dirty
 * raws so markLocalChangesAsSynced can detect records modified while the
 * push was in flight (the equality gate).
 *
 * Runs in its own read block — do not call from inside db.read/db.write.
 */
import * as Q from '../query/Q'
import type { Database } from '../database/Database'
import type { RawRecord } from '../rawRecord/index'
import { isChangesEmpty, stripInternal, tombstoneIds } from './helpers'
import type { SyncChanges, SyncTableChanges } from './types'

/** @internal Pre-push snapshot used to detect mid-push writes. */
export interface DirtyRecordSnapshot {
  /** The live cached instance. */
  readonly record: RawRecord
  /** Copy taken at fetch time — compared against `record` after the push. */
  readonly frozen: RawRecord
}

export interface LocalChanges {
  readonly changes: SyncChanges
  readonly dirtyRecords: { readonly [table: string]: readonly DirtyRecordSnapshot[] }
  readonly isEmpty: boolean
}

export async function fetchLocalChanges(database: Database): Promise<LocalChanges> {
  return database.read(async () => {
    const changes: { [table: string]: SyncTableChanges } = {}
    const dirtyRecords: { [table: string]: DirtyRecordSnapshot[] } = {}

    for (const table of Object.keys(database.schema.tables)) {
      const collection = database.get(table)
      const created = await collection
        .query(Q.where('_status', 'created'))
        .fetchRaws()
      const updated = await collection
        .query(Q.where('_status', 'updated'))
        .fetchRaws()
      const deleted = await tombstoneIds(database, table)

      changes[table] = {
        created: created.map((raw) => stripInternal(raw, collection.schema)),
        updated: updated.map((raw) => stripInternal(raw, collection.schema)),
        deleted,
      }
      dirtyRecords[table] = [...created, ...updated].map((record) => ({
        record,
        frozen: { ...record },
      }))
    }

    const result: LocalChanges = {
      changes,
      dirtyRecords,
      isEmpty: isChangesEmpty(changes),
    }
    return result
  })
}

export async function hasUnsyncedChanges(database: Database): Promise<boolean> {
  return !(await fetchLocalChanges(database)).isEmpty
}
