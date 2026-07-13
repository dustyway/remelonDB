/**
 * Schema definitions. Columns are typeless in SQL (SQLite dynamic typing,
 * matching upstream); the declared ColumnType drives JS-side sanitization
 * and migration backfill defaults. Every table implicitly gets the standard
 * columns `id` (primary key), `_status` and `_changed` (sync dirty
 * tracking) — user schemas cannot redeclare them.
 */
import { ensureName } from '../utils/checkName'
import { deepFreeze } from '../utils/deepFreeze'

export type ColumnType = 'string' | 'number' | 'boolean'

export interface ColumnSchema {
  readonly name: string
  readonly type: ColumnType
  readonly isOptional?: boolean
  readonly isIndexed?: boolean
}

export interface TableSchema {
  readonly name: string
  readonly columns: { readonly [name: string]: ColumnSchema }
  readonly columnArray: readonly ColumnSchema[]
}

export interface AppSchema {
  readonly version: number
  readonly tables: { readonly [name: string]: TableSchema }
}

const RESERVED_COLUMNS = new Set([
  'id',
  '_status',
  '_changed',
  // SQLite rowid aliases — allowing these would shadow the real rowid
  'rowid',
  'oid',
  '_rowid_',
])

export function validateColumnSchema(column: ColumnSchema): ColumnSchema {
  ensureName(column.name, 'column')
  if (RESERVED_COLUMNS.has(column.name.toLowerCase())) {
    throw new Error(`Column name '${column.name}' is reserved`)
  }
  if (!['string', 'number', 'boolean'].includes(column.type)) {
    throw new Error(
      `Column '${column.name}' has invalid type '${String(column.type)}'`,
    )
  }
  if (
    (column.name === 'created_at' || column.name === 'updated_at') &&
    (column.type !== 'number' || column.isOptional)
  ) {
    throw new Error(`Column '${column.name}' must be a non-optional number`)
  }
  return column
}

export function tableSchema(spec: {
  name: string
  columns: readonly ColumnSchema[]
}): TableSchema {
  ensureName(spec.name, 'table')
  if (spec.name === 'local_storage' || spec.name.startsWith('sqlite_')) {
    throw new Error(`Table name '${spec.name}' is reserved`)
  }
  const columns: { [name: string]: ColumnSchema } = {}
  for (const column of spec.columns) {
    validateColumnSchema(column)
    if (columns[column.name]) {
      throw new Error(
        `Table '${spec.name}' declares column '${column.name}' more than once`,
      )
    }
    columns[column.name] = column
  }
  return deepFreeze({
    name: spec.name,
    columns,
    columnArray: [...spec.columns],
  })
}

export function appSchema(spec: {
  version: number
  tables: readonly TableSchema[]
}): AppSchema {
  if (!Number.isInteger(spec.version) || spec.version < 1) {
    throw new Error(`Schema version must be a positive integer, got ${spec.version}`)
  }
  const tables: { [name: string]: TableSchema } = {}
  for (const table of spec.tables) {
    if (tables[table.name]) {
      throw new Error(`Schema declares table '${table.name}' more than once`)
    }
    tables[table.name] = table
  }
  return deepFreeze({ version: spec.version, tables })
}
