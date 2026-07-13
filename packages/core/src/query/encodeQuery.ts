/**
 * The Q → SQL compiler: one pure function from a QueryDescription to
 * parameterized SQL. Values always compile to `?` placeholders — nothing
 * from a description is ever inlined into SQL text except identifiers,
 * which the Q builders have already validated against a strict pattern.
 *
 * Semantics notes (see docs/architecture-layers.md):
 * - Equality uses SQLite `IS` / `IS NOT`, so eq(null) works and
 *   notEq(x) matches rows where the column is null.
 * - Joins are always LEFT JOIN (no upstream inner-join compat hack);
 *   combined with IS-semantics, conditions like notEq can match rows
 *   with no joined record.
 * - Deleted-record filtering is a compiler flag, not part of the query
 *   tree: the main table gets a `_status is not 'deleted'` WHERE clause,
 *   joined tables get it in their JOIN condition (a deleted row can
 *   never satisfy a join, as if it didn't exist).
 * - like/notLike always emit `escape '\'` — pair with Q.escapeLike.
 */
import type { SqlArgs, SqlValue } from '../driver/SqliteDriver'
import type {
  Comparison,
  ComparisonRight,
  NonNullValue,
  QueryDescription,
  Where,
} from './ast'

export type AssociationInfo =
  | { readonly type: 'belongs_to'; readonly key: string }
  | { readonly type: 'has_many'; readonly foreignKey: string }

export interface QueryAssociation {
  readonly from: string
  readonly to: string
  readonly info: AssociationInfo
}

export interface CompilableQuery {
  readonly table: string
  readonly description: QueryDescription
  readonly associations?: readonly QueryAssociation[]
}

export interface EncodeQueryOptions {
  /** 'select' returns full rows; 'count' returns one row with a "count" column. */
  readonly mode?: 'select' | 'count'
  /** Exclude _status = 'deleted' records (default true). */
  readonly filterDeleted?: boolean
}

export type CompiledQuery = readonly [sql: string, args: SqlArgs]

