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
  /**
   * A table this backend has declared `appendOnly`, with its fixture.
   * Opt-in config is invisible to the rest of the suite, so declare it
   * here and case 13 checks that the refusal actually reaches the wire
   * through *this* backend's own registration — the layer where a
   * transport can silently drop engine config.
   */
  readonly appendOnly?: {
    readonly table: string
    readonly fixture: TableFixture
  }
  /**
   * A table with a storage-enforced unique column, for backends whose
   * storage can refuse a row on its own (case 14). `row` builds a wire
   * row whose unique column carries `value`. Requires `secondUser`.
   */
  readonly uniqueColumn?: {
    readonly table: string
    readonly row: (id: string, value: string) => WireRow
  }
  /**
   * Cross-validation coverage (cases 15 and 16): the registrant mounts
   * its own `crossValidate`/`crossValidateChanges` hook and declares
   * rows that hook refuses, so the cases prove the *wiring*: a
   * transport or adapter that drops hook rejections, or applies a
   * rejected deletion, fails here. `rejectedRow` must be refused as an
   * upsert; `undeletableRow` must apply cleanly but have its deletion
   * refused.
   */
  readonly crossValidation?: {
    readonly table: string
    readonly rejectedRow: () => WireRow
    readonly undeletableRow: () => WireRow
  }
}

const only = (changes: SyncChanges, table: string) =>
  changes[table] ?? { created: [], updated: [], deleted: [] }
const liveIds = (changes: SyncChanges, table: string): string[] => {
  const set = only(changes, table)
  return [...set.created, ...set.updated].map((row) => String(row['id']))
}

/**
 * Assert a pull was served (not resyncRequired) and narrow to its
 * package. Exported so backend test suites stop re-writing it.
 * @category Conformance
 */
export const pulled = (result: SyncPullResult) => {
  expect(result).not.toHaveProperty('resyncRequired')
  return result as { changes: SyncChanges; cursor: string }
}
/**
 * Assert a push was accepted (not conflict) and that cursor/changes
 * come as a package; narrows to the accepted shape.
 * @category Conformance
 */
