/**
 * The worker server answers one endpoint per tab plus the broker's
 * adopted ports, so several requests can be in flight against a single
 * server at once. `open` is async (the OPFS pool install awaits), so a
 * dispatcher that starts each request on its own promise chain lets a
 * second request run while the first is still parked at that await —
 * two opens then race past the `already open` guard and clobber one
 * pool. These tests pin the contract that the server processes requests
 * in strict arrival order, so an async op fully settles before the next
 * one starts. They fail against an un-serialized dispatcher.
 */
import { describe, expect, it } from 'vitest'
import type { Sqlite3Static } from '@sqlite.org/sqlite-wasm'
import type { Endpoint, WorkerRequest, WorkerResponse } from './protocol'
import { serveSqliteWorker } from './server'

/**
 * A stand-in for sqlite-wasm whose OPFS pool install awaits a real
 * timer — the interleave window a slow WebKit install opens for real.
 * It counts installs so a burst of concurrent first-opens can be caught
 * building the pool more than once.
 */
function makeFakeSqlite3(): { sqlite3: Sqlite3Static; installCalls: () => number } {
  let installs = 0
  class FakeDb {
    constructor(readonly name: string) {}
    selectValue(): number {
      return 0
    }
    close(): void {}
  }
  const poolUtil = {
    OpfsSAHPoolDb: FakeDb,
    getFileNames: (): string[] => [],
    unlink: (): void => {},
  }
  const sqlite3 = {
    installOpfsSAHPoolVfs: async () => {
      installs += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      return poolUtil
    },
    oo1: { DB: FakeDb },
  }
  return {
    sqlite3: sqlite3 as unknown as Sqlite3Static,
    installCalls: () => installs,
  }
}

/**
 * A server wired to an in-process channel (async delivery, like
 * postMessage). `send` posts a request and resolves its response by id.
 */
function serveWith(sqlite3: Sqlite3Static): (request: WorkerRequest) => Promise<WorkerResponse> {
  const serverListeners: Array<(m: unknown) => void> = []
  const pending = new Map<number, (r: WorkerResponse) => void>()
  const clientEndpoint: Endpoint = {
    postMessage: (message) =>
      queueMicrotask(() => serverListeners.forEach((l) => l(message))),
    addMessageListener: () => {},
  }
  const serverEndpoint: Endpoint = {
    postMessage: (message) =>
      queueMicrotask(() => {
        const response = message as WorkerResponse
        pending.get(response.id)?.(response)
        pending.delete(response.id)
      }),
    addMessageListener: (l) => serverListeners.push(l),
  }
  serveSqliteWorker(serverEndpoint, () => Promise.resolve(sqlite3))
  return (request) =>
    new Promise<WorkerResponse>((resolve) => {
      pending.set(request.id, resolve)
      clientEndpoint.postMessage(request)
    })
}

describe('worker server request serialization', () => {
  it('serializes concurrent opens of the same name — exactly one wins', async () => {
    const { sqlite3 } = makeFakeSqlite3()
    const send = serveWith(sqlite3)

    const [a, b] = await Promise.all([
      send({ id: 1, op: 'open', name: 'x.db', storage: 'opfs' }),
      send({ id: 2, op: 'open', name: 'x.db', storage: 'opfs' }),
    ])

    const oks = [a, b].filter((r) => r.ok)
    const errs = [a, b].filter((r) => !r.ok) as Array<
      Extract<WorkerResponse, { ok: false }>
    >
    expect(oks).toHaveLength(1)
    expect(errs).toHaveLength(1)
    const [err] = errs
    if (!err) throw new Error('expected one rejected open')
    expect(err.error).toMatch(/already open/)
  })

  it('installs the OPFS pool once under a burst of concurrent first-opens', async () => {
    const fake = makeFakeSqlite3()
    const send = serveWith(fake.sqlite3)

    await Promise.all(
      Array.from({ length: 5 }, (_unused, i) =>
        send({ id: i + 1, op: 'open', name: `db-${i}.db`, storage: 'opfs' }),
      ),
    )

    expect(fake.installCalls()).toBe(1)
  })
})
