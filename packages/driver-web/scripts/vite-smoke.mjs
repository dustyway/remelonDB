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

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], ...opts })

console.log('# packing core and driver-web (prepack builds dist)')
sh('pnpm', ['--filter', '@remelondb/core', 'pack', '--pack-destination', tarballDir], { cwd: repoRoot })
sh('pnpm', ['--filter', '@remelondb/driver-web', 'pack', '--pack-destination', tarballDir], { cwd: repoRoot })
const tgz = (name) => join(tarballDir, readdirSync(tarballDir).find((f) => f.startsWith(name)))
const coreTgz = tgz('remelondb-core-')
const webTgz = tgz('remelondb-driver-web-')

console.log('# scaffolding the Vite app in', appDir)
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
  `import { appSchema, tableSchema, Database, Model, Q } from '@remelondb/core'
import { WebSqliteDriver } from '@remelondb/driver-web'

const schema = appSchema({
  version: 1,
  tables: [
    tableSchema({
      name: 'tasks',
      columns: [{ name: 'name', type: 'string' }],
    }),
  ],
})

class Task extends Model {
  static table = 'tasks'
}

const el = document.getElementById('result')
try {
  const db = await Database.open({
    driver: new WebSqliteDriver(), // storage: 'opfs' — the point of the test
    schema,
    modelClasses: [Task],
    name: 'vite-smoke.db',
  })
  await db.write(() => db.get('tasks').create({ name: 'from production build' }))
  const rows = await db.get('tasks').query(Q.where('name', 'from production build')).fetch()
  el.textContent = 'SMOKE PASS rows=' + rows.length
} catch (e) {
  el.textContent = 'SMOKE FAIL: ' + e
}
`,
)

console.log('# npm install + vite build')
sh('npm', ['install', '--no-audit', '--no-fund'], { cwd: appDir })
sh('npx', ['vite', 'build'], { cwd: appDir })

console.log('# vite preview + headless Chromium')
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
  const page = await browser.newPage()

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

  await browser.close()
  console.log('VITE SMOKE: PASS')
} finally {
  preview.kill()
  rmSync(work, { recursive: true, force: true })
}
