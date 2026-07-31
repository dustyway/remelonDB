import { defineConfig } from 'tsdown'
import pkg from './package.json' with { type: 'json' }

// entry derives from the exports map: add a subpath there and the build
// follows. publishConfig.exports is kept in sync by scripts/sync-exports.mjs
// (checked in CI).
export default defineConfig({
  entry: Object.values(pkg.exports),
  dts: true,
})
