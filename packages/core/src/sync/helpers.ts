import { encodeQuery } from '../query/encodeQuery'
import { buildQueryDescription } from '../query/Q'
import * as Q from '../query/Q'
import type { Clause } from '../query/ast'
import type { Row } from '../driver/SqliteDriver'
import type { TableSchema } from '../schema/index'
import type { DirtyRaw, RawRecord } from '../rawRecord/index'
import type { Database } from '../database/Database'
import type { SyncChanges } from './types'

export const changedColumns = (raw: RawRecord): string[] =>
  raw._changed === '' ? [] : raw._changed.split(',')

/** Shallow equality over all fields — the mark-as-synced gate. */
export function areRecordsEqual(a: RawRecord, b: RawRecord): boolean {
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  return (
    keysA.length === keysB.length && keysA.every((key) => a[key] === b[key])
  )
}

export function isChangesEmpty(changes: SyncChanges): boolean {
  return Object.values(changes).every(
    (table) =>
      table.created.length === 0 &&
      table.updated.length === 0 &&
      table.deleted.length === 0,
  )
}

/** Wire shape: user columns + id only; _status/_changed never leave. */
export function stripInternal(raw: RawRecord, table: TableSchema): DirtyRaw {
  const result: { [key: string]: unknown } = { id: raw.id }
  for (const column of table.columnArray) {
    result[column.name] = raw[column.name] ?? null
  }
  return result
}

/** Raw rows straight from the driver, bypassing cache and deleted filter. */
export async function queryRows(
  database: Database,
  table: string,
  clauses: Clause[],
): Promise<Row[]> {
  const [sql, args] = encodeQuery(
    { table, description: buildQueryDescription(clauses) },
    { filterDeleted: false },
  )
  return database.driver.query(sql, args)
}

/** Ids of this table's tombstones (locally deleted, awaiting push). */
export async function tombstoneIds(
  database: Database,
  table: string,
): Promise<string[]> {
  const rows = await queryRows(database, table, [
    Q.where('_status', 'deleted'),
  ])
  return rows.map((row) => row['id'] as string)
}

// well under SQLite's bound-parameter limits (999 in old builds)
const ID_CHUNK = 900

/** Rows for the given ids, chunked so large pulls never overflow SQLite's parameter limit. */
export async function queryRowsByIds(
  database: Database,
  table: string,
  ids: readonly string[],
): Promise<Row[]> {
  const rows: Row[] = []
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    rows.push(
      ...(await queryRows(database, table, [
        Q.where('id', Q.oneOf(ids.slice(i, i + ID_CHUNK))),
      ])),
    )
  }
  return rows
}
