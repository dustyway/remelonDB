// The example's story, verified: two isolated browser contexts (each
// with its own OPFS — genuinely two devices) against the real server.
import { chromium } from 'playwright'

export async function runActs(url) {
  const suffix = process.pid
  const FIRST = `walk the dog ${suffix}`
  const OFFLINE = `written offline ${suffix}`
  const browser = await chromium.launch()

  const makeWindow = async (name) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    const errors = []
    page.on('console', (m) => m.type() === 'error' && errors.push(`${name}: ${m.text()}`))
    page.on('pageerror', (e) => errors.push(`${name}: ${e}`))
    await page.goto(url)
    await page.waitForSelector('#status')
    return { name, context, page, errors }
  }

  const waitStatus = (w, value) =>
    w.page.waitForSelector(`#status[data-sync-status="${value}"]`, { timeout: 20000 })
  const addTodo = async (w, text) => {
    await w.page.fill('input[aria-label="New todo"]', text)
    await w.page.press('input[aria-label="New todo"]', 'Enter')
  }

  const a = await makeWindow('A')
  const b = await makeWindow('B')

  // Act 1: a todo added in A appears in B.
  await waitStatus(a, 'synced')
  await waitStatus(b, 'synced')
  await addTodo(a, FIRST)
  await a.page.waitForSelector(`li:has-text("${FIRST}")`, { timeout: 5000 })
  await b.page.waitForSelector(`li:has-text("${FIRST}")`, { timeout: 20000 })
  console.log('act 1: create propagates A → B')

  // Act 2: toggling done in B strikes it through in A, and back.
  await b.page.click(`li:has-text("${FIRST}")`)
  await b.page.waitForSelector(`li.done:has-text("${FIRST}")`, { timeout: 5000 })
  await a.page.waitForSelector(`li.done:has-text("${FIRST}")`, { timeout: 20000 })
  await a.page.click(`li:has-text("${FIRST}")`)
  await b.page.waitForSelector(`li:not(.done):has-text("${FIRST}")`, { timeout: 20000 })
  console.log('act 2: edits propagate both directions')

  // Act 3: A's network dies; A notices, B stays green.
  await a.context.route('**/sync/**', (route) => route.abort())
  await waitStatus(a, 'offline')
  console.log('act 3: A shows offline')

  // Act 4: A keeps working locally; nothing leaks to B.
  await addTodo(a, OFFLINE)
  await a.page.waitForSelector(`li:has-text("${OFFLINE}")`, { timeout: 5000 })
  await new Promise((r) => setTimeout(r, 4000))
  if ((await b.page.locator(`li:has-text("${OFFLINE}")`).count()) > 0) {
    throw new Error('offline todo leaked to B during the outage')
  }
  await waitStatus(b, 'synced')
  console.log('act 4: offline write stays local')

  // Act 5: the network returns; A catches up and B receives.
  await a.context.unroute('**/sync/**')
  await waitStatus(a, 'synced')
  await b.page.waitForSelector(`li:has-text("${OFFLINE}")`, { timeout: 20000 })
  console.log('act 5: recovery pushes the offline write to B')

  // Aborted /sync fetches during the outage are the point, not a defect.
  const expected = (m) => /sync\/(pull|push)|Failed to load resource|ERR_FAILED/.test(m)
  const unexpected = [...a.errors, ...b.errors].filter((m) => !expected(m))
  if (unexpected.length > 0) {
    throw new Error(`unexpected console errors:\n${unexpected.join('\n')}`)
  }

  await browser.close()
}
