/**
 * The Q builder API — the only sanctioned way to construct query ASTs.
 * Everything is validated here so the SQL compiler can trust its input:
 * identifiers match a strict pattern, values are primitives (never
 * `undefined`, never objects), and condition trees only contain nodes
 * produced by these builders (enforced via runtime tags).
 */
import {
  columnTag,
  comparisonTag,
  type And,
  type Clause,
  type ColumnDescription,
  type Comparison,
  type ComparisonOperator,
  type JoinTables,
  type NestedJoinTable,
  type NonNullValue,
  type On,
  type Or,
  type QueryDescription,
  type Skip,
  type SortBy,
  type SortOrder,
  type Take,
  type UnsafeSqlExpr,
  type UnsafeSqlQuery,
  type Value,
  type Where,
  type WhereDescription,
} from './ast'
import { deepFreeze } from '../utils/deepFreeze'
import { ensureName } from '../utils/checkName'

function isColumn(value: unknown): value is ColumnDescription {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === columnTag
  )
}

function isComparison(value: unknown): value is Comparison {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === comparisonTag
  )
}

function ensureValue(value: unknown): Value {
  if (value === undefined) {
    throw new Error('Q: value cannot be undefined — did you mean null?')
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`Q: value cannot be ${value}`)
  }
  if (
    value !== null &&
    typeof value !== 'string' &&
    typeof value !== 'number' &&
    typeof value !== 'boolean'
  ) {
    throw new Error(`Q: invalid value ${String(value)} — must be a primitive`)
  }
  return value as Value
}

function ensureNonNullValue(value: unknown): NonNullValue {
  const checked = ensureValue(value)
  if (checked === null) {
    throw new Error('Q: null is not allowed here')
  }
  return checked
}

function comparison(
  operator: ComparisonOperator,
  right: Comparison['right'],
): Comparison {
  return { type: comparisonTag, operator, right }
}

function valueOrColumn(
  operator: ComparisonOperator,
  right: unknown,
  ensure: (value: unknown) => Value = ensureValue,
): Comparison {
  if (isColumn(right)) {
    return comparison(operator, { column: right.column })
  }
  return comparison(operator, { value: ensure(right) })
}

// --- comparisons ---

export function column(name: string): ColumnDescription {
  return { type: columnTag, column: ensureName(name, 'column') }
}

export function eq(value: Value | ColumnDescription): Comparison {
  return valueOrColumn('eq', value)
}

export function notEq(value: Value | ColumnDescription): Comparison {
  return valueOrColumn('notEq', value)
}

export function gt(value: NonNullValue | ColumnDescription): Comparison {
  return valueOrColumn('gt', value, ensureNonNullValue)
}

export function gte(value: NonNullValue | ColumnDescription): Comparison {
  return valueOrColumn('gte', value, ensureNonNullValue)
}

export function lt(value: NonNullValue | ColumnDescription): Comparison {
  return valueOrColumn('lt', value, ensureNonNullValue)
}

export function lte(value: NonNullValue | ColumnDescription): Comparison {
  return valueOrColumn('lte', value, ensureNonNullValue)
}

export function oneOf(values: readonly NonNullValue[]): Comparison {
  if (!Array.isArray(values)) {
    throw new Error('Q.oneOf: expected an array')
  }
  return comparison('oneOf', { values: values.map(ensureNonNullValue) })
}

export function notIn(values: readonly NonNullValue[]): Comparison {
  if (!Array.isArray(values)) {
    throw new Error('Q.notIn: expected an array')
  }
  return comparison('notIn', { values: values.map(ensureNonNullValue) })
}

export function between(start: number, end: number): Comparison {
  if (typeof start !== 'number' || typeof end !== 'number') {
    throw new Error('Q.between: expected two numbers')
  }
  return comparison('between', {
    values: [ensureNonNullValue(start), ensureNonNullValue(end)],
  })
}

export function like(pattern: string): Comparison {
  if (typeof pattern !== 'string') {
    throw new Error('Q.like: expected a string')
  }
  return comparison('like', { value: pattern })
}

export function notLike(pattern: string): Comparison {
  if (typeof pattern !== 'string') {
    throw new Error('Q.notLike: expected a string')
  }
  return comparison('notLike', { value: pattern })
}

export function includes(substring: string): Comparison {
  if (typeof substring !== 'string') {
    throw new Error('Q.includes: expected a string')
  }
  return comparison('includes', { value: substring })
}

