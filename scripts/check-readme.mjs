// Executable check for README.md's "taste of the API" block: extracts
// the ```ts block AT RUNTIME and executes it against the built
// workspace packages, so the first code a newcomer reads provably runs.
// Same approach as scripts/check-tutorial.mjs: the markdown is the
// single source; only import specifiers are rewritten (to dist files)
// and assertions are appended.
//
// Run: pnpm build && node scripts/check-readme.mjs
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const MODULES = {
  '@remelondb/core': new URL('../packages/core/dist/index.mjs', import.meta.url)
    .href,
  '@remelondb/core/zod': new URL(
    '../packages/core/dist/zod/index.mjs',
    import.meta.url,
  ).href,
  '@remelondb/driver-node': new URL(
    '../packages/driver-node/dist/index.mjs',
    import.meta.url,
  ).href,
  zod: import.meta.resolve('zod'),
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = MODULES[specifier]
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context)
  },
})

const markdown = await readFile(
  new URL('../README.md', import.meta.url),
  'utf8',
)
const blocks = []
let current = null
for (const line of markdown.split('\n')) {
  if (current === null) {
    if (line.trim() === '```ts') current = []
  } else if (line.trim() === '```') {
    blocks.push(current.join('\n'))
    current = null
  } else {
    current.push(line)
  }
}
if (blocks.length !== 1) {
  throw new Error(`expected exactly one \`\`\`ts block in README, found ${blocks.length}`)
}

const IMPORT_RE = /^import\s*\{([^}]*)\}\s*from\s*'([^']+)'\s*$/
const body = blocks[0]
  .split('\n')
  .map((line) => {
    const match = line.match(IMPORT_RE)
    if (!match) return line
    const url = MODULES[match[2]]
    if (!url) throw new Error(`README imports unknown module '${match[2]}'`)
    return `import {${match[1]}} from '${url}'`
  })
  .join('\n')

const SHIM = `
const __logged = []
{
  const real = console.log.bind(console)
  console.log = (...args) => { __logged.push(args); real(...args) }
}
`

const ASSERTIONS = `
// --- assertions (appended by scripts/check-readme.mjs) ---
await new Promise((r) => setTimeout(r, 30))
const __hit = __logged.find((a) => a[0] === 'open tasks:')
if (!__hit) throw new Error('FAIL: observe never emitted')
if (__hit[1] !== 1) throw new Error('FAIL: expected 1 open task, got ' + __hit[1])
`

const assembled = [
  '// AUTO-ASSEMBLED from README.md — do not edit',
  SHIM,
  body,
  ASSERTIONS,
].join('\n')

const workDir = await mkdtemp(join(tmpdir(), 'remelondb-readme-'))
const file = join(workDir, 'assembled.mjs')
await writeFile(file, assembled)
process.chdir(workDir) // the snippet's 'app.db' lands here, not in the repo
try {
  await import(pathToFileURL(file).href)
} catch (error) {
  console.error(`assembled module kept at ${file} for inspection`)
  throw error
}
process.chdir(tmpdir())
await rm(workDir, { recursive: true, force: true })
console.log('README CHECK: PASS')
