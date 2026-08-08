// @vitest-environment jsdom
/**
 * The react bindings against controllable fakes: lifecycle hooks over a
 * fake manager, query hooks over fake queries with hand-driven emits.
 * The contract under test is the hooks' own: structural subscription
 * keys, shared observations, loading states, teardown.
 */
import { describe, expect, it, vi } from 'vitest'
import { act, render, renderHook } from '@testing-library/react'
import { createElement, StrictMode } from 'react'
import {
  DatabaseProvider,
  useDatabase,
  useDatabaseState,
  useQuery,
  useQueryCount,
  useQueryCountResult,
} from './index'
import type { Database, DatabaseManager, DatabaseManagerState } from '../index'
import type { Query } from '../database/Query'

// ---------------------------------------------------------------------------
// Fakes

const fakeManager = () => {
  let state: DatabaseManagerState = { status: 'idle' } as DatabaseManagerState
  let database: Database | null = null
  const listeners = new Set<(s: DatabaseManagerState) => void>()
  const manager = {
    get state() {
      return state
    },
    get database() {
      if (!database) throw new Error('not initialized')
      return database
    },
    init: async () => undefined as never,
    subscribe(listener: (s: DatabaseManagerState) => void) {
      listeners.add(listener)
      listener(state)
      return () => listeners.delete(listener)
    },
  } as unknown as DatabaseManager
  return {
    manager,
    setReady(db: Database) {
      database = db
      state = { status: 'ready' } as DatabaseManagerState
      for (const l of listeners) l(state)
    },
  }
}

/** A fake database: only object identity matters to the registry. */
const fakeDb = () => ({ tag: 'db' }) as unknown as Database

const fakeQuery = <M,>(db: Database, table: string, description: unknown) => {
  const subscribers = new Set<(records: M[]) => void>()
  const errorSubscribers = new Set<(error: Error) => void>()
  const countSubscribers = new Set<(count: number) => void>()
  const countErrorSubscribers = new Set<(error: Error) => void>()
  const observe = vi.fn((cb: (records: M[]) => void, onError?: (error: Error) => void) => {
    subscribers.add(cb)
    if (onError) errorSubscribers.add(onError)
    return () => {
      subscribers.delete(cb)
      if (onError) errorSubscribers.delete(onError)
    }
  })
  const observeCount = vi.fn((cb: (count: number) => void, onError?: (error: Error) => void) => {
    countSubscribers.add(cb)
    if (onError) countErrorSubscribers.add(onError)
    return () => {
      countSubscribers.delete(cb)
      if (onError) countErrorSubscribers.delete(onError)
    }
  })
  const query = {
    collection: { schema: { name: table }, database: db },
    description,
    observe,
    observeCount,
  } as unknown as Query<M>
  return {
    query,
    observe,
    observeCount,
    emit: (records: M[]) => {
      for (const cb of subscribers) cb(records)
    },
    fail: (error: Error) => {
      for (const cb of errorSubscribers) cb(error)
    },
    emitCount: (count: number) => {
      for (const cb of countSubscribers) cb(count)
    },
    failCount: (error: Error) => {
      for (const cb of countErrorSubscribers) cb(error)
    },
    live: () => subscribers.size,
  }
}

// ---------------------------------------------------------------------------

describe('useDatabaseState / useDatabase', () => {
  it('serves state and database from the provider', () => {
    const { manager, setReady } = fakeManager()
    const wrapper = ({ children }: { children?: React.ReactNode }) =>
      createElement(DatabaseProvider, { manager }, children)

    const { result } = renderHook(
      () => ({ state: useDatabaseState(), db: useDatabase() }),
      { wrapper },
    )
    expect(result.current.state.status).toBe('idle')
    expect(result.current.db).toBeNull()

    const db = fakeDb()
    act(() => setReady(db))
    expect(result.current.state.status).toBe('ready')
    expect(result.current.db).toBe(db)
  })

  it('accepts an explicit manager without a provider', () => {
    const { manager } = fakeManager()
    const { result } = renderHook(() => useDatabaseState(manager))
    expect(result.current.status).toBe('idle')
  })

  it('throws a clear error without manager or provider', () => {
    expect(() => renderHook(() => useDatabaseState())).toThrow(
      /DatabaseProvider/,
    )
  })
})

