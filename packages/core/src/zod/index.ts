/**
 * The Zod adapter (docs/zod-adapter.md): a shared Zod object becomes the
 * single source of truth across a stack. `zodTable` derives a client
 * table definition from it (same output as writing `table()` by hand,
 * including the inferred types); `syncSchemas` builds validators for the
 * sync wire protocol (docs/sync-wire.md) from the same objects — pure
 * Zod, so a server can use them without depending on remelonDB.
 *
 * Supported column vocabulary: `z.string()`, `z.number()`, `z.boolean()`,
 * and `z.instanceof(Uint8Array)`, each optionally `.nullable()` (maps to
 * `.optional()` columns — SQL NULL). Zod's `.optional()` is rejected
 * because stored values use null, not undefined. Refinements
 * (`.min`, `.max`, formats) keep their column type and still validate
 * on the wire. Everything else is a loud error at build time.
 */
import {
  column,
  table,
  type BlobColumnDef,
  type ColumnDef,
  type ColumnsSpec,
  type SyncChanges,
  type SyncPullResult,
  type SyncPushResult,
  type TableSchema,
} from '../index';
import { decodeBase64, encodeBase64, isCanonicalBase64 } from '../utils/base64';
import { z } from 'zod';

// ---- zodTable ----

type ColumnForInner<T> = T extends z.ZodString
  ? 'string'
  : T extends z.ZodNumber
    ? 'number'
    : T extends z.ZodBoolean
      ? 'boolean'
      : T extends z.ZodType<infer Output>
        ? Output extends Uint8Array
          ? 'blob'
          : never
        : never;

type DefFor<
  T extends 'string' | 'number' | 'boolean' | 'blob',
  Optional extends boolean,
> = T extends 'blob'
  ? BlobColumnDef<Optional>
  : T extends 'string' | 'number' | 'boolean'
    ? ColumnDef<T, Optional>
    : never;

type ColumnFor<T> =
  T extends z.ZodNullable<infer Inner>
    ? ColumnForInner<Inner> extends never
      ? never
      : DefFor<ColumnForInner<Inner>, true>
    : ColumnForInner<T> extends never
      ? never
      : DefFor<ColumnForInner<T>, false>;

/** @category Adapter */
export type ColumnsFor<Shape extends z.ZodRawShape> = {
  [K in keyof Shape & string]: ColumnFor<Shape[K]>;
};

const isBlobSchema = (schema: z.ZodType): boolean => {
  let current: z.core.$ZodType | undefined = schema;
  while (current) {
    // Refinements clone schemas; instanceof metadata remains on a parent.
    if (current._zod.bag['Class'] === Uint8Array) return true;
    current = current._zod.parent;
  }
  return false;
};

const columnFor = (
  key: string,
  field: z.ZodType,
): ColumnDef | BlobColumnDef => {
  let inner = field;
  let nullable = false;
  if (inner instanceof z.ZodNullable) {
    nullable = true;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- zod types `unwrap()` by its own internals; the instanceof above is what says there is a ZodType inside.
    inner = inner.unwrap() as z.ZodType;
  }
  if (inner instanceof z.ZodOptional) {
    throw new Error(
      `zodTable: column '${key}' uses .optional() — the value vocabulary has null, not undefined; use .nullable()`,
    );
  }
  const base =
    inner instanceof z.ZodString
      ? column.string()
      : inner instanceof z.ZodNumber
        ? column.number()
        : inner instanceof z.ZodBoolean
          ? column.boolean()
          : isBlobSchema(inner)
            ? column.blob()
            : null;
  if (base === null) {
    throw new Error(
      `zodTable: column '${key}' is ${inner.constructor.name} — supported: z.string(), z.number(), z.boolean(), z.instanceof(Uint8Array), optionally .nullable()`,
    );
  }
  return nullable ? base.optional() : base;
};

/** @category Adapter */
export interface ZodTableOptions<Shape extends z.ZodRawShape> {
  /** Columns to index (Zod has no such concept). */
  readonly indexed?: readonly (keyof Shape & string)[];
}

/**
 * Derive a table definition from a Zod object. The result is exactly
 * what `table(name, { ... })` with hand-written builders produces —
 * usable in `appSchema`, `ModelFor`, and `db.get` — and
 * `InferRecord<typeof t>` equals `z.infer<typeof schema> & { id }`.
 *
 * @example
 * ```ts
 * const Todo = z.object({ text: z.string().min(1), done: z.boolean() })
 * const todos = zodTable('todos', Todo, { indexed: ['done'] })
 * const schema = appSchema({ version: 1, tables: [todos] })
 * ```
 * @category Adapter
 */
export function zodTable<Shape extends z.ZodRawShape>(
  name: string,
  schema: z.ZodObject<Shape>,
  options: ZodTableOptions<Shape> = {},
): TableSchema<ColumnsFor<Shape>> {
  const indexed = new Set<string>(options.indexed ?? []);
  for (const indexName of indexed) {
    if (!(indexName in schema.shape)) {
      throw new Error(
        `zodTable: indexed column '${indexName}' is not in the schema`,
      );
    }
  }
  const spec: Record<string, ColumnDef | BlobColumnDef> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- a ZodRawShape's values are ZodTypes; Object.entries loses that.
    const def = columnFor(key, field as z.ZodType);
    if (!indexed.has(key)) {
      spec[key] = def;
      continue;
    }
    if (!('indexed' in def)) {
      throw new Error(`zodTable: cannot index blob column '${key}'`);
    }
    spec[key] = def.indexed();
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- ColumnsFor<Shape> re-states, at the type level, the mapping the loop above just performed.
  return table(name, spec as ColumnsSpec) as TableSchema<ColumnsFor<Shape>>;
}

