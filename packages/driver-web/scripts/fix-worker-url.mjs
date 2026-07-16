// The source spawns its worker as `new URL('./worker.ts', import.meta.url)`,
// which dev servers resolve against src/. The published build must point at
// the built worker instead — tsdown does not rewrite URL strings.
import { readFileSync, writeFileSync } from 'node:fs'

const path = new URL('../dist/index.mjs', import.meta.url)
const before = readFileSync(path, 'utf8')
const after = before.replaceAll('./worker.ts', './worker.mjs')
if (after === before) {
  throw new Error('fix-worker-url: no ./worker.ts reference found — pattern drifted?')
}
writeFileSync(path, after)
console.log('fix-worker-url: dist/index.mjs now references ./worker.mjs')
