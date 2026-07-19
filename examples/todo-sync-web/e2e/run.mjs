// Boots the example server and the Vite dev server, waits until both
// answer, runs the browser acts, and tears everything down. CI and
// local runs use the same entry point: `pnpm --filter
// example-todo-sync-web e2e`. Fails loudly if the ports are taken —
// a stale server would poison the acts with old data.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { runActs } from './acts.mjs'

const webDir = fileURLToPath(new URL('..', import.meta.url))
const hubDir = fileURLToPath(new URL('../../todo-sync', import.meta.url))

const children = []
const start = (name, command, args, cwd) => {
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  child.output = ''
  child.stdout.on('data', (d) => (child.output += d))
  child.stderr.on('data', (d) => (child.output += d))
  child.on('exit', (code) => {
    if (!child.expectedExit) {
      console.error(`${name} exited early (code ${code}):\n${child.output}`)
      process.exitCode = 1
    }
  })
  child.processName = name
  children.push(child)
  return child
}

const stopAll = async () => {
  for (const child of children) {
    child.expectedExit = true
    child.kill('SIGTERM')
  }
  await sleep(500)
}

const up = async (url) => {
  try {
    await fetch(url)
    return true
  } catch {
    return false
  }
}

const waitFor = async (label, probe) => {
  for (let i = 0; i < 120; i++) {
    if (process.exitCode) throw new Error(`${label}: a process died while waiting`)
    if (await probe()) return
    await sleep(500)
  }
  throw new Error(`${label}: not ready after 60s`)
}

if ((await up('http://localhost:8787')) || (await up('http://localhost:5199'))) {
  console.error('ports 8787/5199 are already in use — stop whatever holds them first')
  process.exit(1)
}

start('server', 'npx', ['tsx', 'server.ts'], hubDir)
start('vite', 'npx', ['vite', '--port', '5199', '--strictPort'], webDir)

try {
  await waitFor('server', () => up('http://localhost:8787'))
  await waitFor('vite', async () => {
    try {
      const body = await (await fetch('http://localhost:5199')).text()
      return body.includes('todo-sync')
    } catch {
      return false
    }
  })

  const fresh = await (
    await fetch('http://localhost:8787/sync/pull', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cursor: null, schemaVersion: 1, migration: null }),
    })
  ).json()
  if (fresh.changes?.todos?.updated?.length !== 0) {
    throw new Error('server is not fresh — refusing to run acts against stale data')
  }

  await runActs('http://localhost:5199/')
  console.log('e2e: all acts passed')
} finally {
  await stopAll()
}
