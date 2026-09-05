import { describe, expect, it } from 'vitest';
import { column as c, table } from '../schema/index';
import { sanitizedRaw } from '../rawRecord/index';
import { areRecordsEqual, stripInternal } from './helpers';

const assets = table('assets', { data: c.blob() });

describe('areRecordsEqual', () => {
  it('compares blob values by bytes', () => {
    const first = sanitizedRaw(
      { id: 'a1', data: new Uint8Array([0, 255]) },
      assets,
    );
    const same = sanitizedRaw(
      { id: 'a1', data: new Uint8Array([0, 255]) },
      assets,
    );
    const different = sanitizedRaw(
      { id: 'a1', data: new Uint8Array([0, 254]) },
      assets,
    );

    expect(areRecordsEqual(first, same)).toBe(true);
    expect(areRecordsEqual(first, different)).toBe(false);
  });
});

describe('stripInternal', () => {
  it('encodes declared blob columns as base64', () => {
    const raw = sanitizedRaw(
      { id: 'a1', data: new Uint8Array([0, 127, 255]) },
      assets,
    );

    expect(stripInternal(raw, assets)).toEqual({ id: 'a1', data: 'AH//' });
  });
});
