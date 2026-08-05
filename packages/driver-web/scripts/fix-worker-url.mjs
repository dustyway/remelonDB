// The source spawns its workers as `new URL('./worker.ts', import.meta.url)`
// and `new URL('./shared-worker.ts', import.meta.url)`, which dev servers
// resolve against src/. The published build must point at the built files
// instead — tsdown does not rewrite URL strings.
import { readFileSync, writeFileSync } from 'node:fs'

const path = new URL('../dist/index.mjs', import.meta.url)
const before = readFileSync(path, 'utf8')
let after = before

// shared-worker first: plain "worker" would also match inside "shared-worker"
for (const worker of ['shared-worker', 'worker']) {
  const patched = after.replaceAll(`./${worker}.ts`, `./${worker}.mjs`)
  if (patched === after) {
    throw new Error(`fix-worker-url: no ./${worker}.ts reference found — pattern drifted?`)
  }
  after = patched
}

writeFileSync(path, after)
console.log('fix-worker-url: dist/index.mjs now references ./worker.mjs and ./shared-worker.mjs')
