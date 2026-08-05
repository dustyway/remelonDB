/**
 * A dead broker answers nothing — open() must reject at the deadline
 * with an actionable error instead of hanging (the failure mode of a
 * shared-worker script that never ran). The silent endpoint stands in
 * for any such broker; the deadline is shortened via `openTimeoutMs`.
 */
import { describe, expect, it } from 'vitest'
import { WebSqliteDriver } from './WebSqliteDriver'

describe('shared mode open deadline', () => {
  it('rejects with an actionable error when the broker never answers', async () => {
    const driver = new WebSqliteDriver({
      shared: true,
      openTimeoutMs: 300,
      // a transport that swallows every request
      createEndpoint: () => ({
        postMessage: () => {},
        addMessageListener: () => {},
      }),
    })

    await expect(driver.open(`timeout-${Date.now()}.db`)).rejects.toThrow(
      /did not answer the open request within 300ms.*optimizeDeps/s,
    )
  })

  it('opens normally when the broker answers within the deadline', async () => {
    const driver = new WebSqliteDriver({
      shared: true,
      openTimeoutMs: 5_000,
      storage: 'memory',
    })

    const { userVersion } = await driver.open(`timeout-ok-${Date.now()}.db`)
    expect(typeof userVersion).toBe('number')
    await driver.close()
  })
})
