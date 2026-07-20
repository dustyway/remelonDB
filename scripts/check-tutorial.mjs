// Executable check for docs/tutorial.md: extracts the tutorial's ```js
// code blocks AT RUNTIME and executes them, in order, against the built
// workspace packages — the markdown is the single source, so editing the
// tutorial alone is enough to change (or break) this check. Blocks
// fenced ```js fragment are illustrative (the migration re-open sketch,
// the HTTP route wiring) and are skipped; the sync hookup itself runs
// for real against @remelondb/server's memory store.
//
// Transformations applied to the extracted code, and nothing else:
// - import specifiers '@remelondb/*' resolve to the built dist files
//   (imports are also merged, since blocks re-import as the tutorial
//   introduces symbols);
// - a setBadge shim stands in for the app's badge API;
// - the database file lands in a temp directory;
// - assertions are appended so results are checked, not just executed.
//
// Run: pnpm build && node scripts/check-tutorial.mjs
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const MODULES = {
  '@remelondb/core': new URL('../packages/core/dist/index.mjs', import.meta.url)
    .href,
  '@remelondb/driver-node': new URL(
    '../packages/driver-node/dist/index.mjs',
    import.meta.url,
  ).href,
  '@remelondb/server': new URL(
    '../packages/server/dist/index.mjs',
    import.meta.url,
  ).href,
  '@remelondb/core/zod': new URL(
    '../packages/core/dist/zod/index.mjs',
    import.meta.url,
  ).href,
  zod: import.meta.resolve('zod'),
}

// The zod package's built dist imports '@remelondb/core' at runtime, and
// in-workspace that specifier resolves to TS source (dev exports point at
// src/). Redirect every resolution of the mapped modules — whatever the
// importer — to the built files, not just the tutorial's own imports.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = MODULES[specifier]
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context)
  },
})

// --- extract ```js blocks (skip ```js fragment) ---
const markdown = await readFile(
  new URL('../docs/tutorial.md', import.meta.url),
  'utf8',
)
const blocks = []
let fragments = 0
let current = null
for (const line of markdown.split('\n')) {
  if (current === null) {
    if (line.trim() === '```js') current = []
    else if (line.trim() === '```js fragment') fragments++
  } else if (line.trim() === '```') {
    blocks.push(current.join('\n'))
    current = null
  } else {
    current.push(line)
  }
}
if (blocks.length === 0) throw new Error('no ```js blocks found in tutorial')

// --- merge imports, rewrite sources, collect bodies ---
const IMPORT_RE = /^import\s*\{([^}]*)\}\s*from\s*'([^']+)'\s*$/
const specifiersByModule = new Map()
const localNames = new Map() // local name -> full specifier (collision check)
const addSpecifier = (module_, spec) => {
  const url = MODULES[module_]
  if (!url) throw new Error(`tutorial imports unknown module '${module_}'`)
  const set = specifiersByModule.get(url) ?? new Set()
  specifiersByModule.set(url, set)
  const local = spec.includes(' as ') ? spec.split(' as ')[1].trim() : spec
  const existing = localNames.get(local)
  if (existing && existing !== `${module_}:${spec}`) {
    throw new Error(`conflicting imports for local name '${local}'`)
  }
  localNames.set(local, `${module_}:${spec}`)
  set.add(spec)
}
const bodies = blocks.map((block) =>
  block
    .split('\n')
    .filter((line) => {
      const match = line.match(IMPORT_RE)
      if (!match) return true
      for (const spec of match[1].split(',')) {
        const trimmed = spec.trim()
        if (trimmed) addSpecifier(match[2], trimmed)
      }
      return false
    })
    .join('\n'),
)
const imports = [...specifiersByModule]
  .map(([url, specs]) => `import { ${[...specs].join(', ')} } from '${url}'`)
  .join('\n')

const SHIMS = `
const badge = []
const setBadge = (n) => badge.push(n)
`

const ASSERTIONS = `
// --- assertions (appended by scripts/check-tutorial.mjs) ---
const assert = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg) }
assert(clean === true, 'sync left unsynced changes behind')
const echo = await handlers.pull({
  cursor: null, schemaVersion: schema.version, migration: null,
})
assert(echo.changes.decks.updated.length === 1, 'server should hold 1 deck')
assert(echo.changes.cards.updated.length === 5, 'server should hold 5 cards')
assert(echo.changes.reviews.updated.length === 1, 'server should hold 1 review')
assert(dueCards.length === 5, 'dueCards: ' + dueCards.length)
assert(cardsInDeck.length === 5, 'children: ' + cardsInDeck.length)
assert(parent && parent.id === deck.id, 'related returned wrong deck')
assert(deckReviews.length === 1, 'join query: ' + deckReviews.length)
assert(card.due_at > Date.now(), 'update builder did not set due_at')
await new Promise((r) => setTimeout(r, 30))
assert(badge.length >= 1, 'observeCount never fired')
assert(badge[badge.length - 1] === 4, 'badge should end at 4: ' + badge)
assert(migrations.maxVersion === 2, 'migrations object wrong')
unsubscribe()
globalThis.__tutorialCheckPassed = { blocks: ${blocks.length}, badge }
`

const assembled = [
  '// AUTO-ASSEMBLED from docs/tutorial.md — do not edit',
  imports,
  SHIMS,
  ...bodies,
  ASSERTIONS,
].join('\n')

// --- execute in a temp dir ---
const workDir = await mkdtemp(join(tmpdir(), 'remelondb-tutorial-'))
const file = join(workDir, 'assembled.mjs')
await writeFile(file, assembled)
process.chdir(workDir)
try {
  await import(pathToFileURL(file).href)
} catch (error) {
  console.error(`assembled module kept at ${file} for inspection`)
  throw error
}
process.chdir(tmpdir())
await rm(workDir, { recursive: true, force: true })
console.log('TUTORIAL CHECK: PASS', {
  blocksRun: blocks.length,
  fragmentsSkipped: fragments,
  ...globalThis.__tutorialCheckPassed,
})
