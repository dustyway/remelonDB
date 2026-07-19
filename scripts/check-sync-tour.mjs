// Executable check for docs/sync-tour.md: extracts the tour's ```json
// blocks AT RUNTIME and replays them, in order, against the example
// server (examples/todo-sync/backend/server.ts) — the markdown is the
// single source, so editing the tour alone is enough to change (or
// break) this check.
//
// Rules:
// - blocks pair positionally: request, then response;
// - ```json fragment blocks are illustrative and skipped;
// - a trailing unpaired request expects HTTP 400 (the validation stop);
// - pulls are recognized by `schemaVersion`, everything else is a push;
// - responses compare as parsed JSON (key order never matters).
//
// Run: node scripts/check-sync-tour.mjs
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const BASE = 'http://localhost:8787'

const doc = await readFile(new URL('../docs/sync-tour.md', import.meta.url), 'utf8')
const blocks = []
let fragments = 0
let current = null
for (const line of doc.split('\n')) {
  if (current === null) {
    if (line.trim() === '```json') current = []
    else if (line.trim() === '```json fragment') fragments++
  } else if (line.trim() === '```') {
    blocks.push(current.join('\n'))
    current = null
  } else {
    current.push(line)
  }
}
if (blocks.length < 2) throw new Error('no json request/response pairs found in the tour')

const parsed = blocks.map((b, i) => {
  try {
    return JSON.parse(b)
  } catch (error) {
    throw new Error(`tour block ${i + 1} is not valid JSON (${error.message}):\n${b}`)
  }
})

const pairs = []
for (let i = 0; i + 1 < parsed.length; i += 2) {
  pairs.push([parsed[i], parsed[i + 1]])
}
const expect400 = parsed.length % 2 === 1 ? parsed[parsed.length - 1] : null

const deepEqual = (a, b) => {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => deepEqual(a[k], b[k]))
}

const up = async () => {
  try {
    await fetch(BASE)
    return true
  } catch {
    return false
  }
}

if (await up()) {
  console.error('port 8787 is already in use — stop whatever holds it first')
  process.exit(1)
}

const backendDir = fileURLToPath(
  new URL('../examples/todo-sync/backend', import.meta.url),
)
const child = spawn('npx', ['tsx', 'server.ts'], {
  cwd: backendDir,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})
let serverOutput = ''
child.stdout.on('data', (d) => (serverOutput += d))
child.stderr.on('data', (d) => (serverOutput += d))

const killServer = (signal) => {
  try {
    process.kill(-child.pid, signal)
  } catch {
    // already gone
  }
}

try {
  for (let i = 0; i < 60 && !(await up()); i++) await sleep(500)
  if (!(await up())) throw new Error(`server did not come up:\n${serverOutput}`)

  const post = async (request) => {
    const op = 'schemaVersion' in request ? 'pull' : 'push'
    return fetch(`${BASE}/sync/${op}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
  }

  for (const [index, [request, expected]] of pairs.entries()) {
    const response = await post(request)
    if (response.status !== 200) {
      throw new Error(`stop ${index + 1}: HTTP ${response.status}, expected 200`)
    }
    const actual = await response.json()
    if (!deepEqual(actual, expected)) {
      throw new Error(
        `stop ${index + 1}: response drifted from the tour.\n` +
          `tour says: ${JSON.stringify(expected)}\n` +
          `server says: ${JSON.stringify(actual)}`,
      )
    }
  }

  if (expect400) {
    const response = await post(expect400)
    if (response.status !== 400) {
      throw new Error(
        `validation stop: HTTP ${response.status}, expected 400`,
      )
    }
  }

  console.log('SYNC TOUR CHECK: PASS', {
    pairs: pairs.length,
    expected400: expect400 ? 1 : 0,
    fragmentsSkipped: fragments,
  })
} catch (error) {
  console.error(String(error.message ?? error))
  process.exitCode = 1
} finally {
  killServer('SIGTERM')
  await sleep(300)
  killServer('SIGKILL')
  process.exit(process.exitCode ?? 0)
}
