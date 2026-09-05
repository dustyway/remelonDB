import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  appSchema,
  column as c,
  table,
  type InferRecord,
  type SyncPullArgs,
  type SyncPullResult,
  type SyncPushArgs,
  type SyncPushResult,
} from '../index';
import { syncSchemas, zodTable } from './index';

const Task = z.object({
  name: z.string().min(1).max(120),
  position: z.number().int(),
  is_done: z.boolean(),
  note: z.string().nullable(),
});

const Asset = z.object({
  data: z.instanceof(Uint8Array),
  preview: z.instanceof(Uint8Array).nullable(),
  capped: z
    .instanceof(Uint8Array)
    .refine((value) => value.byteLength <= 2, 'blob exceeds 2 bytes'),
});

type Equal<A, B> =
  // The two single-use type parameters are the identity trick itself: the
  // conditional types have to be deferred to compare A and B exactly.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Extends<A, B> = A extends B ? true : false;
// The parameter is never used at runtime; the constraint is the assertion.
/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters, @typescript-eslint/no-unused-vars */
const assertType = <_T extends true>(): void => undefined;
/* eslint-enable @typescript-eslint/no-unnecessary-type-parameters, @typescript-eslint/no-unused-vars */

describe('zodTable', () => {
  it('produces exactly what hand-written builders produce', () => {
    const derived = zodTable('tasks', Task, { indexed: ['position'] });
    const manual = table('tasks', {
      name: c.string(),
      position: c.number().indexed(),
      is_done: c.boolean(),
      note: c.string().optional(),
    });
    expect(derived).toEqual(manual);
    expect(appSchema({ version: 1, tables: [derived] }).tables['tasks']).toBe(
      derived,
    );
  });

  it('interop contract: InferRecord equals z.infer plus id', () => {
    const derived = zodTable('tasks', Task);
    type Derived = InferRecord<typeof derived>;
    type Expected = { readonly id: string } & {
      name: string;
      position: number;
      is_done: boolean;
      note: string | null;
    };
    assertType<Equal<Derived, Expected>>();
    assertType<Equal<Derived['note'], string | null>>();
    /* eslint-disable @typescript-eslint/no-unused-vars -- the alias only
       exists so the @ts-expect-error below is checked. */
    // @ts-expect-error — columns not in the Zod object do not exist
    type Missing = Derived['nmae'];
    /* eslint-enable @typescript-eslint/no-unused-vars */
    expect(derived.name).toBe('tasks');
  });

  it('keeps refined primitives as their base column type', () => {
    // The deprecated form is the one under test: .email() on a ZodString
    // is a refined primitive, which z.email() is not.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const derived = zodTable('users', z.object({ mail: z.string().email() }));
    expect(derived.columns['mail']).toMatchObject({ type: 'string' });
  });

  it('maps Uint8Array schemas to blob columns', () => {
    const derived = zodTable('assets', Asset);
    const manual = table('assets', {
      data: c.blob(),
      preview: c.blob().optional(),
      capped: c.blob(),
    });
    type Derived = InferRecord<typeof derived>;

    expect(derived).toEqual(manual);
    assertType<Equal<Derived['data'], Uint8Array>>();
    assertType<Equal<Derived['preview'], Uint8Array | null>>();
    expect(() => zodTable('assets', Asset, { indexed: ['data'] })).toThrow(
      /cannot index blob/,
    );
  });

  it('recognizes blob schemas whose refinements reject empty bytes', () => {
    const NonEmptyAsset = z.object({
      data: z
        .instanceof(Uint8Array)
        .refine((value) => value.byteLength > 0, 'blob must not be empty'),
    });

    expect(zodTable('assets', NonEmptyAsset).columns['data']).toMatchObject({
      type: 'blob',
    });
    const row = syncSchemas({ assets: NonEmptyAsset }).rows['assets']!;
    expect(() => row.parse({ id: 'a1', data: '' })).toThrow(
      'blob must not be empty',
    );
    expect(row.parse({ id: 'a1', data: 'AQ==' })).toMatchObject({
      data: new Uint8Array([1]),
    });
  });

  it('does not execute arbitrary custom predicates to identify blobs', () => {
    let calls = 0;
    const custom = z.custom<Uint8Array>(() => {
      calls++;
      return true;
    });

    expect(() => zodTable('assets', z.object({ data: custom }))).toThrow(
      /supported:.*Uint8Array/,
    );
    expect(calls).toBe(0);
  });

  it('rejects the unsupported, loudly and by name', () => {
    expect(() => zodTable('t', z.object({ a: z.string().optional() }))).toThrow(
      /'a' uses \.optional\(\)/,
    );
    expect(() => zodTable('t', z.object({ b: z.date() }))).toThrow(
      /'b' is ZodDate/,
    );
    expect(() =>
      zodTable('t', z.object({ d: z.object({ nested: z.string() }) })),
    ).toThrow(/'d' is ZodObject/);
    expect(() =>
      zodTable('t', z.object({ a: z.string() }), { indexed: ['b' as 'a'] }),
    ).toThrow(/indexed column 'b'/);
    // reserved names go through the same validation as table()
    expect(() => zodTable('t', z.object({ id: z.string() }))).toThrow(
      /reserved/,
    );
  });
});

