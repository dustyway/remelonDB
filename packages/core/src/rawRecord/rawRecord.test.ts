import { describe, expect, it } from 'vitest'
import { column as c, table } from '../schema/index'
import { nullValue, sanitizedRaw, setRawSanitized } from './index'
import { randomId } from '../utils/randomId'

const tasksTable = table('tasks', {
  name: c.string(),
  position: c.number(),
  is_done: c.boolean(),
  project_id: c.string().optional(),
  rating: c.number().optional(),
})

describe('sanitizedRaw', () => {
  it('passes valid records through unchanged', () => {
    const dirty = {
      id: 'abcdef1234567890',
      _status: 'synced',
      _changed: 'name',
      name: 'hello',
      position: 3.5,
      is_done: true,
      project_id: 'p1',
      rating: null,
    }
    expect(sanitizedRaw(dirty, tasksTable)).toEqual(dirty)
  })

  it('drops unknown keys', () => {
    const raw = sanitizedRaw(
      { id: 'x1', evil: 'payload', __proto__pollution: 1 },
      tasksTable,
    )
    expect('evil' in raw).toBe(false)
    expect('__proto__pollution' in raw).toBe(false)
  })

  it('generates an id when missing or invalid', () => {
    expect(sanitizedRaw({}, tasksTable).id).toMatch(/^[a-z0-9]{16}$/)
    expect(sanitizedRaw({ id: 7 }, tasksTable).id).toMatch(/^[a-z0-9]{16}$/)
    expect(sanitizedRaw({ id: '' }, tasksTable).id).toMatch(/^[a-z0-9]{16}$/)
    expect(sanitizedRaw({ id: 'keep-me_1' }, tasksTable).id).toBe('keep-me_1')
  })

  it('defaults sync fields', () => {
    const raw = sanitizedRaw({ _status: 'exploded', _changed: 42 }, tasksTable)
    expect(raw._status).toBe('created')
    expect(raw._changed).toBe('')
  })

  it('coerces invalid values to per-type defaults', () => {
    const raw = sanitizedRaw(
      { name: 42, position: 'high', is_done: 'yes', project_id: 9, rating: NaN },
      tasksTable,
    )
    expect(raw.name).toBe('')
    expect(raw.position).toBe(0)
    expect(raw.is_done).toBe(false)
    expect(raw.project_id).toBeNull() // optional → null
    expect(raw.rating).toBeNull()
  })

  it('converts stored 0/1 back to booleans (driver round-trip)', () => {
    expect(sanitizedRaw({ is_done: 1 }, tasksTable).is_done).toBe(true)
    expect(sanitizedRaw({ is_done: 0 }, tasksTable).is_done).toBe(false)
    expect(sanitizedRaw({ is_done: 2 }, tasksTable).is_done).toBe(false)
  })

  it('fills absent columns with nullValue defaults', () => {
    const raw = sanitizedRaw({}, tasksTable)
    expect(raw).toMatchObject({
      _status: 'created',
      _changed: '',
      name: '',
      position: 0,
      is_done: false,
      project_id: null,
      rating: null,
    })
  })
})

describe('setRawSanitized', () => {
  it('sanitizes single-column writes', () => {
    const raw = sanitizedRaw({}, tasksTable)
    setRawSanitized(raw, 'new name', tasksTable.columns['name']!)
    expect(raw.name).toBe('new name')
    setRawSanitized(raw, undefined, tasksTable.columns['name']!)
    expect(raw.name).toBe('')
    setRawSanitized(raw, 1, tasksTable.columns['is_done']!)
    expect(raw.is_done).toBe(true)
  })
})

describe('nullValue', () => {
  it('matches the DDL backfill defaults', () => {
    expect(nullValue({ name: 'a', type: 'string' })).toBe('')
    expect(nullValue({ name: 'a', type: 'number' })).toBe(0)
    expect(nullValue({ name: 'a', type: 'boolean' })).toBe(false)
    expect(nullValue({ name: 'a', type: 'string', isOptional: true })).toBeNull()
  })
})

describe('randomId', () => {
  it('generates 16-char lowercase alphanumeric ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, randomId))
    expect(ids.size).toBe(1000)
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]{16}$/)
    }
  })
})
