/**
 * Compiles batch operations into prepared statements for
 * driver.executeBatch. Consecutive operations with identical SQL are
 * grouped into one prepare-once-run-many entry.
 */
import type { BatchStatement, SqlValue } from '../driver/SqliteDriver'
import type { AppSchema, TableSchema } from '../schema/index'
import type { RawRecord } from '../rawRecord/index'

export type BatchOperation =
  | { readonly type: 'create'; readonly table: string; readonly raw: RawRecord }
  | { readonly type: 'update'; readonly table: string; readonly raw: RawRecord }
  | { readonly type: 'markAsDeleted'; readonly table: string; readonly raw: RawRecord }
  | { readonly type: 'destroyPermanently'; readonly table: string; readonly raw: RawRecord }

const rawValues = (raw: RawRecord, table: TableSchema): SqlValue[] =>
  table.columnArray.map((column) => raw[column.name] ?? null)

function encodeOperation(
  operation: BatchOperation,
  table: TableSchema,
): readonly [sql: string, args: SqlValue[]] {
  const { raw } = operation
  const name = table.name
  switch (operation.type) {
    case 'create': {
      const columns = ['id', '_changed', '_status', ...table.columnArray.map((c) => c.name)]
      const quoted = columns.map((c) => `"${c}"`).join(', ')
      const placeholders = columns.map(() => '?').join(', ')
      return [
        `insert into "${name}" (${quoted}) values (${placeholders})`,
        [raw.id, raw._changed, raw._status, ...rawValues(raw, table)],
      ]
    }
    case 'update': {
      const assignments = ['"_changed" = ?', '"_status" = ?']
        .concat(table.columnArray.map((c) => `"${c.name}" = ?`))
        .join(', ')
      return [
        `update "${name}" set ${assignments} where "id" = ?`,
        [raw._changed, raw._status, ...rawValues(raw, table), raw.id],
      ]
    }
    case 'markAsDeleted':
      return [
        `update "${name}" set "_status" = 'deleted', "_changed" = '' where "id" = ?`,
        [raw.id],
      ]
    case 'destroyPermanently':
      return [`delete from "${name}" where "id" = ?`, [raw.id]]
  }
}

export function encodeBatch(
  operations: readonly BatchOperation[],
  schema: AppSchema,
): BatchStatement[] {
  const statements: [string, SqlValue[][]][] = []
  for (const operation of operations) {
    const table = schema.tables[operation.table]
    if (!table) {
      throw new Error(`encodeBatch: unknown table '${operation.table}'`)
    }
    const [sql, args] = encodeOperation(operation, table)
    const last = statements[statements.length - 1]
    if (last && last[0] === sql) {
      last[1].push(args)
    } else {
      statements.push([sql, [args]])
    }
  }
  return statements
}
