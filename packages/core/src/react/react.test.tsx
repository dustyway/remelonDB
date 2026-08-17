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
  useMutation,
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

    expect(result.current).toEqual({
      data: [],
      isLoading: false,
      error,
      isPreviousData: false,
    })
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
      isPreviousData: false,
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
      isPreviousData: false,
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

describe('useQuery keepPreviousData', () => {
  type Q = ReturnType<typeof fakeQuery<string>>
  const keepHook = (initial: Q) =>
    renderHook(
      ({ q }: { q: Q | null }) =>
        useQuery(q ? q.query : null, { keepPreviousData: true }),
      { initialProps: { q: initial as Q | null } },
    )

  it('default behavior is unchanged: a query change drops to loading', () => {
    const db = fakeDb()
    const qa = fakeQuery<string>(db, 'decks', { where: 'a' })
    const qb = fakeQuery<string>(db, 'decks', { where: 'b' })
    const { result, rerender } = renderHook(({ q }) => useQuery(q), {
      initialProps: { q: qa.query },
    })
    act(() => qa.emit(['a1']))
    rerender({ q: qb.query })
    expect(result.current).toMatchObject({
      data: [],
      isLoading: true,
      isPreviousData: false,
    })
  })

  it('retains the previous rows across a query change until the new query emits', () => {
    const db = fakeDb()
    const qa = fakeQuery<string>(db, 'decks', { where: 'a' })
    const qb = fakeQuery<string>(db, 'decks', { where: 'b' })
    const { result, rerender } = keepHook(qa)
    act(() => qa.emit(['a1', 'a2']))

    rerender({ q: qb })
    // previous rows render; isLoading stays reserved for "nothing renderable"
    expect(result.current).toMatchObject({
      data: ['a1', 'a2'],
      isLoading: false,
      error: null,
      isPreviousData: true,
    })

    act(() => qb.emit(['b1']))
    expect(result.current).toMatchObject({
      data: ['b1'],
      isLoading: false,
      isPreviousData: false,
    })
  })

  it('keeps retention per consumer and never seeds the shared store', () => {
    const db = fakeDb()
    const qa = fakeQuery<string>(db, 'decks', { where: 'a' })
    const qb = fakeQuery<string>(db, 'decks', { where: 'b' })
    const qc1 = fakeQuery<string>(db, 'decks', { where: 'c' })
    const qc2 = fakeQuery<string>(db, 'decks', { where: 'c' })
    const qc3 = fakeQuery<string>(db, 'decks', { where: 'c' })

    const fromA = keepHook(qa)
    const fromB = keepHook(qb)
    act(() => {
      qa.emit(['a1'])
      qb.emit(['b1'])
    })

    // both consumers arrive at the same structural key 'c'
    fromA.rerender({ q: qc1 })
    fromB.rerender({ q: qc2 })
    expect(fromA.result.current.data).toEqual(['a1'])
    expect(fromB.result.current.data).toEqual(['b1'])

    // a third consumer of 'c' without history sees plain loading: the
    // shared store was not seeded by either placeholder
    const fresh = renderHook(() => useQuery(qc3.query))
    expect(fresh.result.current).toMatchObject({ data: [], isLoading: true })

    act(() => qc1.emit(['c1']))
    expect(fromA.result.current.data).toEqual(['c1'])
    expect(fromB.result.current.data).toEqual(['c1'])
    expect(fresh.result.current.data).toEqual(['c1'])
  })

  it('drops retained rows the moment the database object changes', () => {
    const db1 = fakeDb()
    const db2 = fakeDb()
    // the key changes together with the database — the case only the
    // db guard catches (with an unchanged key, key identity would
    // already suppress the previous rows)
    const qa = fakeQuery<string>(db1, 'decks', { where: 'a' })
    const qb = fakeQuery<string>(db2, 'decks', { where: 'b' })
    const { result, rerender } = keepHook(qa)
    act(() => qa.emit(['a1']))

    rerender({ q: qb })
    expect(result.current).toMatchObject({
      data: [],
      isLoading: true,
      isPreviousData: false,
    })
  })

  it('a database switch clears retention even when its db returns later', () => {
    const db1 = fakeDb()
    const db2 = fakeDb()
    const qa = fakeQuery<string>(db1, 'decks', { where: 'a' })
    const qx = fakeQuery<string>(db2, 'decks', { where: 'x' })
    const qb = fakeQuery<string>(db1, 'decks', { where: 'b' })
    const { result, rerender } = keepHook(qa)
    act(() => qa.emit(['a1']))

    rerender({ q: qx }) // the switch itself must clear, not just hide
    rerender({ q: qb }) // back on db1: the old rows must not resurface
    expect(result.current).toMatchObject({
      data: [],
      isLoading: true,
      isPreviousData: false,
    })
  })

  it('shows no previous rows for the same query key on another database', () => {
    const db1 = fakeDb()
    const db2 = fakeDb()
    const qa = fakeQuery<string>(db1, 'decks', { where: 'a' })
    const qb = fakeQuery<string>(db2, 'decks', { where: 'a' })
    const { result, rerender } = keepHook(qa)
    act(() => qa.emit(['a1']))

    rerender({ q: qb })
    expect(result.current).toMatchObject({
      data: [],
      isLoading: true,
      isPreviousData: false,
    })
    // even an error before db2's first delivery must not resurrect them
    act(() => qb.fail(new Error('boom')))
    expect(result.current).toMatchObject({
      data: [],
      isPreviousData: false,
    })
  })

  it('clears retention when the query becomes null', () => {
    const db = fakeDb()
    const qa = fakeQuery<string>(db, 'decks', { where: 'a' })
    const qb = fakeQuery<string>(db, 'decks', { where: 'b' })
    const { result, rerender } = keepHook(qa)
    act(() => qa.emit(['a1']))

    rerender({ q: null })
    expect(result.current).toMatchObject({ data: [], isLoading: false })

    rerender({ q: qb })
    expect(result.current).toMatchObject({
      data: [],
      isLoading: true,
      isPreviousData: false,
    })
  })

  it('surfaces an error from the new query alongside the retained rows', () => {
    const db = fakeDb()
    const qa = fakeQuery<string>(db, 'decks', { where: 'a' })
    const qb = fakeQuery<string>(db, 'decks', { where: 'b' })
    const { result, rerender } = keepHook(qa)
    act(() => qa.emit(['a1']))

    rerender({ q: qb })
    const boom = new Error('boom')
    act(() => qb.fail(boom))
    expect(result.current).toMatchObject({
      data: ['a1'],
      error: boom,
      isLoading: false,
      isPreviousData: true,
    })

    act(() => qb.emit(['b1']))
    expect(result.current).toMatchObject({
      data: ['b1'],
      error: null,
      isPreviousData: false,
    })
  })

  it('an error on the current key is not a previous-data transition', () => {
    const db = fakeDb()
    const qa = fakeQuery<string>(db, 'decks', { where: 'a' })
    const { result } = keepHook(qa)
    act(() => qa.emit(['a1']))
    act(() => qa.fail(new Error('boom')))
    expect(result.current).toMatchObject({
      data: ['a1'],
      isPreviousData: false,
    })
    expect(result.current.error).toBeInstanceOf(Error)
  })

  it('select applies to the retained rows', () => {
    const db = fakeDb()
    const qa = fakeQuery<string>(db, 'decks', { where: 'a' })
    const qb = fakeQuery<string>(db, 'decks', { where: 'b' })
    const { result, rerender } = renderHook(
      ({ q }) =>
        useQuery(q.query, {
          keepPreviousData: true,
          // deliberately unannotated: contextual typing must infer M[]
          select: (rows) => rows.length,
        }),
      { initialProps: { q: qa } },
    )
    act(() => qa.emit(['a1', 'a2']))
    expect(result.current.data).toBe(2)

    rerender({ q: qb })
    expect(result.current).toMatchObject({ data: 2, isPreviousData: true })

    act(() => qb.emit(['b1']))
    expect(result.current).toMatchObject({ data: 1, isPreviousData: false })
  })

  it('works when rendered under StrictMode', () => {
    const db = fakeDb()
    const qa = fakeQuery<string>(db, 'decks', { where: 'a' })
    const qb = fakeQuery<string>(db, 'decks', { where: 'b' })
    const { result, rerender } = renderHook(
      ({ q }: { q: Q }) => useQuery(q.query, { keepPreviousData: true }),
      {
        initialProps: { q: qa },
        wrapper: ({ children }) => createElement(StrictMode, null, children),
      },
    )
    act(() => qa.emit(['a1']))
    rerender({ q: qb })
    expect(result.current).toMatchObject({
      data: ['a1'],
      isPreviousData: true,
    })
    act(() => qb.emit(['b1']))
    expect(result.current).toMatchObject({
      data: ['b1'],
      isPreviousData: false,
    })
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

// ---------------------------------------------------------------------------
// useMutation

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('useMutation', () => {
  it('floating mutate never rejects; failure lands in error state', async () => {
    const boom = new Error('write failed')
    const { result } = renderHook(() =>
      useMutation(async (_title: string) => {
        throw boom
      }),
    )
    act(() => {
      result.current.mutate('a')
    })
    await act(async () => {})
    expect(result.current.error).toBe(boom)
    expect(result.current.isPending).toBe(false)
    expect(result.current.data).toBeUndefined()
  })

  it('tracks pending across the call and stores the result', async () => {
    const gate = deferred<number>()
    const { result } = renderHook(() => useMutation(() => gate.promise))
    expect(result.current.isPending).toBe(false)
    act(() => {
      result.current.mutate()
    })
    expect(result.current.isPending).toBe(true)
    await act(async () => {
      gate.resolve(42)
      await gate.promise
    })
    expect(result.current.isPending).toBe(false)
    expect(result.current.data).toBe(42)
    expect(result.current.error).toBeNull()
  })

  it('mutateAsync resolves with the result and rejects with the original error', async () => {
    const ok = renderHook(() => useMutation(async (n: number) => n * 2))
    await act(async () => {
      await expect(ok.result.current.mutateAsync(21)).resolves.toBe(42)
    })
    expect(ok.result.current.data).toBe(42)

    const boom = new Error('nope')
    const bad = renderHook(() =>
      useMutation(async () => {
        throw boom
      }),
    )
    await act(async () => {
      await expect(bad.result.current.mutateAsync()).rejects.toBe(boom)
    })
    expect(bad.result.current.error).toBe(boom)
  })

  it('latest invocation owns data and error under out-of-order completion', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const gates = [first, second]
    let call = 0
    const { result } = renderHook(() =>
      useMutation(() => gates[call++]!.promise),
    )
    act(() => {
      result.current.mutate()
    })
    act(() => {
      result.current.mutate()
    })
    expect(result.current.isPending).toBe(true)
    // the SECOND (latest) call completes first and takes ownership
    await act(async () => {
      second.resolve('second')
      await second.promise
    })
    expect(result.current.data).toBe('second')
    // the stale first call completes later: pending drains, data untouched
    expect(result.current.isPending).toBe(true)
    await act(async () => {
      first.resolve('first')
      await first.promise
    })
    expect(result.current.isPending).toBe(false)
    expect(result.current.data).toBe('second')
  })

  it('a new invocation clears the previous error', async () => {
    const boom = new Error('first failed')
    let shouldFail = true
    const { result } = renderHook(() =>
      useMutation(async () => {
        if (shouldFail) throw boom
        return 'ok'
      }),
    )
    act(() => {
      result.current.mutate()
    })
    await act(async () => {})
    expect(result.current.error).toBe(boom)

    shouldFail = false
    act(() => {
      result.current.mutate()
    })
    expect(result.current.error).toBeNull()
    await act(async () => {})
    expect(result.current.data).toBe('ok')
  })

  it('reset restores the idle state', async () => {
    const { result } = renderHook(() => useMutation(async () => 'done'))
    await act(async () => {
      await result.current.mutateAsync()
    })
    expect(result.current.data).toBe('done')
    act(() => {
      result.current.reset()
    })
    expect(result.current.data).toBeUndefined()
    expect(result.current.error).toBeNull()
    expect(result.current.isPending).toBe(false)
  })

  it('completion after unmount is inert', async () => {
    const gate = deferred<string>()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result, unmount } = renderHook(() => useMutation(() => gate.promise))
    act(() => {
      result.current.mutate()
    })
    unmount()
    await act(async () => {
      gate.resolve('late')
      await gate.promise
    })
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it('works when rendered under StrictMode', async () => {
    const { result } = renderHook(() => useMutation(async (n: number) => n + 1), {
      wrapper: ({ children }) => createElement(StrictMode, null, children),
    })
    await act(async () => {
      await expect(result.current.mutateAsync(1)).resolves.toBe(2)
    })
    expect(result.current.data).toBe(2)
    expect(result.current.isPending).toBe(false)
  })
})

describe('useMutation hardening', () => {
  it('reset during flight goes idle immediately and the stale settle is fully inert', async () => {
    const gate = deferred<string>()
    const gates = [gate]
    let call = 0
    const { result } = renderHook(() => useMutation(() => gates[call++]!.promise))
    act(() => {
      result.current.mutate()
    })
    expect(result.current.isPending).toBe(true)
    act(() => {
      result.current.reset()
    })
    // idle NOW, not when the abandoned call settles
    expect(result.current.isPending).toBe(false)
    await act(async () => {
      gate.resolve('abandoned')
      await gate.promise
    })
    expect(result.current.data).toBeUndefined()
    expect(result.current.error).toBeNull()
    expect(result.current.isPending).toBe(false)

    // the counter survived the era change: the SAME hook's next call
    // still pends (a stale decrement would have driven the count to -1
    // and this increment to 0, reading as not pending)
    gates.push(deferred<string>())
    act(() => {
      result.current.mutate()
    })
    expect(result.current.isPending).toBe(true)
  })

  it('an older failure cannot overwrite a newer success', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const gates = [first, second]
    let call = 0
    const { result } = renderHook(() =>
      useMutation(() => gates[call++]!.promise),
    )
    act(() => {
      result.current.mutate()
    })
    act(() => {
      result.current.mutate()
    })
    await act(async () => {
      second.resolve('winner')
      await second.promise
    })
    await act(async () => {
      first.reject(new Error('stale failure'))
      await first.promise.catch(() => {})
    })
    expect(result.current.data).toBe('winner')
    expect(result.current.error).toBeNull()
    expect(result.current.isPending).toBe(false)
  })

  it('an older success cannot clear a newer failure', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const gates = [first, second]
    let call = 0
    const boom = new Error('newer failed')
    const { result } = renderHook(() =>
      useMutation(() => gates[call++]!.promise),
    )
    act(() => {
      result.current.mutate()
    })
    act(() => {
      result.current.mutate()
    })
    await act(async () => {
      second.reject(boom)
      await second.promise.catch(() => {})
    })
    expect(result.current.error).toBe(boom)
    await act(async () => {
      first.resolve('stale success')
      await first.promise
    })
    expect(result.current.error).toBe(boom)
    expect(result.current.data).toBeUndefined()
    expect(result.current.isPending).toBe(false)
  })

  it('each mutateAsync caller receives its own resolution regardless of state ownership', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const gates = [first, second]
    let call = 0
    const { result } = renderHook(() =>
      useMutation(() => gates[call++]!.promise),
    )
    let p1!: Promise<string>
    let p2!: Promise<string>
    act(() => {
      p1 = result.current.mutateAsync()
      p2 = result.current.mutateAsync()
    })
    await act(async () => {
      second.resolve('two')
      first.resolve('one')
      await Promise.all([p1, p2])
    })
    // hook state belongs to the latest call, but each caller got its own value
    await expect(p1).resolves.toBe('one')
    await expect(p2).resolves.toBe('two')
    expect(result.current.data).toBe('two')
  })

  it('stable callbacks invoke the newest mutation function after a rerender', async () => {
    // each render's callback captures its own immutable prop, so a stale
    // closure really would return 'v1' — the test fails without fnRef
    const { result, rerender } = renderHook(
      ({ value }: { value: string }) => useMutation(async () => value),
      { initialProps: { value: 'v1' } },
    )
    const firstMutateAsync = result.current.mutateAsync
    rerender({ value: 'v2' })
    expect(result.current.mutateAsync).toBe(firstMutateAsync)
    await act(async () => {
      await expect(firstMutateAsync()).resolves.toBe('v2')
    })
  })
})
