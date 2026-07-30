/**
 * Change broadcast (docs/multi-tab.md): after a commit in one tab, the
 * broker fans the change set out to every other tab holding that
 * database, which applies it through database.applyExternalChanges —
 * caches update in place, observers re-emit. This is the slice that
 * makes tab B's screen change when tab A writes.
 */
import { describe, expect, it } from 'vitest'
import { appSchema, column as c, Database, ModelFor, table } from '@remelondb/core'
import { WebSqliteDriver } from './WebSqliteDriver'

const notesTable = table('notes', {
  text: c.string(),
})
const schema = appSchema({ version: 1, tables: [notesTable] })
class Note extends ModelFor(notesTable) {}

describe('shared mode change broadcast', () => {
  it("a commit in one tab reaches the other tab's observers", async () => {
    const name = `broadcast-${Date.now()}.db`
    const driverA = new WebSqliteDriver({ shared: true })
    const driverB = new WebSqliteDriver({ shared: true })
    const dbA = await Database.open({
      driver: driverA,
      schema,
      modelClasses: [Note],
      name,
    })
    const dbB = await Database.open({
      driver: driverB,
      schema,
      modelClasses: [Note],
      name,
    })

    // A observes; B writes; A's observer must see it without any A-side action
    const emissions: Note[][] = []
    const unsubscribe = dbA
      .get(Note)
      .query()
      .observe((records) => emissions.push(records))
    await expect.poll(() => emissions.length).toBeGreaterThan(0)
    expect(emissions.at(-1)).toEqual([])

    await dbB.write(() => dbB.get(Note).create({ id: 'n1', text: 'from b' }))
    await expect
      .poll(() => emissions.at(-1)!.map((n) => n.text))
      .toEqual(['from b'])

    // updates flow too, mutating A's cached instance in place
    const noteInA = emissions.at(-1)![0]!
    await dbB.write(async () => {
      const [noteInB] = await dbB.get(Note).query().fetch()
      await noteInB!.update(() => {
        noteInB!.text = 'edited in b'
      })
    })
    await expect.poll(() => noteInA.text).toBe('edited in b')

    // the origin tab must not double-apply its own broadcast
    await dbB.write(() => dbB.get(Note).create({ id: 'n2', text: 'second' }))
    await expect.poll(() => emissions.at(-1)!.length).toBe(2)
    expect((await dbB.get(Note).query().fetch()).length).toBe(2)

    unsubscribe()
    await driverA.close()
    await driverB.destroy()

    // pool hygiene for the next test file (see sharedWorker test)
    driverA.hostedComputeWorker?.terminate()
    driverB.hostedComputeWorker?.terminate()
    await new Promise((resolve) => setTimeout(resolve, 100))
  })
})
