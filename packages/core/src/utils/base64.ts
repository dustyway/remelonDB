export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function isCanonicalBase64(encoded: string): boolean {
  try {
    return encodeBase64(decodeLenient(encoded)) === encoded;
  } catch {
    return false;
  }
}

export function decodeBase64(encoded: string): Uint8Array {
  if (!isCanonicalBase64(encoded)) {
    throw new Error('Invalid base64 blob value');
  }
  return decodeLenient(encoded);
}

// atob forgives whitespace and missing padding; canonicality is checked
// by re-encoding, so this is only the raw decode.
const decodeLenient = (encoded: string): Uint8Array =>
  Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
