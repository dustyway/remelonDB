const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Fill `bytes` from `crypto.getRandomValues`, the one host capability
 * remelonDB needs that it does not receive through an option.
 *
 * Browsers, workers and Node provide it. React Native does not: Hermes
 * has no WebCrypto, so an app there installs a polyfill before opening a
 * database (docs/reference/runtimes.md). The two failure shapes are
 * distinguished because they need different fixes: the function missing
 * means no polyfill; the function present but throwing means the
 * polyfill's JS half arrived without its native half, which is what an
 * un-rebuilt React Native app looks like.
 */
export function fillRandomValues(bytes: Uint8Array): void {
  const crypto = globalThis.crypto;
  if (typeof crypto?.getRandomValues !== 'function') {
    throw new Error(
      'remelonDB needs crypto.getRandomValues and this runtime has none. ' +
        'React Native provides no WebCrypto: install a polyfill such as ' +
        "'react-native-get-random-values' and import it before opening a " +
        'database.',
    );
  }
  try {
    crypto.getRandomValues(bytes);
  } catch (cause) {
    throw new Error(
      'crypto.getRandomValues is present but failed. On React Native this ' +
        'usually means the polyfill was installed without rebuilding the ' +
        'app, so its native module is missing.',
      { cause },
    );
  }
}

/** 16-character record id, format-compatible with upstream WatermelonDB. */
export function randomId(): string {
  const bytes = new Uint8Array(16);
  fillRandomValues(bytes);
  let id = '';
  for (let i = 0; i < bytes.length; i++) {
    id += ALPHABET[bytes[i]! % ALPHABET.length]!;
  }
  return id;
}
