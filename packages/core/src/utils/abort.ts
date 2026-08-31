/**
 * `AbortSignal.prototype.throwIfAborted` is not available in every
 * runtime remelonDB supports. Hermes (React Native) provides an
 * AbortSignal without it, so `signal?.throwIfAborted()` throws a
 * TypeError there rather than checking the flag: the optional chain
 * guards a missing signal, not a missing method.
 *
 * Only `aborted` is required of a signal here. `reason` is used when the
 * runtime carries one, and an AbortError stands in when it does not.
 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason: unknown = signal.reason;
  if (reason !== undefined) throw reason;
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  throw error;
}
