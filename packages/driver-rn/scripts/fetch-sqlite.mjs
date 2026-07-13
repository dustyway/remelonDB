/**
 * Downloads the pinned SQLite amalgamation into cpp/vendor/ (not committed
 * to git — ~9 MB of generated C). Both the Android CMake build and the
 * iOS pod compile it from there, so the SQLite version is identical and
 * predictable on every platform.
 *
 * Override with SQLITE_YEAR / SQLITE_VERSION env vars when bumping.
 */
import { execFileSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const YEAR = process.env.SQLITE_YEAR ?? '2025'
const VERSION = process.env.SQLITE_VERSION ?? '3500200' // 3.50.2
const URL = `https://sqlite.org/${YEAR}/sqlite-amalgamation-${VERSION}.zip`

const vendorDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'cpp',
  'vendor',
)

console.log(`Fetching ${URL} …`)
const response = await fetch(URL)
if (!response.ok) {
  console.error(`Download failed: ${response.status} ${response.statusText}`)
  console.error(
    'Set SQLITE_YEAR / SQLITE_VERSION to a valid release, see https://sqlite.org/download.html',
  )
  process.exit(1)
}

const zipPath = path.join(tmpdir(), `sqlite-${VERSION}.zip`)
await writeFile(zipPath, Buffer.from(await response.arrayBuffer()))
await rm(vendorDir, { recursive: true, force: true })
await mkdir(vendorDir, { recursive: true })
try {
  execFileSync('unzip', [
    '-j',
    zipPath,
    '*/sqlite3.c',
    '*/sqlite3.h',
    '-d',
    vendorDir,
  ])
} catch {
  console.error('`unzip` not found — extract sqlite3.c and sqlite3.h from')
  console.error(`${zipPath} into ${vendorDir} manually.`)
  process.exit(1)
}
console.log(`SQLite ${VERSION} extracted to ${vendorDir}`)
