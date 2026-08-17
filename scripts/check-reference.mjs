// Drift checks for the reference docs' claims that have drifted before,
// or would drift silently. Reference guides track main (see docs/README),
// so each claim is verified against the source it describes rather than
// against a release stamp.
//
// 1. driver.md's SqliteDriver sketch must quote the real interface:
//    the guide once documented an open() parameter that never existed.
// 2. react.md must document every hook the react bridge exports: a new
//    hook (useMutation is planned) must not ship undocumented.
// 3. backend.md's conformance capability table must list exactly the
//    optional capabilities the suite accepts: the table went stale the
//    same afternoon a capability was added.
//
// Run: node scripts/check-reference.mjs

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFile(resolve(root, path), 'utf8')

const failures = []
const check = (ok, message) => {
  if (!ok) failures.push(message)
}
const normalize = (line) => line.trim().replace(/\s+/g, ' ')

// --- 1. driver.md sketch vs SqliteDriver.ts ---
{
  const doc = await read('docs/reference/driver.md')
  const source = await read('packages/core/src/driver/SqliteDriver.ts')
  const sketch = doc.match(/```ts\ninterface SqliteDriver \{([\s\S]*?)\n\}/)
  check(sketch !== null, 'driver.md: SqliteDriver sketch block not found')
  if (sketch) {
    const sourceLines = new Set(source.split('\n').map(normalize))
    for (const line of sketch[1].split('\n').map(normalize)) {
      if (line === '' || line.startsWith('//')) continue
      check(
        sourceLines.has(line),
        `driver.md sketch line not in SqliteDriver.ts: "${line}"`,
      )
    }
  }
}

// --- 2. react.md documents every exported hook ---
{
  const doc = await read('docs/reference/react.md')
  const source = await read('packages/core/src/react/index.ts')
  const exported = [...source.matchAll(/export function (use[A-Z]\w+)/g)].map(
    (m) => m[1],
  )
  check(exported.length > 0, 'react bridge: no exported hooks parsed')
  for (const hook of exported) {
    check(
      new RegExp(`\\b${hook}\\b`).test(doc),
      `react.md does not mention exported hook ${hook}`,
    )
  }
}

// --- 3. backend.md capability table vs conformance options ---
{
  const doc = await read('docs/reference/backend.md')
  const suite = await read('packages/server/src/conformance/index.ts')
  const inSuite = new Set([
    ...[...suite.matchAll(/readonly (\w+)\?:/g)].map((m) => m[1]),
    ...[...suite.matchAll(/(\w+)\?\(\)/g)].map((m) => m[1]),
  ])
  const tableMatch = doc.match(/\| Capability \| Enables \|\n\|[^\n]*\|\n([\s\S]*?)\n\n/)
  check(tableMatch !== null, 'backend.md: capability table not found')
  if (tableMatch) {
    const documented = [...tableMatch[1].matchAll(/^\| `(\w+)`/gm)].map(
      (m) => m[1],
    )
    check(documented.length > 0, 'backend.md: no capability rows parsed')
    for (const name of documented) {
      check(
        inSuite.has(name),
        `backend.md capability table lists unknown capability ${name}`,
      )
    }
    // options-level capabilities must all be in the table (context-level
    // secondUser/concurrently and fixture-level invalidRow included)
    for (const name of [
      'secondUser',
      'concurrently',
      'invalidRow',
      'appendOnly',
      'uniqueColumn',
      'crossValidation',
    ]) {
      check(
        documented.includes(name),
        `backend.md capability table is missing ${name}`,
      )
    }
  }
}

if (failures.length > 0) {
  for (const message of failures) console.error(`  ${message}`)
  console.error(`REFERENCE CHECK: FAIL (${failures.length})`)
  process.exit(1)
}
console.log('REFERENCE CHECK: PASS { driver sketch, react hooks, backend capabilities }')
