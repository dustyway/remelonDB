/**
 * The Zod adapter (docs/zod-adapter.md): a shared Zod object becomes the
 * single source of truth across a stack. `zodTable` derives a client
 * table definition from it (same output as writing `table()` by hand,
 * including the inferred types); `syncSchemas` builds validators for the
 * sync wire protocol (docs/sync-wire.md) from the same objects — pure
 * Zod, so a server can use them without depending on remelonDB.
 *
 * Supported column vocabulary: `z.string()`, `z.number()`,
 * `z.boolean()`, each optionally `.nullable()` (maps to `.optional()`
 * columns — SQL NULL). Zod's `.optional()` (undefined) is rejected:
 * the value vocabulary has null and no undefined, and conflating them
 * silently is exactly what this package exists to prevent. Refinements
 * (`.min`, `.max`, formats) keep their column type and still validate
 * on the wire. Everything else is a loud error at build time.
 */
import {
  column,
  table,
  type ColumnDef,
  type ColumnsSpec,
  type SyncChanges,
  type TableSchema,
} from '@remelondb/core'
import { z } from 'zod'

// ---- zodTable ----

type ColumnForInner<T> = T extends z.ZodString
  ? 'string'
  : T extends z.ZodNumber
    ? 'number'
    : T extends z.ZodBoolean
      ? 'boolean'
      : never

type ColumnFor<T> = T extends z.ZodNullable<infer Inner>
  ? ColumnForInner<Inner> extends never
    ? never
    : ColumnDef<ColumnForInner<Inner>, true>
  : ColumnForInner<T> extends never
    ? never
    : ColumnDef<ColumnForInner<T>, false>

export type ColumnsFor<Shape extends z.ZodRawShape> = {
  [K in keyof Shape & string]: ColumnFor<Shape[K]>
}

const columnFor = (key: string, field: z.ZodType): ColumnDef => {
  let inner = field
  let nullable = false
  if (inner instanceof z.ZodNullable) {
    nullable = true
    inner = inner.unwrap() as z.ZodType
  }
  if (inner instanceof z.ZodOptional) {
    throw new Error(
      `zodTable: column '${key}' uses .optional() — the value vocabulary has null, not undefined; use .nullable()`,
    )
  }
  const base =
    inner instanceof z.ZodString
      ? column.string()
      : inner instanceof z.ZodNumber
        ? column.number()
        : inner instanceof z.ZodBoolean
          ? column.boolean()
          : null
  if (base === null) {
    throw new Error(
      `zodTable: column '${key}' is ${inner.constructor.name} — supported: z.string(), z.number(), z.boolean(), optionally .nullable()`,
    )
  }
  return nullable ? base.optional() : base
}

export interface ZodTableOptions<Shape extends z.ZodRawShape> {
  /** Columns to index (Zod has no such concept). */
  readonly indexed?: readonly (keyof Shape & string)[]
}

/**
 * Derive a table definition from a Zod object. The result is exactly
 * what `table(name, { ... })` with hand-written builders produces —
 * usable in `appSchema`, `ModelFor`, and `db.get` — and
 * `InferRecord<typeof t>` equals `z.infer<typeof schema> & { id }`.
 */
export function zodTable<Shape extends z.ZodRawShape>(
  name: string,
  schema: z.ZodObject<Shape>,
  options: ZodTableOptions<Shape> = {},
): TableSchema<ColumnsFor<Shape>> {
  const indexed = new Set<string>(options.indexed ?? [])
  for (const indexName of indexed) {
    if (!(indexName in schema.shape)) {
      throw new Error(`zodTable: indexed column '${indexName}' is not in the schema`)
    }
  }
  const spec: Record<string, ColumnDef> = {}
  for (const [key, field] of Object.entries(schema.shape)) {
    const def = columnFor(key, field as z.ZodType)
    spec[key] = indexed.has(key) ? def.indexed() : def
  }
  return table(name, spec as ColumnsSpec) as TableSchema<ColumnsFor<Shape>>
}

// ---- syncSchemas ----

export interface SyncSchemasOptions {
  /** Record id schema (default: non-empty string, per the wire spec). */
  readonly id?: z.ZodType<string>
}

/**
 * Wire validators for the sync protocol, built from the same per-table
 * Zod objects. Row schemas are strict: user columns + id and nothing
 * else, so `_status`/`_changed` (or anything smuggled) fail loudly. The
 * push-result validator enforces the spec's package rule: a cursor and
 * the interleaved changes come together, or both are null.
 */
export function syncSchemas<
  Tables extends Record<string, z.ZodObject<z.ZodRawShape>>,
>(tables: Tables, options: SyncSchemasOptions = {}) {
  const id = options.id ?? z.string().min(1)
  const cursor = z.string().min(1)

  const rows = Object.fromEntries(
    Object.entries(tables).map(([name, schema]) => [
      name,
      z.strictObject({ ...schema.shape, id }),
    ]),
  )
  const changeSets = Object.fromEntries(
    Object.entries(rows).map(([name, row]) => [
      name,
      z.strictObject({
        created: z.array(row),
        updated: z.array(row),
        deleted: z.array(id),
      }),
    ]),
  )
  // `.partial()` infers every table as possibly-undefined, but parse
  // output never contains explicit-undefined entries (absent tables are
  // absent keys), so `SyncChanges` — the type `synchronize` and the
  // server engine take — is the honest static type.
  const changes = z
    .strictObject(changeSets)
    .partial() as unknown as z.ZodType<SyncChanges>

  const migration = z.strictObject({
    from: z.number().int().positive(),
    tables: z.array(z.string()),
    columns: z.array(
      z.strictObject({ table: z.string(), columns: z.array(z.string()) }),
    ),
  })

  const pullArgs = z.strictObject({
    cursor: cursor.nullable(),
    schemaVersion: z.number().int().positive(),
    migration: migration.nullable(),
  })
  const pullResult = z.union([
    z.strictObject({ changes, cursor }),
    z.strictObject({ resyncRequired: z.literal(true) }),
  ])
  const pushArgs = z.strictObject({ changes, cursor })
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
  ])

  return { rows, changes, pullArgs, pullResult, pushArgs, pushResult }
}
