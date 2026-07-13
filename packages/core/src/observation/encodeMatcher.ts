/**
 * The in-memory matcher: compiles a QueryDescription into a
 * `(raw) => boolean` so observers of simple queries can re-check membership
 * without hitting the database (docs/q-dsl-and-one-engine.md, "the one
 * bounded exception").
 *
 * It is deliberately gated: only flat single-table queries qualify
 * (canEncodeMatcher). Everything it accepts MUST behave exactly like the
 * SQL the compiler emits — that agreement is pinned by the matcher
 * conformance suite, which runs the same query corpus through both engines.
 *
 * SQLite semantics replicated here:
 * - `IS` equality: null-safe, strict (no '5' == 5), booleans stored as 0/1.
 * - Ordering: NULL never matches; across storage classes, text sorts above
 *   numbers (SQLite storage-class ordering).
 * - LIKE: case-insensitive for ASCII letters ONLY (SQLite does not
 *   case-fold non-ASCII), `%`/`_` wildcards, backslash escape.
 * - `x NOT IN ()` is true for every x, even null; non-empty NOT IN never
 *   matches null.
 */
import type { SqlValue } from '../driver/SqliteDriver'
import type {
  Comparison,
  NonNullValue,
  QueryDescription,
  Where,
} from '../query/ast'
import type { RawRecord } from '../rawRecord/index'

export type Matcher = (raw: RawRecord) => boolean

export interface EncodeMatcherOptions {
  /** Exclude _status = 'deleted' records, like the SQL compiler (default true). */
  readonly filterDeleted?: boolean
}

/**
 * Whether a query is simple enough for in-memory matching: no joins, no
 * sorting, no pagination, no raw SQL anywhere in the tree.
 */
export function canEncodeMatcher(description: QueryDescription): boolean {
  const hasUnmatchable = (clauses: readonly Where[]): boolean =>
    clauses.some(
      (clause) =>
        clause.type === 'on' ||
        clause.type === 'sqlExpr' ||
        ((clause.type === 'and' || clause.type === 'or') &&
          hasUnmatchable(clause.conditions)),
    )
  return (
    description.joinTables.length === 0 &&
    description.nestedJoinTables.length === 0 &&
    description.sortBy.length === 0 &&
    description.take === undefined &&
    description.skip === undefined &&
    description.sql === undefined &&
    !hasUnmatchable(description.where)
  )
}

export function encodeMatcher(
  description: QueryDescription,
  options: EncodeMatcherOptions = {},
): Matcher {
  if (!canEncodeMatcher(description)) {
    throw new Error(
      'encodeMatcher: query cannot be matched in memory (it has joins, sorting, pagination, or raw SQL)',
    )
  }
  const filterDeleted = options.filterDeleted ?? true
  const matchers = description.where.map(buildWhere)
  return (raw) =>
    (!filterDeleted || raw._status !== 'deleted') &&
    matchers.every((matcher) => matcher(raw))
}

// Storage representation: booleans are 0/1 (the seam-wide convention).
type Normalized = string | number | null

const normalize = (value: SqlValue | undefined): Normalized => {
  if (value === true) {
    return 1
  }
  if (value === false) {
    return 0
  }
  return value ?? null
}

const normalizeNonNull = (value: NonNullValue): string | number =>
  value === true ? 1 : value === false ? 0 : value

// SQLite storage-class ordering: numbers sort below text.
const sqliteGt = (a: string | number, b: string | number): boolean =>
  typeof a === typeof b ? a > b : typeof a === 'string'
const sqliteGte = (a: string | number, b: string | number): boolean =>
  typeof a === typeof b ? a >= b : typeof a === 'string'
const sqliteLt = (a: string | number, b: string | number): boolean =>
  typeof a === typeof b ? a < b : typeof a === 'number'
const sqliteLte = (a: string | number, b: string | number): boolean =>
  typeof a === typeof b ? a <= b : typeof a === 'number'

// SQLite CAST-to-text for LIKE/instr operands.
const asText = (value: string | number): string =>
  typeof value === 'string' ? value : String(value)

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/

