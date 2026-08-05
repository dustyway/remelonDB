/**
 * Production-build smoke test: prove the packed tarballs work from a
 * real `vite build` output — worker bundling, the wasm asset, and OPFS
 * persistence — not just through vitest's dev-mode pipeline.
 *
 * What it does: packs core + driver-web (prepack builds dist), scaffolds
 * a minimal Vite app in a temp dir consuming the tarballs the way the
 * root README documents (file: deps + overrides), `vite build`,
 * `vite preview`, then drives headless Chromium at the built app:
 * expects SMOKE PASS with rows=1, reloads, expects rows=2 (OPFS
 * persisted across the reload).
 *
 * Run: pnpm --filter @remelondb/driver-web smoke:vite
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(pkgDir, '../..')
const work = mkdtempSync(join(tmpdir(), 'wm-vite-smoke-'))
const tarballDir = join(work, 'tarballs')
const appDir = join(work, 'app')
mkdirSync(tarballDir)
mkdirSync(appDir)

const mark = (msg) => console.log(`# [${new Date().toISOString().slice(11, 19)}] ${msg}`)
const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], ...opts })

mark('packing core and driver-web (prepack builds dist)')
sh('pnpm', ['--filter', '@remelondb/core', 'pack', '--pack-destination', tarballDir], { cwd: repoRoot })
sh('pnpm', ['--filter', '@remelondb/driver-web', 'pack', '--pack-destination', tarballDir], { cwd: repoRoot })
const tgz = (name) => join(tarballDir, readdirSync(tarballDir).find((f) => f.startsWith(name)))
const coreTgz = tgz('remelondb-core-')
const webTgz = tgz('remelondb-driver-web-')

mark('scaffolding the Vite app in ' + appDir)
writeFileSync(
  join(appDir, 'package.json'),
  JSON.stringify(
    {
      name: 'wm-vite-smoke',
      private: true,
      type: 'module',
      dependencies: {
        '@remelondb/core': `file:${coreTgz}`,
        '@remelondb/driver-web': `file:${webTgz}`,
      },
      devDependencies: { vite: '^7' },
      overrides: { '@remelondb/core': `file:${coreTgz}` },
    },
    null,
    2,
  ),
)
writeFileSync(
  join(appDir, 'index.html'),
  `<!doctype html>
<html>
  <body>
    <div id="result">RUNNING</div>
    <script type="module" src="/main.js"></script>
  </body>
</html>
`,
)
writeFileSync(
  join(appDir, 'main.js'),
  `import { appSchema, column as c, table, Database, ModelFor, Q } from '@remelondb/core'
import { WebSqliteDriver } from '@remelondb/driver-web'

const tasks = table('tasks', { name: c.string() })
const schema = appSchema({ version: 1, tables: [tasks] })

class Task extends ModelFor(tasks) {}

const el = document.getElementById('result')
const sharedMode = new URLSearchParams(location.search).get('shared') === '1'
try {
  const db = await Database.open({
    driver: new WebSqliteDriver(
      sharedMode ? { shared: true, takeover: true } : {},
    ), // storage: 'opfs' — the point of the test
    schema,
    modelClasses: [Task],
    name: sharedMode ? 'vite-smoke-shared.db' : 'vite-smoke.db',
  })
  await db.write(() => db.get(Task).create({ name: 'from production build' }))
  const query = db.get(Task).query(Q.where('name', 'from production build'))
  if (sharedMode) {
    // live observation: other tabs' writes must arrive via the broker
    query.observe((records) => {
      el.textContent = 'SHARED rows=' + records.length
    })
  } else {
    const rows = await query.fetch()
    el.textContent = 'SMOKE PASS rows=' + rows.length
  }
} catch (e) {
  el.textContent = 'SMOKE FAIL: ' + e
}
`,
)

writeFileSync(
  join(appDir, 'vite.config.js'),
  `export default {
  // the documented consumer config (driver README, Bundlers section):
  // dev prebundling would relocate the worker URLs into .vite/deps
  optimizeDeps: {
    exclude: ['@remelondb/driver-web', '@remelondb/core', '@sqlite.org/sqlite-wasm'],
  },
}
`,
)

mark('npm install')
sh('npm', ['install', '--no-audit', '--no-fund'], { cwd: appDir })
mark('vite build')
sh('npx', ['vite', 'build'], { cwd: appDir })

mark('vite preview + headless Chromium')
const preview = spawn('npx', ['vite', 'preview', '--port', '4174', '--strictPort'], {
  cwd: appDir,
  stdio: ['ignore', 'pipe', 'inherit'],
})
try {
  await new Promise((resolvePort, reject) => {
    preview.stdout.on('data', (d) => {
      if (String(d).includes('4174')) resolvePort()
    })
    preview.on('exit', (c) => reject(new Error(`vite preview exited: ${c}`)))
    setTimeout(() => reject(new Error('vite preview: timeout')), 30_000)
  })

  const { createRequire } = await import('node:module')
  const { chromium } = createRequire(join(pkgDir, 'package.json'))('playwright')
  const browser = await chromium.launch()
  const context = await browser.newContext()
  const page = await context.newPage()

  const expectResult = async (want) => {
    await page.waitForFunction(
      () => document.getElementById('result').textContent !== 'RUNNING',
      undefined,
      { timeout: 30_000 },
    )
    const got = await page.textContent('#result')
    if (got !== want) throw new Error(`expected "${want}", got "${got}"`)
    console.log('#', got)
  }

  await page.goto('http://localhost:4174/')
  await expectResult('SMOKE PASS rows=1')
  await page.reload()
  await expectResult('SMOKE PASS rows=2') // OPFS persisted across reload

  // shared mode: two tabs in one context, broker-routed. Tab A observes;
  // tab B's write must reach A without a reload.
  const expectOn = async (p, want) => {
    await p.waitForFunction(
      (w) => document.getElementById('result').textContent === w,
      want,
      { timeout: 30_000 },
    )
    console.log('#', want)
  }
  await page.goto('http://localhost:4174/?shared=1')
  await expectOn(page, 'SHARED rows=1')
  const pageB = await context.newPage()
  await pageB.goto('http://localhost:4174/?shared=1')
  await expectOn(pageB, 'SHARED rows=2')
  await expectOn(page, 'SHARED rows=2') // broadcast reached tab A live

  // the same shared scenario through `vite dev` — the pipeline where
  // optimizeDeps applies, running exactly the documented config
  mark('vite dev + headless Chromium')
  const dev = spawn('npx', ['vite', '--port', '4175', '--strictPort'], {
    cwd: appDir,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  try {
    await new Promise((resolvePort, reject) => {
      dev.stdout.on('data', (d) => {
        if (String(d).includes('4175')) resolvePort()
      })
      dev.on('exit', (c) => reject(new Error(`vite dev exited: ${c}`)))
      setTimeout(() => reject(new Error('vite dev: timeout')), 30_000)
    })
    const devContext = await browser.newContext()
    const devA = await devContext.newPage()
    await devA.goto('http://localhost:4175/?shared=1')
    await expectOn(devA, 'SHARED rows=1')
    const devB = await devContext.newPage()
    await devB.goto('http://localhost:4175/?shared=1')
    await expectOn(devB, 'SHARED rows=2')
    await expectOn(devA, 'SHARED rows=2')
  } finally {
    dev.kill()
  }

  await browser.close()
  console.log('VITE SMOKE: PASS')
} finally {
  preview.kill()
  rmSync(work, { recursive: true, force: true })
}