describe('syncSchemas', () => {
  const wire = syncSchemas({ tasks: Task });
  const row = {
    id: 'r1',
    name: 'a task',
    position: 1,
    is_done: false,
    note: null,
  };
  const changes = { tasks: { created: [row], updated: [], deleted: ['r2'] } };

  it('accepts a valid pull round trip', () => {
    expect(
      wire.pullArgs.parse({ cursor: null, schemaVersion: 1, migration: null }),
    ).toBeTruthy();
    const result: SyncPullResult = wire.pullResult.parse({
      changes,
      cursor: '42',
    });
    expect('changes' in result && result.cursor).toBe('42');
    expect(wire.pullResult.parse({ resyncRequired: true })).toEqual({
      resyncRequired: true,
    });
  });

  it('accepts push results and enforces the cursor+changes package rule', () => {
    const ok: SyncPushResult = wire.pushResult.parse({
      cursor: '43',
      changes,
      rejected: { tasks: ['r9'] },
    });
    expect('cursor' in ok && ok.cursor).toBe('43');
    expect(wire.pushResult.parse({ cursor: null, changes: null })).toBeTruthy();
    expect(wire.pushResult.parse({ conflict: true })).toEqual({
      conflict: true,
    });
    expect(() =>
      wire.pushResult.parse({ cursor: '44', changes: null }),
    ).toThrow();
    expect(() => wire.pushResult.parse({ cursor: null, changes })).toThrow();
  });

  it('wire rows are strict: smuggled bookkeeping and bad values fail', () => {
    expect(() =>
      wire.pullResult.parse({
        changes: {
          tasks: {
            created: [{ ...row, _status: 'synced' }],
            updated: [],
            deleted: [],
          },
        },
        cursor: '1',
      }),
    ).toThrow();
    expect(() =>
      wire.pullResult.parse({
        changes: {
          tasks: {
            created: [{ ...row, position: '1' }],
            updated: [],
            deleted: [],
          },
        },
        cursor: '1',
      }),
    ).toThrow();
    // absent tables are fine (Changes is partial)
    expect(wire.pullResult.parse({ changes: {}, cursor: '1' })).toBeTruthy();
  });

  it('interop contract: parsed wire args feed synchronize and the engine', () => {
    assertType<Extends<z.infer<typeof wire.pullArgs>, SyncPullArgs>>();
    assertType<Extends<z.infer<typeof wire.pushArgs>, SyncPushArgs>>();
    expect(
      wire.pullArgs.parse({ cursor: null, schemaVersion: 1, migration: null }),
    ).toBeTruthy();
  });

  it('honors a custom id schema', () => {
    const uuidWire = syncSchemas({ tasks: Task }, { id: z.uuid() });
    expect(
      () => uuidWire.rows['tasks']!.parse(row), // 'r1' is not a uuid
    ).toThrow();
  });

  it('decodes and encodes blob fields while preserving refinements', () => {
    const assetWire = syncSchemas({ assets: Asset }).rows['assets']!;
    const decoded = assetWire.parse({
      id: 'a1',
      data: 'AH//',
      preview: null,
      capped: 'AQI=',
    });

    expect(decoded).toEqual({
      id: 'a1',
      data: new Uint8Array([0, 127, 255]),
      preview: null,
      capped: new Uint8Array([1, 2]),
    });
    expect(assetWire.encode(decoded)).toEqual({
      id: 'a1',
      data: 'AH//',
      preview: null,
      capped: 'AQI=',
    });
    expect(() =>
      assetWire.parse({
        id: 'a1',
        data: 'not base64',
        preview: null,
        capped: 'AQI=',
      }),
    ).toThrow();
    expect(() =>
      assetWire.parse({
        id: 'a1',
        data: 'AH//',
        preview: null,
        capped: 'AQID',
      }),
    ).toThrow('blob exceeds 2 bytes');
  });
});
