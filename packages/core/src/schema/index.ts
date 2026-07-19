/**
 * Schema definitions (docs/schema-inferred-types.md). Columns are typeless
 * in SQL (SQLite dynamic typing, matching upstream); the declared
 * ColumnType drives JS-side sanitization and migration backfill defaults.
 * Every table implicitly gets the standard columns `id` (primary key),
 * `_status` and `_changed` (sync dirty tracking) — user schemas cannot
 * redeclare them.
 *
 * A schema literal is the single source of truth: record types
 * (InferRecord), column-name checking in Q, and collection types are all
 * derived from the `table()` definition. The builders produce plain
 * ColumnSchema data; everything type-level is phantom and erased.
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

/**
 * A column under construction: what `column.string()` etc. return, before
 * `table()` attaches the name. Carries its type and optionality in the
 * type system for inference; `optional()`/`indexed()` return new frozen
 * values (builders are immutable).
 */
export interface ColumnDef<
  T extends ColumnType = ColumnType,
  Optional extends boolean = boolean,
> {
  readonly type: T
  readonly isOptional: Optional
  readonly isIndexed: boolean
  optional(): ColumnDef<T, true>
  indexed(): ColumnDef<T, Optional>
}

function columnDef<T extends ColumnType, Optional extends boolean>(
  type: T,
  isOptional: Optional,
  isIndexed: boolean,
): ColumnDef<T, Optional> {
  return Object.freeze({
    type,
    isOptional,
    isIndexed,
    optional(): ColumnDef<T, true> {
      return columnDef(type, true, isIndexed)
    },
    indexed(): ColumnDef<T, Optional> {
      return columnDef(type, isOptional, true)
    },
  })
}

/**
 * The column builders: `column.string()`, `column.number()`,
 * `column.boolean()`, each with `.optional()` and `.indexed()` modifiers.
 *
 * @example
 * ```ts
 * import { column as c, table } from '@remelondb/core'
 * const tasks = table('tasks', {
 *   name: c.string(),
 *   position: c.number().indexed(),
 *   project_id: c.string().optional(),   // → string | null in records
 * })
 * ```
 * @category Schema
 */
export const column = {
  string: (): ColumnDef<'string', false> => columnDef('string', false, false),
  number: (): ColumnDef<'number', false> => columnDef('number', false, false),
  boolean: (): ColumnDef<'boolean', false> => columnDef('boolean', false, false),
}

/**
 * The columns map a `table()` definition takes.
 * @category Schema
 */
export type ColumnsSpec = {
  readonly [name: string]: ColumnDef<ColumnType, boolean>
}

/**
 * A table definition — what `table()` returns. Pass it to `appSchema`,
 * `Database.get`, and `ModelFor`; use `InferRecord` to get its record type.
 * @category Schema
 */
export interface TableSchema<Cols extends ColumnsSpec = ColumnsSpec> {
  readonly name: string
  readonly columns: { readonly [name: string]: ColumnSchema }
  readonly columnArray: readonly ColumnSchema[]
  /** Type-only inference carrier; always undefined at runtime. */
  readonly $cols?: Cols
}

/**
 * The whole application schema — what `appSchema()` returns and
 * `Database.open` takes.
 * @category Schema
 */
export interface AppSchema {
  readonly version: number
  readonly tables: { readonly [name: string]: TableSchema }
}

/**
 * The record type a table's rows have in app code, derived from the
 * `table()` definition: `string`/`number`/`boolean` map to themselves,
 * `.optional()` adds `| null`, and `id` is always present and readonly.
 *
 * @example
 * ```ts
 * type TaskRecord = InferRecord<typeof tasks>
 * // { readonly id: string; name: string; position: number;
 * //   project_id: string | null }
 * ```
 * @category Schema
 */
export type InferRecord<T extends TableSchema<ColumnsSpec>> =
  T extends TableSchema<infer Cols>
    ? { readonly id: string } & {
        [K in keyof Cols & string]:
          | (Cols[K] extends ColumnDef<infer CT, boolean>
              ? CT extends 'string'
                ? string
                : CT extends 'number'
                  ? number
                  : boolean
              : never)
          | (Cols[K] extends ColumnDef<ColumnType, true> ? null : never)
      }
    : never

/**
 * The column names Q clauses may reference for a table (includes `id`).
 * @category Schema
 */
export type ColumnName<T extends TableSchema<ColumnsSpec>> =
  T extends TableSchema<infer Cols> ? (keyof Cols & string) | 'id' : string

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

/** @internal Shared by table() and migrations' createTable. */
export function buildTableSchema(
  name: string,
  columnArray: readonly ColumnSchema[],
): TableSchema {
  ensureName(name, 'table')
  if (name === 'local_storage' || name.startsWith('sqlite_')) {
    throw new Error(`Table name '${name}' is reserved`)
  }
  const columns: { [name: string]: ColumnSchema } = {}
  for (const column of columnArray) {
    validateColumnSchema(column)
    if (columns[column.name]) {
      throw new Error(
        `Table '${name}' declares column '${column.name}' more than once`,
      )
    }
    columns[column.name] = column
  }
  return deepFreeze({ name, columns, columnArray: [...columnArray] })
}

/** @internal Convert a builders map to plain ColumnSchema data. */
export function columnsFromSpec(spec: ColumnsSpec): ColumnSchema[] {
  return Object.entries(spec).map(([name, def]) => ({
    name,
    type: def.type,
    isOptional: def.isOptional,
    isIndexed: def.isIndexed,
  }))
}

/**
 * Define a table. The definition is the single source of truth: pass the
 * returned object to `appSchema`, to `Database.get`, and to `ModelFor`;
 * record types and Q column checking derive from it.
 *
 * @example
 * ```ts
 * const tasks = table('tasks', {
 *   name: column.string(),
 *   position: column.number().indexed(),
 *   project_id: column.string().optional(),
 * })
 * ```
 * @category Schema
 */
export function table<const Cols extends ColumnsSpec>(
  name: string,
  cols: Cols,
): TableSchema<Cols> {
  return buildTableSchema(name, columnsFromSpec(cols)) as TableSchema<Cols>
}

/**
 * Bundle table definitions into the versioned schema `Database.open`
 * takes. Bump `version` (and provide migrations) whenever a table or
 * column is added.
 *
 * @example
 * ```ts
 * export const schema = appSchema({ version: 1, tables: [tasks, projects] })
 * ```
 * @category Schema
 */
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
