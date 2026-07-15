/**
 * Browser-mode tests: real Chromium (Playwright), real Worker, real OPFS.
 * Run with: pnpm --filter @remelondb/driver-web test:browser
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  optimizeDeps: {
    // sqlite-wasm must not be pre-bundled (wasm asset + worker loading)
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  test: {
    include: ['src/**/*.browser.test.ts'],
    browser: {
      enabled: true,
      provider: 'playwright',
      headless: true,
      screenshotFailures: false,
      instances: [{ browser: 'chromium' }],
    },
  },
})
