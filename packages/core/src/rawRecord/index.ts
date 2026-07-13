/**
 * Raw records: the plain-object representation of a database row on the JS
 * side. `sanitizedRaw` is the single trust boundary — everything entering
 * the system as a record (adapter rows, sync payloads, user-created
 * records) passes through it, so a RawRecord is valid by construction:
 * every schema column present with a type-correct value, unknown keys
 * dropped, sync fields well-formed.
 *
 * JS-side convention: booleans are real booleans (the driver seam stores
 * them as 0/1; sanitization converts 0/1 back on read).
 */
import type { SqlValue } from '../driver/SqliteDriver'
import type { ColumnSchema, TableSchema } from '../schema/index'
import { randomId } from '../utils/randomId'

export type SyncStatus = 'synced' | 'created' | 'updated' | 'deleted'

export interface RawRecord {
  id: string
  _status: SyncStatus
  _changed: string
  [column: string]: SqlValue
}

/** Untrusted input: an adapter row, a sync payload, user data. */
export type DirtyRaw = { readonly [key: string]: unknown }

/** The value an absent/invalid field falls back to, per column schema. */
export function nullValue(column: ColumnSchema): SqlValue {
  if (column.isOptional) {
    return null
  }
  switch (column.type) {
    case 'string':
      return ''
    case 'number':
      return 0
    case 'boolean':
      return false
  }
}

function sanitizeValue(value: unknown, column: ColumnSchema): SqlValue {
  switch (column.type) {
    case 'string':
      if (typeof value === 'string') {
        return value
      }
      break
    case 'number':
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value
      }
      break
    case 'boolean':
      if (typeof value === 'boolean') {
        return value
      }
      if (value === 1) {
        return true
      }
      if (value === 0) {
        return false
      }
      break
  }
  return nullValue(column)
}

function isSyncStatus(value: unknown): value is SyncStatus {
  return (
    value === 'synced' ||
    value === 'created' ||
    value === 'updated' ||
    value === 'deleted'
  )
}

export function sanitizedRaw(dirty: DirtyRaw, table: TableSchema): RawRecord {
  const id = dirty['id']
  const status = dirty['_status']
  const changed = dirty['_changed']
  const raw: RawRecord = {
    id: typeof id === 'string' && id !== '' ? id : randomId(),
    _status: isSyncStatus(status) ? status : 'created',
    _changed: typeof changed === 'string' ? changed : '',
  }
  for (const column of table.columnArray) {
    raw[column.name] = sanitizeValue(dirty[column.name], column)
  }
  return raw
}

/** Sanitize a single value into an existing raw (record updates). */
export function setRawSanitized(
  raw: RawRecord,
  value: unknown,
  column: ColumnSchema,
): void {
  raw[column.name] = sanitizeValue(value, column)
}
