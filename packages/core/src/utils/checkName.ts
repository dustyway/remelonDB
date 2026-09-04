const IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Validates a table/column identifier. This is the only line of defense that
 * lets the SQL encoders interpolate identifiers into SQL text — everything
 * that doesn't match the strict pattern is rejected at construction time.
 */
export function ensureName(name: string, kind: 'column' | 'table'): string {
  if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
    throw new Error(
      // String() rather than plain interpolation: the guard above exists
      // because untyped callers reach here, and a symbol would make a
      // template literal throw a TypeError instead of this message.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion
      `Invalid ${kind} name '${String(name)}' — must match ${IDENTIFIER}`,
    );
  }
  return name;
}
