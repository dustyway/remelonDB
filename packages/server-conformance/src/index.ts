/**
 * The executable backend contract: every sync server must pass this
 * suite, one scenario per item of docs/sync-wire.md's conformance
 * checklist. Handlers are plain async functions, so the same suite runs
 * against an in-process app, an HTTP endpoint behind a fetch wrapper,
 * or the in-memory reference server shipped here.
 *
 * Usage (in a vitest file):
 *
 *   registerServerConformance({
 *     name: 'my backend',
 *     makeContext: async () => ({
 *       handlers: primaryUserHandlers,
 *       secondUser: otherUserHandlers,   // optional: scoping scenarios
 *     }),
 *     fixtures: {
 *       tasks: {
 *         validRow: () => ({ id: newId(), name: 'a', done: false }),
 *         mutate: (row) => ({ ...row, name: 'changed' }),
 *         invalidRow: () => ({ id: newId(), name: '', done: false }),
 *       },
 *     },
 *   })
 *
 * Checklist item 4 (a change committing DURING a pull) needs real
 * transaction interleaving a generic suite cannot orchestrate; it runs
 * only when a `concurrently` hook is provided and is reported as
 * skipped otherwise — silent omission would misreport coverage.
 */
import { describe, expect, it } from 'vitest'
import type {
  DirtyRaw,
  SyncChanges,
  SyncPullResult,
  SyncPushResult,
} from '@remelondb/core'
import type { SyncHandlers } from './referenceServer'

export { createReferenceServer } from './referenceServer'
export type { ReferenceServer, ReferenceServerOptions, SyncHandlers } from './referenceServer'

export type WireRow = DirtyRaw & { id: string }

export interface TableFixture {
  /** A fresh valid wire row with a unique id. */
  validRow(): WireRow
  /** A changed-but-valid version of an existing row. */
  mutate(row: WireRow): WireRow
  /** A row the server must refuse (lands in `rejected`); omit to skip. */
  invalidRow?(): WireRow
}

export interface ServerConformanceContext {
  readonly handlers: SyncHandlers
  /** Same operations authenticated as a different principal. */
  readonly secondUser?: SyncHandlers
  /** Run `write` while `pull` is in flight (checklist item 4). */
  readonly concurrently?: (
    pull: () => Promise<SyncPullResult>,
    write: () => Promise<void>,
  ) => Promise<SyncPullResult>
}

export interface ServerConformanceOptions {
  readonly name: string
  /** Fresh context per test: clean server state, authenticated handlers. */
  readonly makeContext: () => Promise<ServerConformanceContext>
  readonly fixtures: { readonly [table: string]: TableFixture }
}

const only = (changes: SyncChanges, table: string) =>
  changes[table] ?? { created: [], updated: [], deleted: [] }
const liveIds = (changes: SyncChanges, table: string): string[] => {
  const set = only(changes, table)
  return [...set.created, ...set.updated].map((row) => String(row['id']))
}

const pulled = (result: SyncPullResult) => {
  expect(result).not.toHaveProperty('resyncRequired')
  return result as { changes: SyncChanges; cursor: string }
}
/** Every accepted push must satisfy the package rule; assert centrally. */
const accepted = (result: SyncPushResult) => {
  expect(result).not.toHaveProperty('conflict')
  const ok = result as {
    cursor: string | null
    changes: SyncChanges | null
    rejected?: Record<string, readonly string[]>
  }
  expect(ok.cursor === null).toBe(ok.changes === null)
  return ok
}

/**
 * Register the wire spec's conformance checklist as a vitest suite
 * against any backend's pull/push handlers. Optional fixtures and
 * contexts unlock the scoping and validation scenarios; omissions are
 * reported as skips, not silent passes.
 *
 * @example
 * ```ts
 * registerServerConformance({
 *   name: 'my backend',
 *   makeContext: async () => ({ handlers: engine.as('user-1') }),
 *   fixtures: {
 *     todos: { validRow: () => ({ id: newId(), text: 'a', done: false }),
 *              mutate: (row) => ({ ...row, text: 'changed' }) },
 *   },
 * })
 * ```
 * @category Conformance
 */
