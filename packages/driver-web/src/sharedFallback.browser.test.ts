/**
 * The fallback contract (docs/multi-tab.md): where `SharedWorker` is
 * unavailable (Chrome for Android), `{ shared: true }` must reproduce
 * the single-owner behavior exactly — same errors, same takeover
 * semantics, no code branches in the app. Verified by deleting the
 * constructor from this page before any driver is built.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSqliteDriver } from './WebSqliteDriver'

// Simulate Chrome for Android: no SharedWorker constructor. Scoped to
// this file's lifecycle — providers can run files in a shared realm,
// and the other shared-mode suites need the real constructor back.
const realm = globalThis as { SharedWorker?: unknown }
const realSharedWorker = realm.SharedWorker

beforeAll(() => {
  realm.SharedWorker = undefined
})

afterAll(() => {
  realm.SharedWorker = realSharedWorker
})

describe('shared mode fallback without SharedWorker', () => {
  it('reproduces single-owner semantics: fail fast, takeover, notification', async () => {
    const name = `fallback-${Date.now()}.db`
    let aTakenOver = false
    const tabA = new WebSqliteDriver({
      shared: true,
      onTakenOver: () => {
        aTakenOver = true
      },
    })
    await tabA.open(name)
    await tabA.execute('create table t ("id" primary key, "v")', [])
    await tabA.execute('insert into t values (?, ?)', ['k', 'kept'])

    // same-name open fails loudly — the single-owner rule, not sharing
    const tabB = new WebSqliteDriver({ shared: true })
    await expect(tabB.open(name)).rejects.toThrow(/open in another tab/)
    expect(aTakenOver).toBe(false)

    // takeover still works and still notifies the loser
    const tabC = new WebSqliteDriver({ shared: true, takeover: true })
    const { userVersion } = await tabC.open(name)
    expect(userVersion).toBe(0)
    expect(await tabC.query('select "v" from t', [])).toEqual([{ v: 'kept' }])
    expect(aTakenOver).toBe(true)
    await expect(tabA.query('select 1 as one', [])).rejects.toThrow(
      /taken over by another tab/,
    )

    // the coordination seams degrade to no-ops, not errors
    const release = await tabC.acquireWorkSlot(true)
    await release()

    await tabC.destroy() // unlink so reruns start clean
  })
})
