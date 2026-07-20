/**
 * Real-browser verification (Chromium via Playwright): a real Worker
 * spawned from worker.ts, real OPFS SAH-pool storage. Runs the FULL
 * shared conformance suite on OPFS, plus the durability test that Node
 * cannot provide: data surviving worker termination (the page-reload
 * equivalent — a fresh worker re-reads the pool from disk).
 *
 * All drivers share one Worker (the SAH pool takes exclusive file locks,
 * so one pool owner per origin — the documented single-connection model).
 */
import { describe, expect, it } from 'vitest'
import { registerDriverConformance } from '@remelondb/core/conformance'
import type { Endpoint } from './protocol'
import { WebSqliteDriver } from './WebSqliteDriver'

const createWorker = () =>
  new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })

const asEndpoint = (worker: Worker): Endpoint => ({
  postMessage: (message) => worker.postMessage(message),
  addMessageListener: (listener) =>
    worker.addEventListener('message', (event) =>
      listener((event as MessageEvent).data),
    ),
})

// one shared worker for the conformance suite (single pool owner)
const sharedWorker = createWorker()
const sharedEndpoint = asEndpoint(sharedWorker)

let counter = 0

registerDriverConformance({
  name: 'web (sqlite-wasm, real Worker, OPFS)',
  createDriver: () =>
    new WebSqliteDriver({ createEndpoint: () => sharedEndpoint }),
  ephemeralName: () => `ephemeral-${counter++}.db`,
  persistence: { databaseName: () => `persistent-${counter++}.db` },
})

describe('OPFS durability across worker restarts', () => {
  it('data survives terminating the worker (page-reload equivalent)', async () => {
    // the SAH pool takes exclusive locks — release the conformance
    // suite's worker before a fresh one can own the pool
    sharedWorker.terminate()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const name = `durability-${Date.now()}.db`

    const worker1 = createWorker()
    const driver1 = new WebSqliteDriver({
      createEndpoint: () => asEndpoint(worker1),
    })
    await driver1.open(name)
    await driver1.execute('create table t ("id" primary key, "value")', [])
    await driver1.execute('insert into t values (?, ?)', ['k', 'survives'])
    await driver1.setUserVersion(42)
    await driver1.close()
    worker1.terminate() // releases the SAH pool locks
    await new Promise((resolve) => setTimeout(resolve, 100))

    const worker2 = createWorker()
    const driver2 = new WebSqliteDriver({
      createEndpoint: () => asEndpoint(worker2),
    })
    const { userVersion } = await driver2.open(name)
    expect(userVersion).toBe(42)
    expect(await driver2.query('select * from t', [])).toEqual([
      { id: 'k', value: 'survives' },
    ])
    await driver2.destroy() // unlink so reruns start clean
    worker2.terminate()
  })
})

describe('multi-tab coordination (Web Locks)', () => {
  // Two driver instances with their own real Workers contend for the
  // SAH pool exactly like two tabs do; the Web Locks API is
  // origin-scoped, so the coordination is also identical.
  it('fails fast when another holder exists; takeover succeeds and notifies the loser', async () => {
    const name = `tabs-${Date.now()}.db`
    let aTakenOver = false
    const tabA = new WebSqliteDriver({
      onTakenOver: () => {
        aTakenOver = true
      },
    })
    await tabA.open(name)
    await tabA.execute('create table t ("id" primary key, "v")', [])
    await tabA.execute('insert into t values (?, ?)', ['k', 'from-a'])

    // default: the second holder is refused, the first is untouched
    const tabB = new WebSqliteDriver()
    await expect(tabB.open(name)).rejects.toThrow(/open in another tab/)
    expect(await tabA.query('select "v" from t', [])).toEqual([{ v: 'from-a' }])
    expect(aTakenOver).toBe(false)

    // takeover: the new holder wins, sees committed data, loser learns
    const tabC = new WebSqliteDriver({ takeover: true })
    const { userVersion } = await tabC.open(name)
    expect(userVersion).toBe(0)
    expect(await tabC.query('select "v" from t', [])).toEqual([{ v: 'from-a' }])
    expect(aTakenOver).toBe(true)
    await expect(tabA.query('select 1 as one', [])).rejects.toThrow(
      /taken over by another tab/,
    )

    await tabC.destroy() // unlink so reruns start clean
  })
})
