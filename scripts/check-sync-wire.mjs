// Drift check between docs/sync-wire.md §7 (the conformance checklist)
// and packages/server/src/conformance/index.ts (the runnable suite).
// They are the same contract stated twice; the item number is the join
// key. Titles may differ in wording; a number present on one side only
// means the spec promises what the suite never checks, or the suite
// checks what the spec never promised.
//
// Run: node scripts/check-sync-wire.mjs

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const fail = (message) => {
  console.error(`SYNC WIRE CHECK: FAIL: ${message}`)
  process.exit(1)
}

// --- checklist items: numbered lines inside the §7 section ---
const wire = await readFile(resolve(root, 'docs/sync-wire.md'), 'utf8')
const sectionMatch = wire.match(
  /^## \d+\. Conformance checklist$([\s\S]*?)(?=^## )/m,
)
if (!sectionMatch) fail('conformance checklist section not found in sync-wire.md')
const docItems = new Map()
for (const line of sectionMatch[1].split('\n')) {
  const item = line.match(/^(\d+)\.\s+(.*)/)
  if (item) docItems.set(Number(item[1]), item[2].trim())
}
if (docItems.size === 0) fail('no numbered items parsed from the checklist')

// --- suite cases: '<n>. …' string literals passed to it()/case vars ---
const suite = await readFile(
  resolve(root, 'packages/server/src/conformance/index.ts'),
  'utf8',
)
const suiteCases = new Map()
for (const match of suite.matchAll(/(['"])(\d+)\.\s((?:(?!\1)[^\n])+)\1/g)) {
  suiteCases.set(Number(match[2]), match[3].trim())
}
if (suiteCases.size === 0) fail('no numbered case titles parsed from the suite')

// --- compare ---
const missingCases = [...docItems.keys()].filter((n) => !suiteCases.has(n))
const missingItems = [...suiteCases.keys()].filter((n) => !docItems.has(n))
if (missingCases.length > 0) {
  fail(
    `checklist item(s) with no suite case: ${missingCases.join(', ')} ` +
      `(first: "${docItems.get(missingCases[0])}")`,
  )
}
if (missingItems.length > 0) {
  fail(
    `suite case(s) with no checklist item: ${missingItems.join(', ')} ` +
      `(first: "${suiteCases.get(missingItems[0])}")`,
  )
}

// numbering gaps usually mean a renumbering went wrong on both sides
const numbers = [...docItems.keys()].sort((a, b) => a - b)
const gaps = numbers.filter((n, i) => i > 0 && n !== numbers[i - 1] + 1)
if (gaps.length > 0) fail(`checklist numbering has gaps before: ${gaps.join(', ')}`)

console.log(
  `SYNC WIRE CHECK: PASS { items: ${docItems.size}, cases: ${suiteCases.size} }`,
)
