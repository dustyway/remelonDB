/**
 * Playwright provider variant for WebKit: an ephemeral (default) WebKit
 * context has no OPFS backing store — navigator.storage.getDirectory()
 * throws "UnknownError: ... transient reason" — while a persistent
 * context has full OPFS including sync access handles in workers. So
 * give each session a persistent context in a throwaway profile dir.
 * The base class's close() closes everything in this.contexts.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { playwright } from '@vitest/browser/providers'

const PlaywrightProvider = playwright as unknown as new () => {
  contexts: Map<string, unknown>
  options?: { launch?: Record<string, unknown> }
  project: { config: { browser: { headless: boolean } } }
}

class PersistentWebkitProvider extends PlaywrightProvider {
  name = 'playwright-webkit-persistent'

  async createContext(sessionId: string): Promise<unknown> {
    if (this.contexts.has(sessionId)) return this.contexts.get(sessionId)
    const { webkit } = await import('playwright')
    const profileDir = await mkdtemp(join(tmpdir(), 'wm-webkit-opfs-'))
    const context = await webkit.launchPersistentContext(profileDir, {
      ...this.options?.launch,
      headless: this.project.config.browser.headless,
      ignoreHTTPSErrors: true,
    })
    context.once('close', () => {
      void rm(profileDir, { recursive: true, force: true })
    })
    this.contexts.set(sessionId, context)
    return context
  }
}

export default PersistentWebkitProvider
