import { defineConfig } from 'tsdown'
import pkg from './package.json' with { type: 'json' }

// entry derives from the exports map: add a subpath there and the build
// follows. publishConfig.exports is kept in sync by scripts/sync-exports.mjs
// (checked in CI).
export default defineConfig({
  entry: Object.values(pkg.exports),
  // Dual format: this package's types re-export drizzle-orm's nominal
  // classes, and drizzle ships separate declarations per mode, so a
  // require-mode consumer needs a .d.cts that resolves drizzle in require
  // mode too. ESM-only here means "works at runtime, never type-checks"
  // for CommonJS consumers.
  format: ['esm', 'cjs'],
  dts: true,
})