export function encodeQuery(
  query: CompilableQuery,
  options: EncodeQueryOptions = {},
): CompiledQuery {
  const { table, description, associations = [] } = query
  const mode = options.mode ?? 'select'
  const filterDeleted = options.filterDeleted ?? true

  if (description.sql) {
    if (mode === 'count') {
      throw new Error(
        'encodeQuery: cannot count a Q.unsafeSqlQuery — write the count SQL directly',
      )
    }
    return [description.sql.sql, [...description.sql.values]]
  }
  if (
    mode === 'count' &&
    (description.take !== undefined || description.skip !== undefined)
  ) {
    throw new Error('encodeQuery: Q.take/Q.skip are not supported in count mode')
  }

  // Resolve joins: every joined table needs a declared association.
  const findAssociation = (from: string, to: string): QueryAssociation => {
    const association = associations.find((a) => a.from === from && a.to === to)
    if (!association) {
      throw new Error(`encodeQuery: no association from '${from}' to '${to}'`)
    }
    return association
  }
  const usedAssociations: QueryAssociation[] = []
  const joinedSet = new Set<string>()
  for (const to of description.joinTables) {
    usedAssociations.push(findAssociation(table, to))
    joinedSet.add(to)
  }
  for (const nested of description.nestedJoinTables) {
    if (nested.from !== table && !joinedSet.has(nested.from)) {
      throw new Error(
        `encodeQuery: nested join from '${nested.from}' — table is not itself joined`,
      )
    }
    usedAssociations.push(findAssociation(nested.from, nested.to))
    joinedSet.add(nested.to)
  }

  const args: SqlValue[] = []
  const pushArg = (value: SqlValue): string => {
    args.push(value)
    return '?'
  }

  const singleValueOf = (right: ComparisonRight): SqlValue => {
    if ('value' in right) {
      return right.value
    }
    throw new Error('encodeQuery: expected a single-value comparison')
  }
  const valuesOf = (right: ComparisonRight): readonly NonNullValue[] => {
    if ('values' in right) {
      return right.values
    }
    throw new Error('encodeQuery: expected a multi-value comparison')
  }
  const encodeValueOrColumn = (
    right: ComparisonRight,
    tableContext: string,
  ): string => {
    if ('column' in right) {
      return `"${tableContext}"."${right.column}"`
    }
    return pushArg(singleValueOf(right))
  }

  const encodeComparison = (
    tableContext: string,
    left: string,
    comparison: Comparison,
  ): string => {
    const col = `"${tableContext}"."${left}"`
    const { operator, right } = comparison
    switch (operator) {
      case 'eq':
        return `${col} is ${encodeValueOrColumn(right, tableContext)}`
      case 'notEq':
        return `${col} is not ${encodeValueOrColumn(right, tableContext)}`
      case 'gt':
        return `${col} > ${encodeValueOrColumn(right, tableContext)}`
      case 'gte':
        return `${col} >= ${encodeValueOrColumn(right, tableContext)}`
      case 'lt':
        return `${col} < ${encodeValueOrColumn(right, tableContext)}`
      case 'lte':
        return `${col} <= ${encodeValueOrColumn(right, tableContext)}`
      case 'between': {
        const values = valuesOf(right)
        return `${col} between ${pushArg(values[0]!)} and ${pushArg(values[1]!)}`
      }
      case 'oneOf':
        return `${col} in (${valuesOf(right).map((v) => pushArg(v)).join(', ')})`
      case 'notIn':
        return `${col} not in (${valuesOf(right).map((v) => pushArg(v)).join(', ')})`
      case 'like':
        return `${col} like ${pushArg(singleValueOf(right))} escape '\\'`
      case 'notLike':
        return `${col} not like ${pushArg(singleValueOf(right))} escape '\\'`
      case 'includes':
        return `instr(${col}, ${pushArg(singleValueOf(right))}) > 0`
    }
  }

  const encodeCondition = (clause: Where, tableContext: string): string => {
    switch (clause.type) {
      case 'where':
        return encodeComparison(tableContext, clause.left, clause.comparison)
      case 'and':
      case 'or': {
        const parts = clause.conditions.map((c) => encodeCondition(c, tableContext))
        return `(${parts.join(clause.type === 'and' ? ' and ' : ' or ')})`
      }
      case 'on': {
        if (!joinedSet.has(clause.table)) {
          throw new Error(
            `encodeQuery: nested Q.on('${clause.table}') requires the table to be declared with Q.joinTables or Q.nestedJoin`,
          )
        }
        const parts = clause.conditions.map((c) => encodeCondition(c, clause.table))
        return parts.length === 1 ? parts[0]! : `(${parts.join(' and ')})`
      }
      case 'sqlExpr':
        return `(${clause.sql})`
    }
  }

  const encodeJoin = (association: QueryAssociation): string => {
    const { from, to, info } = association
    const joinKey =
      info.type === 'belongs_to'
        ? `"${to}"."id" = "${from}"."${info.key}"`
        : `"${to}"."${info.foreignKey}" = "${from}"."id"`
    const deletedFilter = filterDeleted
      ? ` and "${to}"."_status" is not 'deleted'`
      : ''
    return ` left join "${to}" on ${joinKey}${deletedFilter}`
  }

  const whereParts = description.where.map((clause) =>
    encodeCondition(clause, table),
  )
  if (filterDeleted) {
    whereParts.push(`"${table}"."_status" is not 'deleted'`)
  }

  // A to-many join can fan out main-table rows; distinct collapses them.
  const hasToManyJoin = usedAssociations.some((a) => a.info.type === 'has_many')
  const select =
    mode === 'count'
      ? hasToManyJoin
        ? `select count(distinct "${table}"."id") as "count"`
        : 'select count(*) as "count"'
      : hasToManyJoin
        ? `select distinct "${table}".*`
        : `select "${table}".*`

  const joins = usedAssociations.map(encodeJoin).join('')
  const whereSql = whereParts.length > 0 ? ` where ${whereParts.join(' and ')}` : ''
  const orderSql =
    description.sortBy.length > 0
      ? ` order by ${description.sortBy
          .map((s) => `"${table}"."${s.sortColumn}" ${s.sortOrder}`)
          .join(', ')}`
      : ''
  let limitSql = ''
  if (description.take !== undefined) {
    limitSql = ` limit ${pushArg(description.take)}`
    if (description.skip !== undefined) {
      limitSql += ` offset ${pushArg(description.skip)}`
    }
  }

  return [
    `${select} from "${table}"${joins}${whereSql}${orderSql}${limitSql}`,
    args,
  ]
}
