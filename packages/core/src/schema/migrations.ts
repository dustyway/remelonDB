/**
 * Schema migrations: an ordered list of step batches, each bringing the
 * database to `toVersion`. Steps are data (like queries); the DDL compiler
 * in ./encodeSchema.ts turns them into SQL.
 *
 * Departure from upstream: there is no silent destroy-and-recreate fallback
 * when a migration path is missing — stepsForMigration returns null and the
 * caller must treat that as an explicit error or opt into a reset.
 */
import {
  tableSchema,
  validateColumnSchema,
  type ColumnSchema,
  type TableSchema,
} from './index'
import { ensureName } from '../utils/checkName'
import { deepFreeze } from '../utils/deepFreeze'

export type MigrationStep =
  | { readonly type: 'create_table'; readonly schema: TableSchema }
  | {
      readonly type: 'add_columns'
      readonly table: string
      readonly columns: readonly ColumnSchema[]
    }
  /** A single raw SQL statement — unsafe. */
  | { readonly type: 'sql'; readonly sql: string }

export interface Migration {
  readonly toVersion: number
  readonly steps: readonly MigrationStep[]
}

export interface SchemaMigrations {
  readonly migrations: readonly Migration[]
  /** Oldest database version these migrations can migrate from. */
  readonly minVersion: number
  /** Newest version these migrations lead to. */
  readonly maxVersion: number
}

export function createTable(spec: {
  name: string
  columns: readonly ColumnSchema[]
}): MigrationStep {
  return { type: 'create_table', schema: tableSchema(spec) }
}

export function addColumns(spec: {
  table: string
  columns: readonly ColumnSchema[]
}): MigrationStep {
  ensureName(spec.table, 'table')
  if (spec.columns.length === 0) {
    throw new Error('addColumns: at least one column is required')
  }
  spec.columns.forEach(validateColumnSchema)
  return { type: 'add_columns', table: spec.table, columns: [...spec.columns] }
}

export function unsafeExecuteSql(sql: string): MigrationStep {
  if (typeof sql !== 'string' || sql.trim() === '') {
    throw new Error('unsafeExecuteSql: expected a non-empty SQL string')
  }
  return { type: 'sql', sql }
}

export function schemaMigrations(spec: {
  migrations: readonly Migration[]
}): SchemaMigrations {
  const { migrations } = spec
  if (migrations.length === 0) {
    throw new Error('schemaMigrations: at least one migration is required')
  }
  migrations.forEach((migration, index) => {
    if (!Number.isInteger(migration.toVersion) || migration.toVersion < 2) {
      throw new Error(
        `schemaMigrations: toVersion must be an integer >= 2, got ${migration.toVersion}`,
      )
    }
    const previous = migrations[index - 1]
    if (previous && migration.toVersion !== previous.toVersion + 1) {
      throw new Error(
        `schemaMigrations: migrations must be sorted and contiguous — found toVersion ${migration.toVersion} after ${previous.toVersion}`,
      )
    }
  })
  const first = migrations[0]!
  const last = migrations[migrations.length - 1]!
  return deepFreeze({
    migrations: [...migrations],
    minVersion: first.toVersion - 1,
    maxVersion: last.toVersion,
  })
}

/**
 * The steps to migrate a database from version `from` to version `to`, or
 * null when the migrations don't cover that range.
 */
export function stepsForMigration(
  migrations: SchemaMigrations,
  range: { from: number; to: number },
): readonly MigrationStep[] | null {
  const { from, to } = range
  if (from >= to || from < migrations.minVersion || to > migrations.maxVersion) {
    return null
  }
  return migrations.migrations
    .filter((m) => m.toVersion > from && m.toVersion <= to)
    .flatMap((m) => m.steps)
}
