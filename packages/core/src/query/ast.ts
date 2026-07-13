/**
 * The query AST (docs/q-dsl-and-one-engine.md): a query is pure, serializable
 * data — building one executes nothing. The builders in ./Q.ts are the only
 * sanctioned constructors; they validate names and values at construction
 * time, so a well-typed QueryDescription never contains unsanitized input.
 *
 * Deliberate departures from upstream WatermelonDB (docs/upstream-study.md):
 * no Loki node types, no `weakGt` (SQLite comparison semantics are the only
 * semantics), and no deleted-record filtering baked into the tree (that is a
 * compiler flag). Values compile to `?` placeholders, never inlined SQL.
 */
import type { SqlValue } from '../driver/SqliteDriver'

export type Value = SqlValue
export type NonNullValue = string | number | boolean

/** Runtime tags proving a value came from a Q builder, not user data. */
export const columnTag: unique symbol = Symbol('Q.column')
export const comparisonTag: unique symbol = Symbol('Q.comparison')

/** Right-hand side referring to another column, from `Q.column()`. */
export interface ColumnDescription {
  readonly type: typeof columnTag
  readonly column: string
}

export type ComparisonRight =
  | { readonly value: Value }
  | { readonly values: readonly NonNullValue[] }
  | { readonly column: string }

export type ComparisonOperator =
  | 'eq'
  | 'notEq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'oneOf'
  | 'notIn'
  | 'between'
  | 'like'
  | 'notLike'
  | 'includes'

export interface Comparison {
  readonly type: typeof comparisonTag
  readonly operator: ComparisonOperator
  readonly right: ComparisonRight
}

export interface WhereDescription {
  readonly type: 'where'
  readonly left: string
  readonly comparison: Comparison
}

export interface And {
  readonly type: 'and'
  readonly conditions: readonly Where[]
}

export interface Or {
  readonly type: 'or'
  readonly conditions: readonly Where[]
}

/** A condition on a joined table (`Q.on`). */
export interface On {
  readonly type: 'on'
  readonly table: string
  readonly conditions: readonly Where[]
}

/** Raw SQL fragment inside a WHERE — unsafe, injected verbatim. */
export interface UnsafeSqlExpr {
  readonly type: 'sqlExpr'
  readonly sql: string
}

export type Where = WhereDescription | And | Or | On | UnsafeSqlExpr

export type SortOrder = 'asc' | 'desc'

export interface SortBy {
  readonly type: 'sortBy'
  readonly sortColumn: string
  readonly sortOrder: SortOrder
}

export interface Take {
  readonly type: 'take'
  readonly count: number
}

export interface Skip {
  readonly type: 'skip'
  readonly count: number
}

/** Declares joined tables up front so nested `Q.on` is legal. */
export interface JoinTables {
  readonly type: 'joinTables'
  readonly tables: readonly string[]
}

/** A join reached through another joined table. */
export interface NestedJoinTable {
  readonly type: 'nestedJoinTable'
  readonly from: string
  readonly to: string
}

/** Replaces the entire compiled query — unsafe. Values are still bound. */
export interface UnsafeSqlQuery {
  readonly type: 'sqlQuery'
  readonly sql: string
  readonly values: readonly Value[]
}

export type Clause =
  | Where
  | SortBy
  | Take
  | Skip
  | JoinTables
  | NestedJoinTable
  | UnsafeSqlQuery

export interface QueryDescription {
  readonly where: readonly Where[]
  readonly joinTables: readonly string[]
  readonly nestedJoinTables: readonly NestedJoinTable[]
  readonly sortBy: readonly SortBy[]
  readonly take?: number
  readonly skip?: number
  readonly sql?: UnsafeSqlQuery
}
