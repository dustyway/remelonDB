/**
 * The DDL compiler: schema/migration definitions → lists of single SQL
 * statements (drivers prepare one statement at a time; executeBatch runs a
 * list atomically). Identifiers were validated at schema construction;
 * backfill defaults are derived from column types, never from user input.
 */
import type { AppSchema, ColumnSchema, TableSchema } from './index'
import type { MigrationStep } from './migrations'

/** Key-value store used by core for the sync cursor and app local storage. */
const LOCAL_STORAGE_SCHEMA = `create table "local_storage" ("key" primary key not null, "value")`

function encodeIndex(table: string, column: string): string {
  return `create index if not exists "${table}_${column}" on "${table}" ("${column}")`
}

function encodeTableIndices(table: TableSchema): string[] {
  return [
    ...table.columnArray
      .filter((column) => column.isIndexed)
      .map((column) => encodeIndex(table.name, column.name)),
    // _status is queried by every query (deleted filtering) and by sync
    encodeIndex(table.name, '_status'),
  ]
}

function encodeCreateTable(table: TableSchema): string {
  const columns = [
    '"id" primary key',
    '"_changed"',
    '"_status"',
    ...table.columnArray.map((column) => `"${column.name}"`),
  ].join(', ')
  return `create table "${table.name}" (${columns})`
}

export function encodeTable(table: TableSchema): string[] {
  return [encodeCreateTable(table), ...encodeTableIndices(table)]
}

export function encodeSchema(schema: AppSchema): string[] {
  return [
    LOCAL_STORAGE_SCHEMA,
    ...Object.values(schema.tables).flatMap(encodeTable),
  ]
}

/**
 * Backfill default for a newly added column, as a SQL literal. Booleans are
 * stored as 0/1 (the seam-wide convention, see NodeSqliteDriver.bindArgs).
 */
function defaultValueSql(column: ColumnSchema): string {
  if (column.isOptional) {
    return 'null'
  }
  switch (column.type) {
    case 'string':
      return "''"
    case 'number':
    case 'boolean':
      return '0'
  }
}

function encodeAddColumns(step: {
  table: string
  columns: readonly ColumnSchema[]
}): string[] {
  return step.columns.flatMap((column) => [
    // ADD COLUMN with DEFAULT backfills existing rows in SQLite
    `alter table "${step.table}" add "${column.name}" default ${defaultValueSql(column)}`,
    ...(column.isIndexed ? [encodeIndex(step.table, column.name)] : []),
  ])
}

export function encodeMigrationSteps(steps: readonly MigrationStep[]): string[] {
  return steps.flatMap((step) => {
    switch (step.type) {
      case 'create_table':
        return encodeTable(step.schema)
      case 'add_columns':
        return encodeAddColumns(step)
      case 'sql':
        return [step.sql]
    }
  })
}
