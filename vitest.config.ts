import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.{ts,tsx}'],
    // browser-mode tests run separately: pnpm --filter driver-web test:browser
    exclude: ['**/*.browser.test.ts', '**/node_modules/**'],
  },
})