// ASCII-only case-insensitivity: [aA] classes instead of the /i flag,
// which would also (wrongly, vs SQLite) case-fold non-ASCII letters.
const literalChar = (ch: string): string => {
  if (/^[a-z]$/.test(ch)) {
    return `[${ch}${ch.toUpperCase()}]`
  }
  if (/^[A-Z]$/.test(ch)) {
    return `[${ch.toLowerCase()}${ch}]`
  }
  return REGEX_SPECIAL.test(ch) ? `\\${ch}` : ch
}

export function likeToRegexp(pattern: string): RegExp {
  let source = '^'
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!
    if (ch === '\\' && i + 1 < pattern.length) {
      source += literalChar(pattern[i + 1]!)
      i++
    } else if (ch === '%') {
      source += '[\\s\\S]*'
    } else if (ch === '_') {
      source += '[\\s\\S]'
    } else {
      source += literalChar(ch)
    }
  }
  return new RegExp(`${source}$`)
}

const buildWhere = (clause: Where): Matcher => {
  switch (clause.type) {
    case 'where':
      return buildComparison(clause.left, clause.comparison)
    case 'and': {
      const matchers = clause.conditions.map(buildWhere)
      return (raw) => matchers.every((matcher) => matcher(raw))
    }
    case 'or': {
      const matchers = clause.conditions.map(buildWhere)
      return (raw) => matchers.some((matcher) => matcher(raw))
    }
    case 'on':
    case 'sqlExpr':
      // unreachable behind canEncodeMatcher; kept for exhaustiveness
      throw new Error(`encodeMatcher: cannot match '${clause.type}' in memory`)
  }
}

const buildComparison = (left: string, comparison: Comparison): Matcher => {
  const { operator, right } = comparison
  const colOf = (raw: RawRecord): Normalized => normalize(raw[left])

  if ('column' in right) {
    const rhsOf = (raw: RawRecord): Normalized => normalize(raw[right.column])
    switch (operator) {
      case 'eq':
        return (raw) => colOf(raw) === rhsOf(raw)
      case 'notEq':
        return (raw) => colOf(raw) !== rhsOf(raw)
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte': {
        const compare = { gt: sqliteGt, gte: sqliteGte, lt: sqliteLt, lte: sqliteLte }[
          operator
        ]
        return (raw) => {
          const a = colOf(raw)
          const b = rhsOf(raw)
          return a !== null && b !== null && compare(a, b)
        }
      }
      default:
        throw new Error(
          `encodeMatcher: operator '${operator}' does not support column comparison`,
        )
    }
  }

  if ('value' in right) {
    const value = normalize(right.value)
    switch (operator) {
      case 'eq':
        return (raw) => colOf(raw) === value
      case 'notEq':
        return (raw) => colOf(raw) !== value
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte': {
        const compare = { gt: sqliteGt, gte: sqliteGte, lt: sqliteLt, lte: sqliteLte }[
          operator
        ]
        return (raw) => {
          const a = colOf(raw)
          return a !== null && value !== null && compare(a, value)
        }
      }
      case 'like':
      case 'notLike': {
        const regexp = likeToRegexp(String(right.value))
        const negate = operator === 'notLike'
        return (raw) => {
          const a = colOf(raw)
          return a !== null && regexp.test(asText(a)) !== negate
        }
      }
      case 'includes': {
        const needle = String(right.value)
        return (raw) => {
          const a = colOf(raw)
          return a !== null && asText(a).includes(needle)
        }
      }
      default:
        throw new Error(
          `encodeMatcher: operator '${operator}' expects a value list`,
        )
    }
  }

  const values = right.values.map(normalizeNonNull)
  switch (operator) {
    case 'between': {
      const lo = values[0]!
      const hi = values[1]!
      return (raw) => {
        const a = colOf(raw)
        return a !== null && sqliteGte(a, lo) && sqliteLte(a, hi)
      }
    }
    case 'oneOf':
      return (raw) => {
        const a = colOf(raw)
        return a !== null && values.includes(a)
      }
    case 'notIn':
      if (values.length === 0) {
        return () => true
      }
      return (raw) => {
        const a = colOf(raw)
        return a !== null && !values.includes(a)
      }
    default:
      throw new Error(
        `encodeMatcher: operator '${operator}' expects a single value`,
      )
  }
}