/**
 * Escape user input for use inside a LIKE pattern. The compiler always emits
 * `ESCAPE '\'` for like/notLike, so `\`, `%` and `_` escaped here are matched
 * literally: Q.like(`%${Q.escapeLike(userInput)}%`).
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

// --- conditions ---

function ensureConditions(
  clauses: readonly unknown[],
  context: string,
): readonly Where[] {
  if (clauses.length === 0) {
    throw new Error(`${context}: at least one condition is required`)
  }
  for (const clause of clauses) {
    const type =
      typeof clause === 'object' && clause !== null
        ? (clause as { type?: unknown }).type
        : undefined
    const ok =
      type === 'where' ||
      type === 'and' ||
      type === 'or' ||
      type === 'on' ||
      type === 'sqlExpr'
    if (!ok) {
      throw new Error(
        `${context}: invalid condition — use Q.where/Q.and/Q.or/Q.on/Q.unsafeSqlExpr`,
      )
    }
  }
  return clauses as readonly Where[]
}

export function where(
  left: string,
  valueOrComparisonArg: Value | Comparison,
): WhereDescription {
  const comp = isComparison(valueOrComparisonArg)
    ? valueOrComparisonArg
    : eq(ensureValue(valueOrComparisonArg))
  return { type: 'where', left: ensureName(left, 'column'), comparison: comp }
}

export function and(...conditions: Where[]): And {
  return { type: 'and', conditions: ensureConditions(conditions, 'Q.and') }
}

export function or(...conditions: Where[]): Or {
  return { type: 'or', conditions: ensureConditions(conditions, 'Q.or') }
}

export function on(
  table: string,
  left: string,
  valueOrComparison: Value | Comparison,
): On
export function on(table: string, ...conditions: Where[]): On
export function on(table: string, ...args: readonly unknown[]): On {
  const tableName = ensureName(table, 'table')
  const [first] = args
  if (typeof first === 'string') {
    if (args.length !== 2) {
      throw new Error('Q.on: shorthand form is Q.on(table, column, value)')
    }
    return {
      type: 'on',
      table: tableName,
      conditions: [where(first, args[1] as Value | Comparison)],
    }
  }
  return {
    type: 'on',
    table: tableName,
    conditions: ensureConditions(args, 'Q.on'),
  }
}

// --- other clauses ---

export const asc: SortOrder = 'asc'
export const desc: SortOrder = 'desc'

export function sortBy(sortColumn: string, sortOrder: SortOrder = asc): SortBy {
  if (sortOrder !== 'asc' && sortOrder !== 'desc') {
    throw new Error(`Q.sortBy: invalid sort order '${String(sortOrder)}'`)
  }
  return {
    type: 'sortBy',
    sortColumn: ensureName(sortColumn, 'column'),
    sortOrder,
  }
}

function ensureCount(count: number, context: string): number {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`${context}: expected a non-negative integer`)
  }
  return count
}

export function take(count: number): Take {
  return { type: 'take', count: ensureCount(count, 'Q.take') }
}

export function skip(count: number): Skip {
  return { type: 'skip', count: ensureCount(count, 'Q.skip') }
}

export function joinTables(tables: readonly string[]): JoinTables {
  if (!Array.isArray(tables)) {
    throw new Error('Q.joinTables: expected an array of table names')
  }
  return {
    type: 'joinTables',
    tables: tables.map((table) => ensureName(table, 'table')),
  }
}

export function nestedJoin(from: string, to: string): NestedJoinTable {
  return {
    type: 'nestedJoinTable',
    from: ensureName(from, 'table'),
    to: ensureName(to, 'table'),
  }
}

// --- unsafe escape hatches ---

export function unsafeSqlExpr(sql: string): UnsafeSqlExpr {
  if (typeof sql !== 'string') {
    throw new Error('Q.unsafeSqlExpr: expected a string')
  }
  return { type: 'sqlExpr', sql }
}

export function unsafeSqlQuery(
  sql: string,
  values: readonly Value[] = [],
): UnsafeSqlQuery {
  if (typeof sql !== 'string') {
    throw new Error('Q.unsafeSqlQuery: expected a string')
  }
  if (!Array.isArray(values)) {
    throw new Error('Q.unsafeSqlQuery: expected an array of values')
  }
  return { type: 'sqlQuery', sql, values: values.map(ensureValue) }
}

// --- assembly ---

export function buildQueryDescription(
  clauses: readonly Clause[],
): QueryDescription {
  const whereConditions: Where[] = []
  const joined: string[] = []
  const nestedJoined: NestedJoinTable[] = []
  const sorts: SortBy[] = []
  let takeCount: number | undefined
  let skipCount: number | undefined
  let sql: UnsafeSqlQuery | undefined

  for (const clause of clauses) {
    switch (clause.type) {
      case 'where':
      case 'and':
      case 'or':
      case 'sqlExpr':
        whereConditions.push(clause)
        break
      case 'on':
        whereConditions.push(clause)
        joined.push(clause.table)
        break
      case 'joinTables':
        joined.push(...clause.tables)
        break
      case 'nestedJoinTable':
        nestedJoined.push(clause)
        break
      case 'sortBy':
        sorts.push(clause)
        break
      case 'take':
        if (takeCount !== undefined) {
          throw new Error('Q: duplicate Q.take clause')
        }
        takeCount = clause.count
        break
      case 'skip':
        if (skipCount !== undefined) {
          throw new Error('Q: duplicate Q.skip clause')
        }
        skipCount = clause.count
        break
      case 'sqlQuery':
        if (sql !== undefined) {
          throw new Error('Q: duplicate Q.unsafeSqlQuery clause')
        }
        sql = clause
        break
      default:
        throw new Error(
          `Q: invalid clause ${String((clause as { type?: unknown }).type)}`,
        )
    }
  }

  if (skipCount !== undefined && takeCount === undefined) {
    throw new Error('Q.skip requires Q.take')
  }
  if (
    sql !== undefined &&
    (whereConditions.length > 0 ||
      sorts.length > 0 ||
      takeCount !== undefined ||
      skipCount !== undefined)
  ) {
    throw new Error(
      'Q.unsafeSqlQuery replaces the whole query — it can only be combined with Q.joinTables/Q.nestedJoin',
    )
  }

  const description: QueryDescription = {
    where: whereConditions,
    joinTables: [...new Set(joined)],
    nestedJoinTables: nestedJoined,
    sortBy: sorts,
    ...(takeCount !== undefined ? { take: takeCount } : {}),
    ...(skipCount !== undefined ? { skip: skipCount } : {}),
    ...(sql !== undefined ? { sql } : {}),
  }

  if (process.env.NODE_ENV !== 'production') {
    deepFreeze(description)
  }
  return description
}
