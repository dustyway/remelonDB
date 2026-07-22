// The example's story, verified: two isolated browser contexts (each
// with its own OPFS — genuinely two devices) against the real server.
import { chromium } from 'playwright'

export async function runSteps(url, hooks = {}) {
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

  // Step 1: a todo added in A appears in B.
  await waitStatus(a, 'synced')
  await waitStatus(b, 'synced')
  await addTodo(a, FIRST)
  await a.page.waitForSelector(`li:has-text("${FIRST}")`, { timeout: 5000 })
  await b.page.waitForSelector(`li:has-text("${FIRST}")`, { timeout: 20000 })
  console.log('step 1: create propagates A → B')

  // Step 2: toggling done in B strikes it through in A, and back.
  await b.page.click(`li:has-text("${FIRST}")`)
  await b.page.waitForSelector(`li.done:has-text("${FIRST}")`, { timeout: 5000 })
  await a.page.waitForSelector(`li.done:has-text("${FIRST}")`, { timeout: 20000 })
  await a.page.click(`li:has-text("${FIRST}")`)
  await b.page.waitForSelector(`li:not(.done):has-text("${FIRST}")`, { timeout: 20000 })
  console.log('step 2: edits propagate both directions')

  // Step 3: A's network dies; A notices, B stays green.
  await a.context.route('**/sync/**', (route) => route.abort())
  await waitStatus(a, 'offline')
  console.log('step 3: A shows offline')

  // Step 4: A keeps working locally; nothing leaks to B.
  await addTodo(a, OFFLINE)
  await a.page.waitForSelector(`li:has-text("${OFFLINE}")`, { timeout: 5000 })
  await new Promise((r) => setTimeout(r, 4000))
  if ((await b.page.locator(`li:has-text("${OFFLINE}")`).count()) > 0) {
    throw new Error('offline todo leaked to B during the outage')
  }
  await waitStatus(b, 'synced')
  console.log('step 4: offline write stays local')

  // Step 5: the network returns; A catches up and B receives.
  await a.context.unroute('**/sync/**')
  await waitStatus(a, 'synced')
  await b.page.waitForSelector(`li:has-text("${OFFLINE}")`, { timeout: 20000 })
  console.log('step 5: recovery pushes the offline write to B')

  // Step 6: concurrent edits to the same row. A push that only races on
  // the cursor gets interleaved; a push whose row changed under it gets
  // `conflict`, re-pulls, retries. A's push is held at the network layer
  // until B has committed a toggle of the same todo, so the row conflict
  // is provable — no lucky timing involved.
  let pushArrived, releasePush
  const arrived = new Promise((resolve) => (pushArrived = resolve))
  const held = new Promise((resolve) => (releasePush = resolve))
  await a.context.route('**/sync/push', async (route) => {
    if (route.request().postData()?.includes(FIRST)) {
      pushArrived()
      await held
    }
    await route.continue()
  })
  const conflictLogged = a.page.waitForEvent('console', {
    predicate: (message) => message.text().includes('push conflict'),
    timeout: 20000,
  })
  await a.page.click(`li:has-text("${FIRST}")`)
  await arrived // A has pulled and its toggle push is in flight, held
  const bPushed = b.page.waitForResponse(
    (response) => response.url().includes('/sync/push') && response.ok(),
    { timeout: 20000 },
  )
  await b.page.click(`li:has-text("${FIRST}")`)
  await bPushed // B committed a change to the same row A is pushing
  const retryLanded = a.page.waitForResponse(
    async (response) => {
      if (!response.url().includes('/sync/push')) return false
      if (!response.request().postData()?.includes(FIRST)) return false
      const body = await response.json().catch(() => null)
      return body !== null && !('conflict' in body)
    },
    { timeout: 20000 },
  )
  releasePush()
  await conflictLogged
  await a.page.waitForSelector('#note:has-text("conflict")', { timeout: 20000 })
  await retryLanded // without this, FIRST stays dirty into step 7 and survives the wipe
  await a.page.waitForSelector(`li.done:has-text("${FIRST}")`, { timeout: 20000 })
  await b.page.waitForSelector(`li.done:has-text("${FIRST}")`, { timeout: 20000 })
  await a.context.unroute('**/sync/push')
  console.log('step 6: same-row race conflicts, re-pulls, retries, converges')

  // Step 7: the server loses its memory store; clients get resyncRequired,
  // re-pull from scratch, and only unpushed local writes survive.
  // Needs control over the server process, so it only runs locally.
  if (hooks.restartServer) {
    const SURVIVOR = `survives the wipe ${suffix}`
    await a.context.route('**/sync/**', (route) => route.abort())
    await addTodo(a, SURVIVOR)
    await a.page.waitForSelector(`li:has-text("${SURVIVOR}")`, { timeout: 5000 })
    await hooks.restartServer()
    await a.context.unroute('**/sync/**')
    await waitStatus(a, 'synced')
    await b.page.waitForSelector(`li:has-text("${SURVIVOR}")`, { timeout: 20000 })
    const onlySurvivor = async (w) => {
      try {
        await w.page.waitForFunction(
          () => document.querySelectorAll('li').length === 1,
          undefined,
          { timeout: 20000 },
        )
      } catch {
        const items = await w.page.locator('li').allInnerTexts()
        throw new Error(`${w.name} did not converge to one todo: ${JSON.stringify(items)}`)
      }
    }
    await onlySurvivor(a)
    await onlySurvivor(b)
    console.log('step 7: restart wipes the store; clients resync, unpushed writes survive')
  }

  // Step 8: field-level merge — an offline text edit and a remote done
  // toggle to the same todo both survive the reunion, because only the
  // locally-changed fields override what the pull brings in.
  const MERGE = `merge target ${suffix}`
  const EDITED = `merge target edited ${suffix}`
  await addTodo(a, MERGE)
  await b.page.waitForSelector(`li:has-text("${MERGE}")`, { timeout: 20000 })
  await a.context.route('**/sync/**', (route) => route.abort())
  await a.page
    .locator(`li:has-text("${MERGE}")`)
    .getByRole('button', { name: 'Edit' })
    .click()
  await a.page.fill('input[aria-label="Edit todo"]', EDITED)
  await a.page.press('input[aria-label="Edit todo"]', 'Enter')
  await a.page.waitForSelector(`li:has-text("${EDITED}")`, { timeout: 5000 })
  await b.page.click(`li:has-text("${MERGE}")`)
  await b.page.waitForSelector(`li.done:has-text("${MERGE}")`, { timeout: 5000 })
  await a.context.unroute('**/sync/**')
  await a.page.waitForSelector(`li.done:has-text("${EDITED}")`, { timeout: 20000 })
  await b.page.waitForSelector(`li.done:has-text("${EDITED}")`, { timeout: 20000 })
  console.log('step 8: offline text edit and remote toggle merge field by field')

  // Aborted /sync fetches during the outage are the point, not a defect.
  const expected = (m) => /sync\/(pull|push)|Failed to load resource|ERR_FAILED/.test(m)
  const unexpected = [...a.errors, ...b.errors].filter((m) => !expected(m))
  if (unexpected.length > 0) {
    throw new Error(`unexpected console errors:\n${unexpected.join('\n')}`)
  }

  await browser.close()
}
