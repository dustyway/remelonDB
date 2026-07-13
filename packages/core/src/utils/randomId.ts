const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** 16-character record id, format-compatible with upstream WatermelonDB. */
export function randomId(): string {
  const bytes = new Uint8Array(16)
  // available in Node >= 19, browsers, workers; RN needs a polyfill
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }
  let id = ''
  for (let i = 0; i < bytes.length; i++) {
    id += ALPHABET[bytes[i]! % ALPHABET.length]!
  }
  return id
}
