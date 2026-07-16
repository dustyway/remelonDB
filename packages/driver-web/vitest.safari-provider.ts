/**
 * webdriverio provider variant for Safari. Safari's WebDriver sessions
 * have no BiDi socket (webSocketUrl stays false), so vitest's viewport
 * plumbing — a BiDi `browsingContext.setViewport` — throws "no Bidi
 * session was established". This only bites in CI: with the local-only
 * vitest UI active, viewports are applied via CSS instead.
 *
 * Registering the provider under a custom name also routes the
 * orchestrator onto its CSS-scaling viewport branch (it special-cases
 * the name "webdriverio"), and the setViewport override below degrades
 * gracefully if anything still reaches it. The conformance suite does
 * not depend on exact viewport dimensions.
 */
import { webdriverio } from '@vitest/browser/providers'

const WebdriverProvider = webdriverio as unknown as new () => {
  setViewport(options: { width: number; height: number }): Promise<void>
}

class SafariWebdriverProvider extends WebdriverProvider {
  name = 'webdriverio-safari'

  override async setViewport(options: { width: number; height: number }): Promise<void> {
    try {
      await super.setViewport(options)
    } catch {
      // non-BiDi Safari: viewport emulation unavailable; run at window size
    }
  }
}

export default SafariWebdriverProvider
