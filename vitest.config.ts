import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.{ts,tsx}'],
    // browser-mode tests run separately: pnpm --filter driver-web test:browser
    exclude: ['**/*.browser.test.ts', '**/node_modules/**'],
    // pglite conformance cases take ~2s each and stack up under load; the
    // 5s default made them flake in full-repo runs
    testTimeout: 30_000,
  },
});
