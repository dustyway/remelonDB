const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const CANONICAL =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function isCanonicalBase64(encoded: string): boolean {
  if (encoded.length % 4 !== 0 || !CANONICAL.test(encoded)) return false;
  if (encoded.endsWith('==')) {
    return (ALPHABET.indexOf(encoded[encoded.length - 3] ?? '') & 15) === 0;
  }
  if (encoded.endsWith('=')) {
    return (ALPHABET.indexOf(encoded[encoded.length - 2] ?? '') & 3) === 0;
  }
  return true;
}

export function encodeBase64(bytes: Uint8Array): string {
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += ALPHABET.charAt(first >> 2);
    encoded += ALPHABET.charAt(((first & 3) << 4) | ((second ?? 0) >> 4));
    encoded +=
      second === undefined
        ? '='
        : ALPHABET.charAt(((second & 15) << 2) | ((third ?? 0) >> 6));
    encoded += third === undefined ? '=' : ALPHABET.charAt(third & 63);
  }
  return encoded;
}

export function decodeBase64(encoded: string): Uint8Array {
  if (!isCanonicalBase64(encoded)) {
    throw new Error('Invalid base64 blob value');
  }
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array((encoded.length / 4) * 3 - padding);
  let output = 0;
  for (let index = 0; index < encoded.length; index += 4) {
    const value =
      (ALPHABET.indexOf(encoded[index] ?? '') << 18) |
      (ALPHABET.indexOf(encoded[index + 1] ?? '') << 12) |
      (Math.max(0, ALPHABET.indexOf(encoded[index + 2] ?? '')) << 6) |
      Math.max(0, ALPHABET.indexOf(encoded[index + 3] ?? ''));
    if (output < bytes.length) bytes[output++] = value >> 16;
    if (output < bytes.length) bytes[output++] = value >> 8;
    if (output < bytes.length) bytes[output++] = value;
  }
  return bytes;
}