describe('useQuery', () => {
  it('goes from loading to data as the observation emits', () => {
    const db = fakeDb()
    const q = fakeQuery<string>(db, 'decks', { where: 'a' })
    const { result } = renderHook(() => useQuery(q.query))

    expect(result.current).toMatchObject({ data: [], isLoading: true })
    act(() => q.emit(['spanish']))
    expect(result.current).toMatchObject({ data: ['spanish'], isLoading: false })
  })

  it('is idle without a query', () => {
    const { result } = renderHook(() => useQuery(null))
    expect(result.current).toMatchObject({ data: [], isLoading: false, error: null })
  })

  it('exposes observation failures', () => {
    const db = fakeDb()
    const q = fakeQuery<string>(db, 'decks', { where: 'a' })
    const { result } = renderHook(() => useQuery(q.query))
    const error = new Error('database unavailable')

    act(() => q.fail(error))

    expect(result.current).toEqual({ data: [], isLoading: false, error })
  })

  it('clears the error on the next successful emission', () => {
    const db = fakeDb()
    const q = fakeQuery<string>(db, 'decks', { where: 'a' })
    const { result } = renderHook(() => useQuery(q.query))

    act(() => q.fail(new Error('transient')))
    expect(result.current.error).not.toBeNull()

    act(() => q.emit(['recovered']))
    expect(result.current).toEqual({
      data: ['recovered'],
      isLoading: false,
      error: null,
    })
  })

  it('delivers a failure to every consumer of a shared subscription', () => {
    const db = fakeDb()
    const q1 = fakeQuery<string>(db, 'decks', { where: 'a' })
    const q2 = fakeQuery<string>(db, 'decks', { where: 'a' })

    const { result: a } = renderHook(() => useQuery(q1.query))
    const { result: b } = renderHook(() => useQuery(q2.query))
    expect(q2.observe).not.toHaveBeenCalled()

    const error = new Error('database unavailable')
    act(() => q1.fail(error))
    expect(a.current.error).toBe(error)
    expect(b.current.error).toBe(error)
  })

  it('retains the last successful data after an observation failure', () => {
    const db = fakeDb()
    const q = fakeQuery<string>(db, 'decks', { where: 'a' })
    const { result } = renderHook(() => useQuery(q.query))
    act(() => q.emit(['cached']))
    const error = new Error('temporarily unavailable')

    act(() => q.fail(error))

    expect(result.current).toEqual({
      data: ['cached'],
      isLoading: false,
      error,
    })
  })

  it('ignores structurally equal rebuilds and resubscribes on real change', () => {
    const db = fakeDb()
    const q1 = fakeQuery<string>(db, 'decks', { where: 'a' })
    const { result, rerender } = renderHook(({ q }) => useQuery(q), {
      initialProps: { q: q1.query },
    })
    act(() => q1.emit(['x']))

    // same structure, new instance: the original subscription stays live
    const q2 = fakeQuery<string>(db, 'decks', { where: 'a' })
    rerender({ q: q2.query })
    expect(q2.observe).not.toHaveBeenCalled()
    act(() => q1.emit(['y']))
    expect(result.current.data).toEqual(['y'])

    // different structure: old torn down, new one live
    const q3 = fakeQuery<string>(db, 'decks', { where: 'b' })
    rerender({ q: q3.query })
    expect(q3.observe).toHaveBeenCalledTimes(1)
    expect(q1.live()).toBe(0)
    expect(result.current.isLoading).toBe(true)
  })

  it('shares one observation across components with equal queries', () => {
    const db = fakeDb()
    const q1 = fakeQuery<string>(db, 'decks', { where: 'a' })
    const q2 = fakeQuery<string>(db, 'decks', { where: 'a' })

    const seen: string[][] = []
    const A = () => {
      seen.push(useQuery(q1.query).data)
      return null
    }
    const B = () => {
      seen.push(useQuery(q2.query).data)
      return null
    }
    const { unmount } = render(
      createElement('div', null, createElement(A), createElement(B)),
    )

    expect(q1.observe).toHaveBeenCalledTimes(1)
    expect(q2.observe).not.toHaveBeenCalled()

    act(() => q1.emit(['shared']))
    expect(seen.at(-1)).toEqual(['shared'])

    unmount()
    expect(q1.live()).toBe(0)

    // registry cleaned: a fresh mount subscribes anew
    const q4 = fakeQuery<string>(db, 'decks', { where: 'a' })
    renderHook(() => useQuery(q4.query))
    expect(q4.observe).toHaveBeenCalledTimes(1)
  })

  it('does not restart an observation during the StrictMode effect probe', () => {
    const db = fakeDb()
    const q = fakeQuery<string>(db, 'decks', { where: 'a' })
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(StrictMode, null, children)

    renderHook(() => useQuery(q.query), { wrapper })

    expect(q.observe).toHaveBeenCalledTimes(1)
  })
})

