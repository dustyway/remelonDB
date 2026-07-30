/**
 * Shared-worker mode (docs/multi-tab.md), opt-in via { shared: true }:
 * every driver routes through one SharedWorker that owns the SQLite
 * worker, so same-name opens from different tabs share one connection
 * instead of contending for it. Two drivers in one page each get their
 * own port to the same SharedWorker instance — the same routing
 * situation as two tabs.
 */
import { describe, expect, it } from 'vitest'
import { WebSqliteDriver } from './WebSqliteDriver'

describe('shared worker mode (opt-in)', () => {
  it('same-name opens share one connection: no lock conflict, both see committed data', async () => {
    const name = `shared-${Date.now()}.db`
    const tabA = new WebSqliteDriver({ shared: true })
    const tabB = new WebSqliteDriver({ shared: true })

    await tabA.open(name)
    await tabA.execute('create table t ("id" primary key, "v")', [])
    await tabA.execute('insert into t values (?, ?)', ['k', 'from-a'])

    // the second open must not conflict — one owner serves both
    const { userVersion } = await tabB.open(name)
    expect(userVersion).toBe(0)
    expect(await tabB.query('select "v" from t', [])).toEqual([{ v: 'from-a' }])

    // writes from either side land on the same connection
    await tabB.execute('insert into t values (?, ?)', ['k2', 'from-b'])
    expect(await tabA.query('select "v" from t where "id" = ?', ['k2'])).toEqual([
      { v: 'from-b' },
    ])

    // interleaved requests resolve to their own callers (id namespacing)
    const [a, b] = await Promise.all([
      tabA.query('select "v" from t where "id" = ?', ['k']),
      tabB.query('select "v" from t where "id" = ?', ['k2']),
    ])
    expect(a).toEqual([{ v: 'from-a' }])
    expect(b).toEqual([{ v: 'from-b' }])

    // refcounted close: first close keeps the connection for the other holder
    await tabA.close()
    expect(await tabB.query('select count(*) as n from t', [])).toEqual([{ n: 2 }])
    await tabB.destroy() // last holder: unlink so reruns start clean

    // Release the SAH pool for the next test file: terminate the hosted
    // compute worker (in a real app it dies with its tab) and give the
    // handles a moment to free — same hygiene as the durability test.
    tabA.hostedComputeWorker?.terminate()
    tabB.hostedComputeWorker?.terminate()
    await new Promise((resolve) => setTimeout(resolve, 100))
  })
})
