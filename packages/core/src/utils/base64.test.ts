import { describe, expect, it } from 'vitest';
import { decodeBase64, encodeBase64 } from './base64';

describe('base64', () => {
  it('round-trips canonical vectors without platform globals', () => {
    const vectors = [
      [[], ''],
      [[102], 'Zg=='],
      [[102, 111], 'Zm8='],
      [[102, 111, 111], 'Zm9v'],
      [[0, 127, 255], 'AH//'],
    ] as const;

    for (const [bytes, encoded] of vectors) {
      expect(encodeBase64(new Uint8Array(bytes))).toBe(encoded);
      expect(decodeBase64(encoded)).toEqual(new Uint8Array(bytes));
    }
  });

  it('rejects malformed and non-canonical input', () => {
    for (const value of ['A', 'Zg', 'Z===', 'Zm=v', 'Zm9v\n']) {
      expect(() => decodeBase64(value)).toThrow('Invalid base64');
    }
  });
});
