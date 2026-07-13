const IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/**
 * Validates a table/column identifier. This is the only line of defense that
 * lets the SQL encoders interpolate identifiers into SQL text — everything
 * that doesn't match the strict pattern is rejected at construction time.
 */
export function ensureName(name: string, kind: 'column' | 'table'): string {
  if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
    throw new Error(
      `Invalid ${kind} name '${String(name)}' — must match ${IDENTIFIER}`,
    )
  }
  return name
}
