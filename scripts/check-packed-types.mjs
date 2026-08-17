// Typechecks the committed fixtures in scripts/fixtures/packed-types
// against the PACKED tarballs' public declarations — what an npm
// consumer's tsc actually sees. The in-repo typecheck resolves
// workspace source, so d.ts-only breakage (a lost overload, a widened
// generic, broken export metadata) is invisible to it; this is the
// check that would have caught the select-inference regression at the
// public boundary.
//
// Run: node scripts/check-packed-types.mjs <tarball-dir>
// (pack first: pnpm -r --filter './packages/*' pack --pack-destination <dir>)
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const tarballDir = process.argv[2]
if (!tarballDir) {
  console.error('usage: node scripts/check-packed-types.mjs <tarball-dir>')
  process.exit(1)
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Only the packages the fixtures import: installing every tarball would
// drag in native/RN peer trees the fixtures never touch.
const WANTED = ['remelondb-core-', 'remelondb-driver-node-', 'remelondb-server-']
const tarballs = readdirSync(tarballDir)
  .filter((f) => f.endsWith('.tgz') && WANTED.some((p) => f.startsWith(p)))
  .map((f) => join(resolve(tarballDir), f))
if (tarballs.length !== WANTED.length) {
  console.error(
    `expected ${WANTED.length} tarballs (${WANTED.join(' ')}), found: ${tarballs.join(', ') || 'none'}`,
  )
  process.exit(1)
}

const dir = mkdtempSync(join(tmpdir(), 'packed-types-'))
try {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'packed-types', private: true }, null, 2),
  )
  // --ignore-scripts: declarations only, no native builds
  const peers = ['typescript@5.8.3', 'react@19', '@types/react@19', 'zod@4']
  execFileSync(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs, ...peers],
    { cwd: dir, stdio: 'inherit' },
  )
  cpSync(join(root, 'scripts/fixtures/packed-types'), dir, { recursive: true })
  execFileSync('npx', ['tsc', '--noEmit', '-p', dir], { cwd: dir, stdio: 'inherit' })
  console.log('PACKED TYPES CHECK: PASS { core, react, zod, server, driver-node }')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
