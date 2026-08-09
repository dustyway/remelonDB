/**
 * remelonDB#3: a dead worker's SAH pool handles are released by the
 * browser asynchronously. Opening immediately after the holder dies
 * must succeed — the driver owes the caller a bounded retry instead of
 * surfacing NoModificationAllowedError and delegating the timing to a
 * human with a retry button. (The durability test sidesteps this race
 * with hand-tuned sleeps; this test is the race, on purpose.)
 */
import { afterAll, describe, expect, it } from 'vitest'
import { WebSqliteDriver } from './WebSqliteDriver'
import type { Endpoint } from './protocol'

const createWorker = () =>
  new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })

const asEndpoint = (worker: Worker): Endpoint => ({
  postMessage: (message) => worker.postMessage(message),
  addMessageListener: (listener) =>
    worker.addEventListener('message', (event) => listener(event.data)),
})

const workers: Worker[] = []
afterAll(() => workers.forEach((worker) => worker.terminate()))

describe('pool acquisition after a holder dies (remelonDB#3)', () => {
  it('reopens immediately after the holding worker is terminated, no sleep', async () => {
    const name = `pool-race-${Date.now()}.db`

    const worker1 = createWorker()
    workers.push(worker1)
    const driver1 = new WebSqliteDriver({
      createEndpoint: () => asEndpoint(worker1),
    })
    await driver1.open(name)
    await driver1.execute('create table t ("id" primary key)', [])
    worker1.terminate() // dies holding the pool; no release, no sleep

    const worker2 = createWorker()
    workers.push(worker2)
    // takeover models the real sequence: the dead holder's page lock is
    // gone in production (tab closed), here it lingers in the shared
    // test page — takeover clears that layer so the OPFS race is what
    // this test exercises
    const driver2 = new WebSqliteDriver({
      takeover: true,
      createEndpoint: () => asEndpoint(worker2),
    })
    // must absorb the browser's async handle release internally
    await driver2.open(name)
    expect(await driver2.query('select * from t', [])).toEqual([])
    await driver2.destroy()
  }, 30_000)
})