// ---- syncSchemas ----

/** @category Adapter */
export interface SyncSchemasOptions {
  /** Record id schema (default: non-empty string, per the wire spec). */
  readonly id?: z.ZodType<string>;
}

/**
 * Wire validators for the sync protocol, built from the same per-table
 * Zod objects. Row schemas are strict: user columns + id and nothing
 * else, so `_status`/`_changed` (or anything smuggled) fail loudly. The
 * push-result validator enforces the spec's package rule: a cursor and
 * the interleaved changes come together, or both are null.
 *
 * @example
 * ```ts
 * const wire = syncSchemas({ todos: Todo })
 * // client: validate what the server returned
 * const result = wire.pullResult.parse(await response.json())
 * // server: validate what the client sent
 * const args = wire.pushArgs.parse(requestBody)
 * ```
 * @category Adapter
 */
// The type parameter appears once by design: it constrains the caller's
// table map, and every schema below is built dynamically, so the return
// type is independent of it. Dropping it would change an exported
// signature for no gain.
export function syncSchemas<
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  Tables extends Record<string, z.ZodObject<z.ZodRawShape>>,
>(tables: Tables, options: SyncSchemasOptions = {}) {
  const id = options.id ?? z.string().min(1);
  const cursor = z.string().min(1);

  const wireField = (field: z.ZodType): z.ZodType => {
    if (field instanceof z.ZodNullable) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the instanceof check proves unwrap returns a ZodType.
      return wireField(field.unwrap() as z.ZodType).nullable();
    }
    if (!isBlobSchema(field)) return field;
    const base64 = z
      .string()
      .refine(isCanonicalBase64, 'Invalid base64 blob value');
    return z.codec(base64, field, {
      decode: decodeBase64,
      encode: (value) => {
        if (!(value instanceof Uint8Array)) {
          throw new Error('Expected Uint8Array blob value');
        }
        return encodeBase64(value);
      },
    });
  };

  const rows = Object.fromEntries(
    Object.entries(tables).map(([name, schema]) => [
      name,
      z.strictObject({
        ...Object.fromEntries(
          Object.entries(schema.shape).map(([key, field]) => [
            key,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- ZodRawShape values are ZodTypes; Object.entries erases that.
            wireField(field as z.ZodType),
          ]),
        ),
        id,
      }),
    ]),
  );
  const localRows = Object.fromEntries(
    Object.entries(tables).map(([name, schema]) => [
      name,
      z.strictObject({ ...schema.shape, id }),
    ]),
  );
  const changeSets = Object.fromEntries(
    Object.entries(rows).map(([name, row]) => [
      name,
      z.strictObject({
        created: z.array(row),
        updated: z.array(row),
        deleted: z.array(id),
      }),
    ]),
  );
  // `.partial()` infers every table as possibly-undefined, but parse
  // output never contains explicit-undefined entries (absent tables are
  // absent keys), so `SyncChanges` — the type `synchronize` and the
  // server engine take — is the honest static type.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- per the comment above: parse output never carries explicit-undefined entries.
  const changes = z
    .strictObject(changeSets)
    .partial() as unknown as z.ZodType<SyncChanges>;

  const migration = z.strictObject({
    from: z.number().int().positive(),
    tables: z.array(z.string()),
    columns: z.array(
      z.strictObject({ table: z.string(), columns: z.array(z.string()) }),
    ),
  });

  const pullArgs = z.strictObject({
    cursor: cursor.nullable(),
    schemaVersion: z.number().int().positive(),
    migration: migration.nullable(),
  });
  // Codecs change row representation, but SyncPullResult models row values
  // as unknown in both directions.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const pullResult = z.union([
    z.strictObject({ changes, cursor }),
    z.strictObject({ resyncRequired: z.literal(true) }),
  ]) as unknown as z.ZodType<SyncPullResult, SyncPullResult>;
  const pushArgs = z.strictObject({ changes, cursor });
  // Same story as `changes` for `rejected`: `.optional()` infers
  // `| undefined`, which JSON input can never produce, so the core
  // result type is the honest one (and the one `synchronize` takes).
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- per the comment above: `rejected` is absent or present, never explicitly undefined.
  const pushResult = z.union([
    z
      .strictObject({
        cursor: cursor.nullable(),
        changes: changes.nullable(),
        rejected: z.record(z.string(), z.array(id)).optional(),
      })
      .refine((r) => (r.cursor === null) === (r.changes === null), {
        message: 'cursor and changes are a package: both or neither',
      }),
    z.strictObject({ conflict: z.literal(true) }),
  ]) as unknown as z.ZodType<SyncPushResult, SyncPushResult>;

  return {
    rows,
    localRows,
    changes,
    pullArgs,
    pullResult,
    pushArgs,
    pushResult,
  };
}
