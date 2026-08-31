import { describe, expect, it } from 'vitest';
import { throwIfAborted } from './abort';

/**
 * A signal that carries only what this helper requires. Hermes (React
 * Native) is the runtime that lacks `throwIfAborted`; these objects are
 * built by hand because every runtime the tests run in implements the
 * method, so a real AbortSignal cannot reproduce its absence.
 */
const bareSignal = (aborted: boolean, reason?: unknown): AbortSignal =>
  ({ aborted, ...(reason !== undefined ? { reason } : {}) }) as AbortSignal;

describe('throwIfAborted', () => {
  it('does nothing without a signal', () => {
    expect(() => throwIfAborted(undefined)).not.toThrow();
  });

  it('does nothing while the signal is not aborted', () => {
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
    expect(() => throwIfAborted(bareSignal(false))).not.toThrow();
  });

  it('throws the abort reason itself, not a copy of it', () => {
    const controller = new AbortController();
    const reason = new Error('owner logged out');
    controller.abort(reason);

    expect(caught(() => throwIfAborted(controller.signal))).toBe(reason);
    expect(caught(() => throwIfAborted(bareSignal(true, reason)))).toBe(reason);
  });

  it('throws an AbortError for a signal that carries no reason', () => {
    const error = caught(() => throwIfAborted(bareSignal(true)));

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('AbortError');
  });

  it('checks the flag rather than calling a method the runtime may lack', () => {
    // The regression: `signal?.throwIfAborted()` guards a missing signal,
    // not a missing method, so a signal without one threw TypeError.
    expect(() => throwIfAborted(bareSignal(false))).not.toThrow();
  });
});

function caught(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}