export function registerServerConformance(
  options: ServerConformanceOptions,
): void {
  const tables = Object.keys(options.fixtures)
  if (tables.length === 0) {
    throw new Error('registerServerConformance: at least one table fixture')
  }
  const table = tables[0]!
  const fixture = options.fixtures[table]!
  const changesWith = (
    rows: WireRow[],
    deleted: string[] = [],
    asUpdated = false,
  ): SyncChanges => ({
    [table]: {
      created: asUpdated ? [] : rows,
      updated: asUpdated ? rows : [],
      deleted,
    },
  })
  const pullNull = (h: SyncHandlers) =>
    h.pull({ cursor: null, schemaVersion: 1, migration: null })
  const pullFrom = (h: SyncHandlers, cursor: string) =>
    h.pull({ cursor, schemaVersion: 1, migration: null })

  describe(`sync server conformance: ${options.name}`, () => {
    it('1. full pull returns the complete state, scoped to the caller', async () => {
      const { handlers } = await options.makeContext()
      const row = fixture.validRow()
      const { cursor } = pulled(await pullNull(handlers))
      accepted(await handlers.push({ changes: changesWith([row]), cursor }))

      const full = pulled(await pullNull(handlers))
      expect(liveIds(full.changes, table)).toContain(row.id)
    })

    it('2. incremental pull returns exactly the rows changed after the cursor', async () => {
      const { handlers } = await options.makeContext()
      const first = fixture.validRow()
      const start = pulled(await pullNull(handlers))
      const afterFirst = accepted(
        await handlers.push({ changes: changesWith([first]), cursor: start.cursor }),
      )
      const caughtUp = pulled(await pullFrom(handlers, afterFirst.cursor ?? start.cursor))

      const second = fixture.validRow()
      accepted(
        await handlers.push({ changes: changesWith([second]), cursor: caughtUp.cursor }),
      )
      const incremental = pulled(await pullFrom(handlers, caughtUp.cursor))
      expect(liveIds(incremental.changes, table)).toEqual([second.id])
    })

    it('3. deletions arrive as ids, never as records', async () => {
      const { handlers } = await options.makeContext()
      const row = fixture.validRow()
      const start = pulled(await pullNull(handlers))
      const afterCreate = accepted(
        await handlers.push({ changes: changesWith([row]), cursor: start.cursor }),
      )
      const cursor =
        afterCreate.cursor ?? pulled(await pullNull(handlers)).cursor
      accepted(
        await handlers.push({ changes: changesWith([], [row.id]), cursor }),
      )

      const after = pulled(await pullFrom(handlers, cursor))
      expect(only(after.changes, table).deleted).toContain(row.id)
      expect(liveIds(after.changes, table)).not.toContain(row.id)
    })

    it('4. a change committing during a pull is never lost (needs `concurrently`)', async (ctx) => {
      const context = await options.makeContext()
      if (!context.concurrently) {
        ctx.skip()
        return
      }
      const { handlers, concurrently } = context
      const row = fixture.validRow()
      const start = pulled(await pullNull(handlers))
      const during = fixture.validRow()

      const result = pulled(
        await concurrently(
          () => pullFrom(handlers, start.cursor),
          async () => {
            const mine = pulled(await pullNull(handlers))
            accepted(
              await handlers.push({ changes: changesWith([during]), cursor: mine.cursor }),
            )
          },
        ),
      )
      // whether or not the concurrent write made this snapshot, it MUST
      // be visible from the returned cursor's future
      if (!liveIds(result.changes, table).includes(during.id)) {
        const next = pulled(await pullFrom(handlers, result.cursor))
        expect(liveIds(next.changes, table)).toContain(during.id)
      }
    })

    it('5. replaying a push yields identical state', async () => {
      const { handlers } = await options.makeContext()
      const row = fixture.validRow()
      const start = pulled(await pullNull(handlers))
      const first = accepted(
        await handlers.push({ changes: changesWith([row]), cursor: start.cursor }),
      )
      const replayCursor =
        first.cursor ?? pulled(await pullNull(handlers)).cursor
      accepted(
        await handlers.push({
          changes: changesWith([row], [], true),
          cursor: replayCursor,
        }),
      )

      const state = pulled(await pullNull(handlers))
      expect(
        liveIds(state.changes, table).filter((id) => id === row.id),
      ).toHaveLength(1)
    })

    it('6. a stale push answers conflict and applies nothing', async () => {
      const { handlers } = await options.makeContext()
      const row = fixture.validRow()
      const start = pulled(await pullNull(handlers))
      accepted(
        await handlers.push({ changes: changesWith([row]), cursor: start.cursor }),
      )
      // another device updates the row from a fresh cursor
      const deviceB = pulled(await pullNull(handlers))
      const updatedByB = fixture.mutate(row)
      accepted(
        await handlers.push({
          changes: changesWith([updatedByB], [], true),
          cursor: deviceB.cursor,
        }),
      )
      // the first device, still on its old cursor, pushes its own edit
      const bystander = fixture.validRow()
      const stale = await handlers.push({
        changes: {
          [table]: {
            created: [bystander],
            updated: [fixture.mutate(row)],
            deleted: [],
          },
        },
        cursor: start.cursor,
      })
      expect(stale).toEqual({ conflict: true })

      const state = pulled(await pullNull(handlers))
      expect(liveIds(state.changes, table)).not.toContain(bystander.id)
    })

    it('7. an invalid record is rejected by id while the rest applies (needs `invalidRow`)', async (ctx) => {
      if (!fixture.invalidRow) {
        ctx.skip()
        return
      }
      const { handlers } = await options.makeContext()
      const good = fixture.validRow()
      const bad = fixture.invalidRow()
      const start = pulled(await pullNull(handlers))
      const result = accepted(
        await handlers.push({
          changes: changesWith([good, bad]),
          cursor: start.cursor,
        }),
      )
      expect(result.rejected?.[table]).toEqual([bad.id])

      const state = pulled(await pullNull(handlers))
      expect(liveIds(state.changes, table)).toContain(good.id)
      expect(liveIds(state.changes, table)).not.toContain(bad.id)
    })

    it('8. the push response carries the interleave and never the echo', async () => {
      const { handlers } = await options.makeContext()
      const myCursor = pulled(await pullNull(handlers)).cursor
      // another device commits a foreign change after my cursor
      const foreign = fixture.validRow()
      const deviceB = pulled(await pullNull(handlers))
      accepted(
        await handlers.push({ changes: changesWith([foreign]), cursor: deviceB.cursor }),
      )

      const mine = fixture.validRow()
      const result = accepted(
        await handlers.push({ changes: changesWith([mine]), cursor: myCursor }),
      )
      if (result.cursor !== null) {
        const ids = liveIds(result.changes!, table)
        expect(ids).toContain(foreign.id)
        expect(ids).not.toContain(mine.id)
        const after = pulled(await pullFrom(handlers, result.cursor))
        expect(liveIds(after.changes, table)).toEqual([])
      } else {
        // degraded is lawful; the next pull must deliver both
        const after = pulled(await pullFrom(handlers, myCursor))
        const ids = liveIds(after.changes, table)
        expect(ids).toContain(foreign.id)
        expect(ids).toContain(mine.id)
      }
    })

    it('9. an unknown cursor answers resyncRequired, and a full re-pull converges', async () => {
      const { handlers } = await options.makeContext()
      const row = fixture.validRow()
      const start = pulled(await pullNull(handlers))
      accepted(
        await handlers.push({ changes: changesWith([row]), cursor: start.cursor }),
      )
      const unknown = await handlers.pull({
        cursor: '___not-a-cursor-this-server-issued___',
        schemaVersion: 1,
        migration: null,
      })
      expect(unknown).toEqual({ resyncRequired: true })

      const full = pulled(await pullNull(handlers))
      expect(liveIds(full.changes, table)).toContain(row.id)
    })

    it("10. another principal's data never crosses (needs `secondUser`)", async (ctx) => {
      const context = await options.makeContext()
      if (!context.secondUser) {
        ctx.skip()
        return
      }
      const { handlers, secondUser } = context
      const mine = fixture.validRow()
      const start = pulled(await pullNull(handlers))
      accepted(
        await handlers.push({ changes: changesWith([mine]), cursor: start.cursor }),
      )

      const theirs = pulled(await pullNull(secondUser))
      expect(liveIds(theirs.changes, table)).not.toContain(mine.id)
      // nor via their push interleave
      const other = fixture.validRow()
      const result = accepted(
        await secondUser.push({
          changes: changesWith([other]),
          cursor: theirs.cursor,
        }),
      )
      if (result.changes !== null) {
        expect(liveIds(result.changes, table)).not.toContain(mine.id)
      }
    })
  })
}
