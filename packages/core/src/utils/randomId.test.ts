import { afterEach, describe, expect, it } from 'vitest';
import { fillRandomValues, randomId } from './randomId';

const realCrypto = globalThis.crypto;
const setCrypto = (value: unknown) =>
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true });

afterEach(() => setCrypto(realCrypto));

describe('randomId', () => {
  it('produces 16 characters from the id alphabet', () => {
    expect(randomId()).toMatch(/^[a-z0-9]{16}$/);
  });

  it('does not repeat itself', () => {
    const ids = new Set(Array.from({ length: 500 }, () => randomId()));

    expect(ids.size).toBe(500);
  });
});

describe('fillRandomValues', () => {
  it('names the missing polyfill when the runtime has no crypto', () => {
    // React Native before any polyfill: Hermes ships no WebCrypto.
    setCrypto(undefined);

    expect(() => randomId()).toThrow(/install a polyfill/);
  });

  it('distinguishes a source that exists but fails, keeping the cause', () => {
    // React Native with the polyfill installed but the app not rebuilt:
    // the JS half defines the function, the native half is missing.
    const native = new Error("'RNGetRandomValues' could not be found");
    setCrypto({
      getRandomValues: () => {
        throw native;
      },
    });

    let caught: unknown;
    try {
      fillRandomValues(new Uint8Array(1));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/without rebuilding/);
    expect((caught as Error).cause).toBe(native);
  });
});
