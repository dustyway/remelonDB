/**
 * Browser-mode tests: real browsers, real Worker, real OPFS.
 * Run with: pnpm --filter @remelondb/driver-web test:browser
 *
 * BROWSER selects the browser (default chromium):
 *   chromium | firefox — stock Playwright
 *   webkit             — Playwright with a persistent context (OPFS needs
 *                        one; see vitest.webkit-provider.ts)
 *   safari             — the real thing via webdriverio + safaridriver
 *                        (macOS only, not headless: Safari can't)
 */
import { defineConfig } from 'vitest/config'

const browser = process.env.BROWSER ?? 'chromium'

if (browser === 'safari') {
  // wdio's default HTTP path hands an undici-6 Agent to Node >= 26's
  // built-in fetch, which rejects it (UND_ERR_INVALID_ARG: invalid
  // onError method). Native-fetch mode skips the custom dispatcher.
  process.env.WDIO_USE_NATIVE_FETCH ??= '1'
}

export default defineConfig({
  optimizeDeps: {
    // sqlite-wasm must not be pre-bundled (wasm asset + worker loading)
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  test: {
    include: ['src/**/*.browser.test.ts'],
    browser: {
      enabled: true,
      provider:
        browser === 'safari'
          ? './vitest.safari-provider.ts'
          : browser === 'webkit'
            ? './vitest.webkit-provider.ts'
            : 'playwright',
      headless: browser !== 'safari',
      screenshotFailures: false,
      instances: [{ browser: browser as 'chromium' }],
    },
  },
})
