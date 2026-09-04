import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('randomId with an app-supplied source', () => {
  it('uses the source instead of the ambient crypto', () => {
    const source = vi.fn((bytes: Uint8Array) => bytes.fill(0));
    expect(randomId(source)).toBe('a'.repeat(16));
    expect(source).toHaveBeenCalledTimes(1);
  });

  it('wraps a throwing source in the native-module hint', () => {
    const source = () => {
      throw new Error('missing native module');
    };
    expect(() => randomId(source)).toThrowError(/randomSource passed/);
  });

  it('rejects an async source instead of minting ids from a zeroed buffer', () => {
    const source = ((bytes: Uint8Array) =>
      Promise.resolve(bytes)) as unknown as (bytes: Uint8Array) => Uint8Array;
    expect(() => randomId(source)).toThrowError(/synchronously/);
  });

  it('rejects a source that fills a copy instead of the given array', () => {
    const source = (bytes: Uint8Array) => new Uint8Array(bytes.length).fill(3);
    expect(() => randomId(source)).toThrowError(/return it/);
  });

  it('ignores the ambient crypto entirely when a source is given', () => {
    setCrypto(undefined);
    const source = (bytes: Uint8Array) => bytes.fill(1);
    expect(randomId(source)).toBe('b'.repeat(16));
  });
});

describe('an unbound web-style source', () => {
  it('fails with the bind hint instead of silently misbehaving', () => {
    const unbound = globalThis.crypto.getRandomValues;
    expect(() => randomId(unbound)).toThrowError(/bind/);
  });

  it('works when bound', () => {
    const bound = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    expect(randomId(bound)).toMatch(/^[a-z0-9]{16}$/);
  });
});
