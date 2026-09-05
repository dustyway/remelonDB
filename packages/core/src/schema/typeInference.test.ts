/**
 * Type-level pins for docs/schema-inferred-types.md: the three failure
 * modes the design eliminates must stay compile errors, and the inferred
 * shapes must stay exactly right. Runtime assertions here are minimal —
 * the point is that this file typechecks (and the @ts-expect-error lines
 * fail to compile if a regression re-allows them).
 */
import { describe, expect, it } from 'vitest';
import { column as c, table, type InferRecord } from './index';
import * as Q from '../query/Q';
import { ModelFor } from '../model/Model';

const tasks = table('tasks', {
  name: c.string(),
  position: c.number().indexed(),
  is_done: c.boolean(),
  project_id: c.string().optional(),
  attachment: c.blob(),
  thumbnail: c.blob().optional(),
});

type TaskRecord = InferRecord<typeof tasks>;
type BlobIsIndexable = 'indexed' extends keyof ReturnType<typeof c.blob>
  ? true
  : false;

// Compile-time-only helpers
type Equal<A, B> =
  // The two single-use type parameters are the identity trick itself: the
  // conditional types have to be deferred to compare A and B exactly.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
// The parameter is never used at runtime; the constraint is the assertion.
/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters, @typescript-eslint/no-unused-vars */
const assertType = <_T extends true>(): void => undefined;
/* eslint-enable @typescript-eslint/no-unnecessary-type-parameters, @typescript-eslint/no-unused-vars */

const cache = table(
  'media_cache',
  { file_id: c.string().indexed(), bytes: c.blob() },
  { localOnly: true },
);
type CacheRecord = InferRecord<typeof cache>;

describe('schema-inferred types', () => {
  it('infers a local-only table exactly as any other', () => {
    assertType<Equal<CacheRecord['file_id'], string>>();
    assertType<Equal<CacheRecord['bytes'], Uint8Array>>();
    assertType<Equal<CacheRecord['id'], string>>();
    expect(cache.localOnly).toBe(true);
  });

  it('infers exact field types from the table definition', () => {
    assertType<Equal<TaskRecord['name'], string>>();
    assertType<Equal<TaskRecord['position'], number>>();
    assertType<Equal<TaskRecord['is_done'], boolean>>();
    // optional column: | null, not | undefined
    assertType<Equal<TaskRecord['project_id'], string | null>>();
    assertType<Equal<TaskRecord['attachment'], Uint8Array>>();
    assertType<Equal<TaskRecord['thumbnail'], Uint8Array | null>>();
    assertType<Equal<TaskRecord['id'], string>>();
    assertType<Equal<BlobIsIndexable, false>>();
    /* eslint-disable @typescript-eslint/no-unused-vars -- the alias only
       exists so the @ts-expect-error below is checked. */
    // @ts-expect-error — _status is core-internal, not on app-facing records
    type Internal = TaskRecord['_status'];
    /* eslint-enable @typescript-eslint/no-unused-vars */
    expect(tasks.name).toBe('tasks');
  });

  it('model fields come from the schema, not declares', () => {
    class Task extends ModelFor(tasks) {}
    const t = null as unknown as Task;
    assertType<Equal<typeof t.name, string>>();
    assertType<Equal<typeof t.project_id, string | null>>();
    assertType<Equal<typeof t.attachment, Uint8Array>>();
    const use = (): unknown => {
      // @ts-expect-error — misspelled/undeclared fields do not exist
      return t.nmae;
    };
    expect(use).toBeTypeOf('function');
    expect(Task.table).toBe('tasks');
    expect(Task.schema).toBe(tasks);
  });

  it('typed collections reject misspelled Q columns', () => {
    // A stand-in for what db.get(tasks) produces; only types matter here
    type C = import('../database/Collection').Collection<
      TaskRecord,
      import('./index').ColumnName<typeof tasks>
    >;
    const collection = null as unknown as C;
    const use = (): void => {
      collection.query(Q.where('position', Q.gt(1)), Q.sortBy('name'));
      collection.query(Q.where('id', 'x'));
      // @ts-expect-error -- blob columns cannot participate in predicates
      collection.query(Q.where('attachment', 'encoded'));
      // @ts-expect-error -- blob columns cannot participate in sorting
      collection.query(Q.sortBy('attachment'));
      // @ts-expect-error — 'nmae' is not a column of tasks
      collection.query(Q.where('nmae', 'x'));
      // @ts-expect-error — sortBy is checked too
      collection.query(Q.sortBy('positon'));
      // @ts-expect-error — and/or propagate column checking
      collection.query(Q.or(Q.where('name', 'a'), Q.where('nmae', 'b')));
    };
    expect(use).toBeTypeOf('function');
  });
});
