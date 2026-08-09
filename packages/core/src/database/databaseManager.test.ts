/**
 * createDatabaseManager: concurrent inits share one open, failures
 * stay retryable, and a superseded attempt's onTakenOver can never
 * touch a newer database.
 */
import { describe, expect, it, vi } from 'vitest'
import { createDatabaseManager } from '../index'
import type { Database } from '../index'

/** A controllable open factory: resolve/reject per attempt, callbacks captured. */
const fakeOpen = () => {
  const attempts: Array<{
    resolve: (db: Database) => void
    reject: (error: Error) => void
    onTakenOver: () => void
  }> = []
  const open = vi.fn((onTakenOver: () => void) => {
    return new Promise<Database>((resolve, reject) => {
      attempts.push({ resolve, reject, onTakenOver })
    })
  })
  return { open, attempts }
}

const someDb = () => ({}) as Database

describe('createDatabaseManager', () => {
  it('walks idle -> loading -> ready and serves the database', async () => {
    const { open, attempts } = fakeOpen()
    const manager = createDatabaseManager({ open })
    expect(manager.state.status).toBe('idle')
    expect(() => manager.database).toThrow(/not initialized/)

    const states: string[] = []
    manager.subscribe((state) => states.push(state.status))
    expect(states).toEqual(['idle']) // current state emitted on subscribe

    const initPromise = manager.init()
    expect(manager.state.status).toBe('loading')

    const db = someDb()
    attempts[0]!.resolve(db)
    expect(await initPromise).toBe(db)
    expect(manager.state.status).toBe('ready')
    expect(manager.database).toBe(db)
    expect(states).toEqual(['idle', 'loading', 'ready'])
  })

  it('deduplicates concurrent init: one open, shared result', async () => {
    const { open, attempts } = fakeOpen()
    const manager = createDatabaseManager({ open })
    const first = manager.init()
    const second = manager.init() // double-clicked retry, second caller, ...
    expect(open).toHaveBeenCalledTimes(1)

    const db = someDb()
    attempts[0]!.resolve(db)
    expect(await first).toBe(db)
    expect(await second).toBe(db)

    // ready: further init calls return the same database without opening
    expect(await manager.init()).toBe(db)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('a failed open is retryable, not cached forever', async () => {
    const { open, attempts } = fakeOpen()
    const manager = createDatabaseManager({ open })

    const first = manager.init()
    attempts[0]!.reject(new Error('no storage'))
    await expect(first).rejects.toThrow('no storage')
    expect(manager.state.status).toBe('error')
    expect(manager.state.error?.message).toBe('no storage')

    const second = manager.init() // the Retry button
    expect(open).toHaveBeenCalledTimes(2)
    const db = someDb()
    attempts[1]!.resolve(db)
    expect(await second).toBe(db)
    expect(manager.state.status).toBe('ready')
  })

  it('takeover flips the state and revokes the database', async () => {
    const { open, attempts } = fakeOpen()
    const manager = createDatabaseManager({ open })
    const init = manager.init()
    attempts[0]!.resolve(someDb())
    await init

    attempts[0]!.onTakenOver()
    expect(manager.state.status).toBe('taken-over')
    expect(() => manager.database).toThrow(/taken over/)
  })

  it('a stale attempt cannot clobber a healthy database (epoch currency)', async () => {
    const { open, attempts } = fakeOpen()
    const manager = createDatabaseManager({ open })

    // first life: open, get taken over
    const first = manager.init()
    attempts[0]!.resolve(someDb())
    await first
    attempts[0]!.onTakenOver()
    expect(manager.state.status).toBe('taken-over')

    // second life: reclaim ("use here instead")
    const second = manager.init()
    expect(open).toHaveBeenCalledTimes(2)
    const db2 = someDb()
    attempts[1]!.resolve(db2)
    await second
    expect(manager.state.status).toBe('ready')

    // the FIRST life's callback fires late — it must be ignored
    attempts[0]!.onTakenOver()
    expect(manager.state.status).toBe('ready')
    expect(manager.database).toBe(db2)
  })
})

describe('close()', () => {
  const dbWithDriver = () => {
    const close = vi.fn(async () => {})
    return { db: { driver: { close } } as unknown as Database, close }
  }

  it('tears down the open database and returns to idle', async () => {
    const { open, attempts } = fakeOpen()
    const manager = createDatabaseManager({ open })
    const init = manager.init()
    const { db, close } = dbWithDriver()
    attempts[0]!.resolve(db)
    await init

    await manager.close()

    expect(close).toHaveBeenCalledTimes(1)
    expect(manager.state.status).toBe('idle')
    expect(() => manager.database).toThrow(/not initialized/)
  })

  it('discards a late-resolving open with cleanup (the delayed-init race)', async () => {
    const { open, attempts } = fakeOpen()
    const manager = createDatabaseManager({ open })
    const init = manager.init()

    await manager.close() // logout while the open is still in flight
    expect(manager.state.status).toBe('idle')

    const { db, close } = dbWithDriver()
    attempts[0]!.resolve(db) // ...and now it arrives

    await expect(init).rejects.toThrow(/closed/)
    expect(close).toHaveBeenCalledTimes(1) // the late arrival was cleaned up
    expect(manager.state.status).toBe('idle')
    expect(() => manager.database).toThrow(/not initialized/)
  })

  it('a rejection landing after close stays quiet', async () => {
    const { open, attempts } = fakeOpen()
    const manager = createDatabaseManager({ open })
    const init = manager.init()
    await manager.close()
    attempts[0]!.reject(new Error('boom'))
    await expect(init).rejects.toThrow('boom')
    expect(manager.state.status).toBe('idle') // not error: nobody owns it
  })

  it('is idempotent, and a no-op when idle', async () => {
    const { open } = fakeOpen()
    const manager = createDatabaseManager({ open })
    await manager.close()
    await manager.close()
    expect(manager.state.status).toBe('idle')
    expect(open).not.toHaveBeenCalled()
  })

  it('re-init after close opens fresh (re-login)', async () => {
    const { open, attempts } = fakeOpen()
    const manager = createDatabaseManager({ open })
    const first = manager.init()
    const a = dbWithDriver()
    attempts[0]!.resolve(a.db)
    await first
    await manager.close()

    const second = manager.init()
    expect(open).toHaveBeenCalledTimes(2)
    const b = dbWithDriver()
    attempts[1]!.resolve(b.db)
    expect(await second).toBe(b.db)
    expect(manager.database).toBe(b.db)
    expect(manager.state.status).toBe('ready')
  })
})
