/**
 * Graceful degradation when OPFS is blocked (Firefox private browsing /
 * "never remember history", or blocked site data): getDirectory() throws a
 * SecurityError even over https, so the driver must refuse fast with a typed
 * OpfsUnavailableError — before spawning a worker — so callers can degrade
 * instead of seeing an opaque failure and (in shared mode) a respawn loop.
 */
import { describe, expect, it } from 'vitest'
import { OpfsUnavailableError, WebSqliteDriver, probeOpfs } from './WebSqliteDriver'

const securityError = () => {
  // mirrors the browser: DOMException('…', 'SecurityError')
  const error = new Error('Security error when calling GetDirectory')
  error.name = 'SecurityError'
  return error
}

describe('probeOpfs', () => {
  it('is a no-op where OPFS cannot be probed (no navigator.storage)', async () => {
    await expect(probeOpfs(undefined)).resolves.toBeUndefined()
    await expect(probeOpfs({})).resolves.toBeUndefined()
  })

  it('resolves when getDirectory succeeds', async () => {
    await expect(
      probeOpfs({ getDirectory: () => Promise.resolve({}) }),
    ).resolves.toBeUndefined()
  })

  it('throws a typed OpfsUnavailableError when getDirectory is denied', async () => {
    const cause = securityError()
    await expect(
      probeOpfs({ getDirectory: () => Promise.reject(cause) }),
    ).rejects.toBeInstanceOf(OpfsUnavailableError)
  })

  it('carries the code and the original cause', async () => {
    const cause = securityError()
    const error = await probeOpfs({
      getDirectory: () => Promise.reject(cause),
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OpfsUnavailableError)
    expect((error as OpfsUnavailableError).code).toBe('OPFS_UNAVAILABLE')
    expect((error as { cause?: unknown }).cause).toBe(cause)
  })
})

describe('open() refuses fast when OPFS is blocked', () => {
  it('rejects with OpfsUnavailableError and never spawns a worker', async () => {
    const globalRef = globalThis as { navigator?: unknown }
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', {
      value: { storage: { getDirectory: () => Promise.reject(securityError()) } },
      configurable: true,
      writable: true,
    })
    try {
      // no createEndpoint / no Worker global: if the probe did not run first,
      // open() would blow up trying to construct a worker instead
      const driver = new WebSqliteDriver({ storage: 'opfs' })
      await expect(driver.open('app.db')).rejects.toBeInstanceOf(
        OpfsUnavailableError,
      )
    } finally {
      if (original) {
        Object.defineProperty(globalThis, 'navigator', original)
      } else {
        delete globalRef.navigator
      }
    }
  })
})