describe('useQuery select', () => {
  it('derives per consumer from one shared subscription', () => {
    const db = fakeDb()
    const q1 = fakeQuery<{ len: number }>(db, 'decks', { where: 'a' })
    const q2 = fakeQuery<{ len: number }>(db, 'decks', { where: 'a' })

    const { result: count } = renderHook(() =>
      useQuery(q1.query, { select: (rows) => rows.length }),
    )
    const { result: first } = renderHook(() =>
      useQuery(q2.query, { select: (rows) => rows[0] ?? null }),
    )

    expect(q1.observe).toHaveBeenCalledTimes(1)
    expect(q2.observe).not.toHaveBeenCalled()

    act(() => q1.emit([{ len: 1 }, { len: 2 }]))
    expect(count.current.data).toBe(2)
    expect(first.current.data).toEqual({ len: 1 })
    expect(count.current.isLoading).toBe(false)
  })

  it('recomputes when a selector captures changed inputs', () => {
    const db = fakeDb()
    const q = fakeQuery<string>(db, 'decks', { where: 'a' })
    const { result, rerender } = renderHook(
      ({ limit }) =>
        useQuery(q.query, { select: (rows) => rows.slice(0, limit) }),
      { initialProps: { limit: 1 } },
    )

    act(() => q.emit(['a', 'b', 'c']))
    expect(result.current.data).toEqual(['a'])

    rerender({ limit: 2 })
    expect(result.current.data).toEqual(['a', 'b'])
    expect(q.observe).toHaveBeenCalledTimes(1)
  })
})

describe('useQueryCount', () => {
  it('follows the count observation and defaults to zero', () => {
    const db = fakeDb()
    const q = fakeQuery<string>(db, 'cards', { due: true })
    const { result } = renderHook(() => useQueryCount(q.query))

    expect(result.current).toBe(0)
    act(() => q.emitCount(7))
    expect(result.current).toBe(7)
    expect(q.observeCount).toHaveBeenCalledTimes(1)
    expect(q.observe).not.toHaveBeenCalled()
  })

  it('offers loading and recoverable error state without changing the number hook', () => {
    const db = fakeDb()
    const q = fakeQuery<string>(db, 'cards', { due: true })
    const { result } = renderHook(() => ({
      count: useQueryCount(q.query),
      result: useQueryCountResult(q.query),
    }))

    expect(result.current).toEqual({
      count: 0,
      result: { data: 0, isLoading: true, error: null },
    })
    act(() => q.emitCount(7))
    const error = new Error('count failed')
    act(() => q.failCount(error))
    expect(result.current).toEqual({
      count: 7,
      result: { data: 7, isLoading: false, error },
    })
    expect(q.observeCount).toHaveBeenCalledTimes(1)
  })
})
