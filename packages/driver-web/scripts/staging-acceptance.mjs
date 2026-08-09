/**
 * Live-deployment acceptance for the shared-worker driver: drives real
 * browsers at a deployed app and asserts the multi-tab failure modes
 * that unit suites cannot exercise (real tab lifecycle, real caches).
 *
 *   BASE=https://your-app.example node scripts/staging-acceptance.mjs
 *
 * chromium: the three-tab dance — open two, close the (host) first,
 *           open a third; no tab may show a database error banner.
 * firefox:  full-page navigations plus a second tab; no banner.
 *
 * BANNER matches the app's database error surface; override via env
 * for apps with different copy.
 */
import { chromium, firefox } from 'playwright'

const BASE = process.env.BASE ?? 'https://cards.dustyway.org'
const BANNER = process.env.BANNER ?? 'Offline Database Error'
const results = []

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const bannerIn = async (page) =>
  (await page.getByText(BANNER, { exact: false }).count()) > 0
const bannerText = async (page) =>
  (await page
    .locator(`text=${BANNER}`)
    .first()
    .locator('..')
    .textContent()
    .catch(() => '(none)')) ?? '(none)'

async function chromiumThreeTabs() {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const p1 = await context.newPage()
  await p1.goto(BASE, { waitUntil: 'load' })
  const p2 = await context.newPage()
  await p2.goto(BASE, { waitUntil: 'load' })
  await settle(4000) // let the db open; p1 is the worker host
  await p1.close()
  const p3 = await context.newPage()
  await p3.goto(BASE, { waitUntil: 'load' })
  await settle(15000) // respawn + acquisition backoff room
  const bad2 = await bannerIn(p2)
  const bad3 = await bannerIn(p3)
  if (bad2) console.log('  tab2:', (await bannerText(p2)).slice(0, 160))
  if (bad3) console.log('  tab3:', (await bannerText(p3)).slice(0, 160))
  results.push([`chromium three-tab: tab2=${bad2} tab3=${bad3}`, !bad2 && !bad3])
  await browser.close()
}

async function firefoxNavigation() {
  const browser = await firefox.launch({ headless: true })
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(BASE, { waitUntil: 'load' })
  await settle(4000)
  await page.goto(`${BASE}/login`, { waitUntil: 'load' })
  await settle(6000)
  const afterLogin = await bannerIn(page)
  await page.goto(`${BASE}/register`, { waitUntil: 'load' })
  await settle(6000)
  const afterRegister = await bannerIn(page)
  const tab2 = await context.newPage()
  await tab2.goto(`${BASE}/login`, { waitUntil: 'load' })
  await settle(6000)
  const tab2Banner = await bannerIn(tab2)
  if (afterLogin || afterRegister || tab2Banner) {
    console.log('  firefox:', (await bannerText(tab2Banner ? tab2 : page)).slice(0, 160))
  }
  results.push([
    `firefox nav: login=${afterLogin} register=${afterRegister} tab2=${tab2Banner}`,
    !afterLogin && !afterRegister && !tab2Banner,
  ])
  await browser.close()
}

await chromiumThreeTabs()
await firefoxNavigation()
let pass = true
for (const [line, ok] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${line}`)
  pass = pass && ok
}
console.log(pass ? 'ACCEPTANCE: PASS' : 'ACCEPTANCE: FAIL')
process.exit(pass ? 0 : 1)