export const accepted = (result: SyncPushResult) => {
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

    it('11. a push naming one id in both created and updated applies the last statement', async () => {
      const { handlers } = await options.makeContext()
      const row = fixture.validRow()
      const edited = fixture.mutate(row)
      const start = pulled(await pullNull(handlers))
      // created/updated are advisory labels over the same upsert (spec:
      // strict classification is not required), so a changeset stating a
      // record twice means the last statement wins - never a store error
      const result = accepted(
        await handlers.push({
          changes: {
            [table]: { created: [row], updated: [edited], deleted: [] },
          },
          cursor: start.cursor,
        }),
      )
      expect(result.rejected?.[table] ?? []).toEqual([])

      const state = pulled(await pullNull(handlers))
      const stored = (state.changes[table]?.updated ?? []).filter(
        (r) => r.id === row.id,
      )
      expect(stored).toHaveLength(1)
      expect(stored[0]).toMatchObject(edited)
    })

    it('12. a write to a tombstoned id is rejected by id, never silently dropped', async () => {
      const { handlers } = await options.makeContext()
      const row = fixture.validRow()
      const start = pulled(await pullNull(handlers))
      accepted(
        await handlers.push({ changes: changesWith([row]), cursor: start.cursor }),
      )
      const afterCreate = pulled(await pullNull(handlers))
      accepted(
        await handlers.push({
          changes: changesWith([], [row.id]),
          cursor: afterCreate.cursor,
        }),
      )
      // the cursor advances past the tombstone, so the rewrite below is
      // not a conflict - the store will refuse to resurrect, and that
      // refusal must be visible in `rejected`
      const afterDelete = pulled(await pullNull(handlers))
      const result = accepted(
        await handlers.push({
          changes: changesWith([fixture.mutate(row)]),
          cursor: afterDelete.cursor,
        }),
      )
      expect(result.rejected?.[table] ?? []).toContain(row.id)

      const state = pulled(await pullNull(handlers))
      expect(liveIds(state.changes, table)).not.toContain(row.id)
    })

    const appendOnly = options.appendOnly
    const case13 = appendOnly ? it : it.skip
    case13('13. a write to an existing id in an appendOnly table is rejected by id', async () => {
      const { table: aoTable, fixture: aoFixture } = appendOnly!
      const { handlers } = await options.makeContext()
      const row = aoFixture.validRow()
      const changes = (rows: WireRow[], asUpdated = false): SyncChanges => ({
        [aoTable]: {
          created: asUpdated ? [] : rows,
          updated: asUpdated ? rows : [],
          deleted: [],
        },
      })

      const start = pulled(await pullNull(handlers))
      const create = accepted(
        await handlers.push({ changes: changes([row]), cursor: start.cursor }),
      )
      expect(create.rejected?.[aoTable] ?? []).not.toContain(row.id)

      // the rewrite is not a conflict: the cursor is current, so a
      // silent drop here would be reported as accepted and the pushing
      // device would fork from the server forever
      const afterCreate = pulled(await pullNull(handlers))
      const rewrite = accepted(
        await handlers.push({
          changes: changes([aoFixture.mutate(row)], true),
          cursor: afterCreate.cursor,
        }),
      )
      expect(rewrite.rejected?.[aoTable] ?? []).toContain(row.id)

      // and the stored row is untouched
      const state = pulled(await pullNull(handlers))
      const stored = [
        ...only(state.changes, aoTable).created,
        ...only(state.changes, aoTable).updated,
      ].find((r) => String(r['id']) === row.id)
      expect(stored).toEqual(row)
    })

    const uniqueColumn = options.uniqueColumn
    const case14 = uniqueColumn ? it : it.skip
    case14('14. a storage constraint refusal is a per-record rejection, and the rest of the batch applies (needs `uniqueColumn`)', async (ctx) => {
      const { table: uqTable, row: uqRow } = uniqueColumn!
      const { handlers, secondUser } = await options.makeContext()
      if (!secondUser) return ctx.skip()
      const changes = (rows: WireRow[]): SyncChanges => ({
        [uqTable]: { created: [], updated: rows, deleted: [] },
      })

      const startA = pulled(await pullNull(handlers))
      accepted(
        await handlers.push({
          changes: changes([uqRow('uq-a', 'taken')]),
          cursor: startA.cursor,
        }),
      )

      // the second principal pushes one colliding row and one clean row:
      // the refusal must reach the wire as a rejected id, never a thrown
      // error, while the clean row applies in the same push
      const startB = pulled(await pullNull(secondUser))
      const collide = accepted(
        await secondUser.push({
          changes: changes([uqRow('uq-b1', 'taken'), uqRow('uq-b2', 'free')]),
          cursor: startB.cursor,
        }),
      )
      expect(collide.rejected?.[uqTable] ?? []).toContain('uq-b1')
      const afterB = pulled(await pullNull(secondUser))
      expect(liveIds(afterB.changes, uqTable)).toContain('uq-b2')
      expect(liveIds(afterB.changes, uqTable)).not.toContain('uq-b1')

      // the refusal wedges nothing: the same id retries with a free value
      // and goes through
      const recovered = accepted(
        await secondUser.push({
          changes: changes([uqRow('uq-b1', 'fresh')]),
          cursor: collide.cursor!,
        }),
      )
      expect(recovered.rejected?.[uqTable] ?? []).toEqual([])
    })

    const crossValidation = options.crossValidation
    const caseCross = crossValidation ? it : it.skip
    caseCross('15. a cross-validation refusal is reported in rejected and the row is not applied (needs `crossValidation`)', async () => {
      const { table: cvTable, rejectedRow } = crossValidation!
      const { handlers } = await options.makeContext()
      const bad = rejectedRow()

      const start = pulled(await pullNull(handlers))
      const result = accepted(
        await handlers.push({
          changes: {
            [cvTable]: { created: [bad], updated: [], deleted: [] },
          },
          cursor: start.cursor,
        }),
      )
      expect(result.rejected?.[cvTable] ?? []).toContain(bad.id)

      const state = pulled(await pullNull(handlers))
      expect(liveIds(state.changes, cvTable)).not.toContain(bad.id)
    })

    caseCross('16. a cross-validation refusal of a deletion keeps the row alive (needs `crossValidation`)', async () => {
      const { table: cvTable, undeletableRow } = crossValidation!
      const { handlers } = await options.makeContext()
      const keystone = undeletableRow()

      const start = pulled(await pullNull(handlers))
      const seeded = accepted(
        await handlers.push({
          changes: {
            [cvTable]: { created: [keystone], updated: [], deleted: [] },
          },
          cursor: start.cursor,
        }),
      )
      expect(seeded.rejected?.[cvTable] ?? []).not.toContain(keystone.id)

      // the deletion is refused: reported by id, and the tombstone must
      // NOT be applied: a transport that reports but still deletes
      // diverges every other device
      const denied = accepted(
        await handlers.push({
          changes: {
            [cvTable]: { created: [], updated: [], deleted: [keystone.id] },
          },
          cursor: seeded.cursor!,
        }),
      )
      expect(denied.rejected?.[cvTable] ?? []).toContain(keystone.id)

      const state = pulled(await pullNull(handlers))
      expect(liveIds(state.changes, cvTable)).toContain(keystone.id)
    })

    it('17. an id in deleted supersedes its created/updated content in the same push', async () => {
      const { handlers } = await options.makeContext()
      const row = fixture.validRow()
      const start = pulled(await pullNull(handlers))
      const seeded = accepted(
        await handlers.push({ changes: changesWith([row]), cursor: start.cursor }),
      )

      // updated + deleted for a live id: the deletion wins, the content
      // statement is never applied, and nothing is rejected
      const both = accepted(
        await handlers.push({
          changes: changesWith([fixture.mutate(row)], [row.id], true),
          cursor: seeded.cursor ?? start.cursor,
        }),
      )
      expect(both.rejected?.[table] ?? []).toEqual([])
      const afterBoth = pulled(await pullNull(handlers))
      expect(liveIds(afterBoth.changes, table)).not.toContain(row.id)

      // created + deleted for an unknown id nets to nothing
      const ghost = fixture.validRow()
      const netted = accepted(
        await handlers.push({
          changes: changesWith([ghost], [ghost.id]),
          cursor: afterBoth.cursor,
        }),
      )
      expect(netted.rejected?.[table] ?? []).toEqual([])
      const state = pulled(await pullNull(handlers))
      expect(liveIds(state.changes, table)).not.toContain(ghost.id)
    })

    const case18 = crossValidation ? it : it.skip
    case18('18. a refused deletion of a duplicated id rejects the id and keeps the pre-push content (needs `crossValidation`)', async () => {
      const { table: cvTable, undeletableRow } = crossValidation!
      const { handlers } = await options.makeContext()
      const keystone = undeletableRow()
      const cvChanges = (
        rows: WireRow[],
        deleted: string[] = [],
      ): SyncChanges => ({
        [cvTable]: { created: [], updated: rows, deleted },
      })

      const start = pulled(await pullNull(handlers))
      const seeded = accepted(
        await handlers.push({ changes: cvChanges([keystone]), cursor: start.cursor }),
      )
      expect(seeded.rejected?.[cvTable] ?? []).not.toContain(keystone.id)

      // an update AND a deletion for the keystone: the deletion is the
      // surviving statement, the hook refuses it, so the id is rejected
      // and NEITHER effect lands — the row keeps its pre-push content
      const mutated = { ...keystone, ...{} } as WireRow
      for (const key of Object.keys(mutated)) {
        if (key !== 'id' && typeof mutated[key] === 'string') {
          mutated[key] = `${String(mutated[key])} (rewritten)`
          break
        }
      }
      const denied = accepted(
        await handlers.push({
          changes: cvChanges([mutated], [keystone.id]),
          cursor: seeded.cursor!,
        }),
      )
      expect(denied.rejected?.[cvTable] ?? []).toContain(keystone.id)

      const state = pulled(await pullNull(handlers))
      const stored = [
        ...only(state.changes, cvTable).created,
        ...only(state.changes, cvTable).updated,
      ].find((r) => String(r['id']) === keystone.id)
      expect(stored).toEqual(keystone)
    })
  })
}
