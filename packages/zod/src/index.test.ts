import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  appSchema,
  column as c,
  table,
  type InferRecord,
  type SyncPullResult,
  type SyncPushResult,
} from '@remelondb/core'
import { syncSchemas, zodTable } from './index'

const Task = z.object({
  name: z.string().min(1).max(120),
  position: z.number().int(),
  is_done: z.boolean(),
  note: z.string().nullable(),
})

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B
  ? 1
  : 2
  ? true
  : false
const assertType = <_T extends true>(): void => undefined

describe('zodTable', () => {
  it('produces exactly what hand-written builders produce', () => {
    const derived = zodTable('tasks', Task, { indexed: ['position'] })
    const manual = table('tasks', {
      name: c.string(),
      position: c.number().indexed(),
      is_done: c.boolean(),
      note: c.string().optional(),
    })
    expect(derived).toEqual(manual)
    expect(appSchema({ version: 1, tables: [derived] }).tables['tasks']).toBe(derived)
  })

  it('interop contract: InferRecord equals z.infer plus id', () => {
    const derived = zodTable('tasks', Task)
    type Derived = InferRecord<typeof derived>
    type Expected = { readonly id: string } & {
      name: string
      position: number
      is_done: boolean
      note: string | null
    }
    assertType<Equal<Derived, Expected>>()
    assertType<Equal<Derived['note'], string | null>>()
    // @ts-expect-error — columns not in the Zod object do not exist
    type Missing = Derived['nmae']
    expect(derived.name).toBe('tasks')
  })

  it('keeps refined primitives as their base column type', () => {
    const derived = zodTable('users', z.object({ mail: z.string().email() }))
    expect(derived.columns['mail']).toMatchObject({ type: 'string' })
  })

  it('rejects the unsupported, loudly and by name', () => {
    expect(() => zodTable('t', z.object({ a: z.string().optional() }))).toThrow(
      /'a' uses \.optional\(\)/,
    )
    expect(() => zodTable('t', z.object({ b: z.date() }))).toThrow(/'b' is ZodDate/)
    expect(() =>
      zodTable('t', z.object({ d: z.object({ nested: z.string() }) })),
    ).toThrow(/'d' is ZodObject/)
    expect(() =>
      zodTable('t', z.object({ a: z.string() }), { indexed: ['b' as 'a'] }),
    ).toThrow(/indexed column 'b'/)
    // reserved names go through the same validation as table()
    expect(() => zodTable('t', z.object({ id: z.string() }))).toThrow(/reserved/)
  })
})

describe('syncSchemas', () => {
  const wire = syncSchemas({ tasks: Task })
  const row = {
    id: 'r1',
    name: 'a task',
    position: 1,
    is_done: false,
    note: null,
  }
  const changes = { tasks: { created: [row], updated: [], deleted: ['r2'] } }

  it('accepts a valid pull round trip', () => {
    expect(
      wire.pullArgs.parse({ cursor: null, schemaVersion: 1, migration: null }),
    ).toBeTruthy()
    const result: SyncPullResult = wire.pullResult.parse({
      changes,
      cursor: '42',
    }) as SyncPullResult
    expect('changes' in result && result.cursor).toBe('42')
    expect(wire.pullResult.parse({ resyncRequired: true })).toEqual({
      resyncRequired: true,
    })
  })

  it('accepts push results and enforces the cursor+changes package rule', () => {
    const ok: SyncPushResult = wire.pushResult.parse({
      cursor: '43',
      changes,
      rejected: { tasks: ['r9'] },
    }) as SyncPushResult
    expect('cursor' in ok && ok.cursor).toBe('43')
    expect(wire.pushResult.parse({ cursor: null, changes: null })).toBeTruthy()
    expect(wire.pushResult.parse({ conflict: true })).toEqual({ conflict: true })
    expect(() => wire.pushResult.parse({ cursor: '44', changes: null })).toThrow()
    expect(() => wire.pushResult.parse({ cursor: null, changes })).toThrow()
  })

  it('wire rows are strict: smuggled bookkeeping and bad values fail', () => {
    expect(() =>
      wire.pullResult.parse({
        changes: { tasks: { created: [{ ...row, _status: 'synced' }], updated: [], deleted: [] } },
        cursor: '1',
      }),
    ).toThrow()
    expect(() =>
      wire.pullResult.parse({
        changes: { tasks: { created: [{ ...row, position: '1' }], updated: [], deleted: [] } },
        cursor: '1',
      }),
    ).toThrow()
    // absent tables are fine (Changes is partial)
    expect(wire.pullResult.parse({ changes: {}, cursor: '1' })).toBeTruthy()
  })

  it('honors a custom id schema', () => {
    const uuidWire = syncSchemas({ tasks: Task }, { id: z.uuid() })
    expect(() =>
      uuidWire.rows['tasks']!.parse(row), // 'r1' is not a uuid
    ).toThrow()
  })
})
