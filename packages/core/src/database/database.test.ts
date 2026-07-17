import { describe, expect, it } from 'vitest'
import { WorkQueue } from './WorkQueue'
import { encodeBatch } from './encodeBatch'
import { appSchema, column as c, table } from '../schema/index'
import { markAsChanged, sanitizedRaw, type RawRecord } from '../rawRecord/index'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('WorkQueue', () => {
  it('runs work strictly in order, one at a time', async () => {
    const queue = new WorkQueue()
    const log: string[] = []
    const first = queue.enqueue(async () => {
      log.push('a start')
      await wait(20)
      log.push('a end')
      return 'a'
    }, true)
    const second = queue.enqueue(async () => {
      log.push('b')
      return 'b'
    }, false)
    expect(await Promise.all([first, second])).toEqual(['a', 'b'])
    expect(log).toEqual(['a start', 'a end', 'b'])
  })

  it('reports writer state only while a writer runs', async () => {
    const queue = new WorkQueue()
    expect(queue.isWriterRunning).toBe(false)
    await queue.enqueue(async () => {
      expect(queue.isWriterRunning).toBe(true)
    }, true)
    await queue.enqueue(async () => {
      expect(queue.isWriterRunning).toBe(false)
    }, false)
    expect(queue.isWriterRunning).toBe(false)
  })

  it('keeps going after a failed item', async () => {
    const queue = new WorkQueue()
    await expect(
      queue.enqueue(async () => {
        throw new Error('boom')
      }, true),
    ).rejects.toThrow('boom')
    expect(await queue.enqueue(async () => 42, false)).toBe(42)
  })
})

describe('encodeBatch', () => {
  const schema = appSchema({
    version: 1,
    tables: [
      table('tasks', {
        name: c.string(),
        is_done: c.boolean(),
      }),
    ],
  })
  const tasksTable = schema.tables['tasks']!
  const raw = (fields: Record<string, unknown>): RawRecord =>
    sanitizedRaw(fields, tasksTable)

  it('encodes creates and groups consecutive identical statements', () => {
    const statements = encodeBatch(
      [
        { type: 'create', table: 'tasks', raw: raw({ id: 't1', name: 'a' }) },
        { type: 'create', table: 'tasks', raw: raw({ id: 't2', name: 'b' }) },
        { type: 'destroyPermanently', table: 'tasks', raw: raw({ id: 't3' }) },
      ],
      schema,
    )
    expect(statements).toEqual([
      [
        'insert into "tasks" ("id", "_changed", "_status", "name", "is_done") values (?, ?, ?, ?, ?)',
        [
          ['t1', '', 'created', 'a', false],
          ['t2', '', 'created', 'b', false],
        ],
      ],
      ['delete from "tasks" where "id" = ?', [['t3']]],
    ])
  })

  it('encodes updates and tombstones', () => {
    const record = raw({ id: 't1', name: 'a', _status: 'synced' })
    const statements = encodeBatch(
      [
        { type: 'update', table: 'tasks', raw: record },
        { type: 'markAsDeleted', table: 'tasks', raw: record },
      ],
      schema,
    )
    expect(statements).toEqual([
      [
        'update "tasks" set "_changed" = ?, "_status" = ?, "name" = ?, "is_done" = ? where "id" = ?',
        [['', 'synced', 'a', false, 't1']],
      ],
      [
        `update "tasks" set "_status" = 'deleted', "_changed" = '' where "id" = ?`,
        [['t1']],
      ],
    ])
  })

  it('rejects unknown tables', () => {
    expect(() =>
      encodeBatch([{ type: 'create', table: 'nope', raw: raw({}) }], schema),
    ).toThrow("unknown table 'nope'")
  })
})

describe('markAsChanged', () => {
  const testTable = table('t', {
    a: c.string(),
    b: c.string(),
  })

  it('accumulates the changed-column set on synced records', () => {
    const raw = sanitizedRaw({ _status: 'synced' }, testTable)
    markAsChanged(raw, 'a')
    expect(raw._status).toBe('updated')
    expect(raw._changed).toBe('a')
    markAsChanged(raw, 'b')
    markAsChanged(raw, 'a') // no duplicates
    expect(raw._changed).toBe('a,b')
  })

  it('leaves created records untracked', () => {
    const raw = sanitizedRaw({}, testTable)
    markAsChanged(raw, 'a')
    expect(raw._status).toBe('created')
    expect(raw._changed).toBe('')
  })
})
