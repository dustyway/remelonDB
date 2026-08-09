// The source spawns its workers as `new URL('./worker.ts', import.meta.url)`
// and `new URL('./shared-worker.ts', import.meta.url)`, which dev servers
// resolve against src/. The published build must point at the built files
// instead — tsdown does not rewrite URL strings.
import { readFileSync, writeFileSync } from 'node:fs'

// file -> worker references it must contain (shared-worker listed first:
// plain "worker" would also match inside "shared-worker"). The broker
// spawns worker.ts itself where the scope allows it (remelonDB#4), so
// dist/shared-worker.mjs carries a nested reference of its own.
const FILES = {
  '../dist/index.mjs': ['shared-worker', 'worker'],
  '../dist/shared-worker.mjs': ['worker'],
}

for (const [relative, workers] of Object.entries(FILES)) {
  const path = new URL(relative, import.meta.url)
  const before = readFileSync(path, 'utf8')
  let after = before
  for (const worker of workers) {
    const patched = after.replaceAll(`./${worker}.ts`, `./${worker}.mjs`)
    if (patched === after) {
      throw new Error(
        `fix-worker-url: no ./${worker}.ts reference in ${relative} — pattern drifted?`,
      )
    }
    after = patched
  }
  // any worker added later must be handled above, or the build fails here
  const leftover = after.match(/\.\/[\w-]+\.ts(?=['"], import\.meta\.url)/g)
  if (leftover) {
    throw new Error(
      `fix-worker-url: unhandled worker URLs in ${relative}: ${leftover.join(', ')}`,
    )
  }
  writeFileSync(path, after)
  console.log(`fix-worker-url: ${relative} worker references now point at .mjs`)
}
