import { describe, expect, it } from 'vitest'
import { registerServerConformance } from './conformance/index'
import { createMemoryStore, createSyncEngine } from './index'

// The engine over the memory store must pass the full backend contract;
// a real adapter proves itself the same way, engine included.
let counter = 0
const newId = (): string => `row-${++counter}`

registerServerConformance({
  name: 'engine over MemoryStore',
  makeContext: async () => {
    const engine = createSyncEngine({
      store: createMemoryStore(),
      tables: {
        tasks: { validate: (row) => row['name'] !== '' },
      },
    })
    return {
      handlers: engine.as('scope-a'),
      secondUser: engine.as('scope-b'),
    }
  },
  fixtures: {
    tasks: {
      validRow: () => ({ id: newId(), name: 'a task', done: false }),
      mutate: (row) => ({ ...row, name: `${String(row['name'])} (edited)` }),
      invalidRow: () => ({ id: newId(), name: '', done: false }),
    },
  },
})

describe('appendOnly tables', () => {
  const setup = () => {
    const engine = createSyncEngine({
      store: createMemoryStore(),
      tables: { events: { appendOnly: true } },
    })
    return engine.as('scope-a')
  }
  const pull = async (h: ReturnType<typeof setup>) => {
    const result = await h.pull({ cursor: null, schemaVersion: 1, migration: null })
    if (!('cursor' in result)) throw new Error('unexpected resync')
    return result
  }
  const eventsWith = (
    created: { id: string; rating: number }[],
    updated: { id: string; rating: number }[] = [],
    deleted: string[] = [],
  ) => ({ events: { created, updated, deleted } })

  it('rejects a write to an existing id and keeps the stored content', async () => {
    const handlers = setup()
    const start = await pull(handlers)
    await handlers.push({
      changes: eventsWith([{ id: 'e1', rating: 3 }]),
      cursor: start.cursor,
    })
    const seeded = await pull(handlers)

    const result = await handlers.push({
      changes: eventsWith([], [{ id: 'e1', rating: 1 }]),
      cursor: seeded.cursor,
    })

    expect(result).not.toHaveProperty('conflict')
    expect(
      (result as { rejected?: Record<string, readonly string[]> }).rejected
        ?.events,
    ).toEqual(['e1'])
    const state = await pull(handlers)
    expect(state.changes['events']?.updated).toEqual([
      expect.objectContaining({ id: 'e1', rating: 3 }),
    ])
  })

  it('still allows new rows and deletes', async () => {
    const handlers = setup()
    const start = await pull(handlers)
    await handlers.push({
      changes: eventsWith([{ id: 'e1', rating: 3 }]),
      cursor: start.cursor,
    })
    const seeded = await pull(handlers)

    const result = await handlers.push({
      changes: eventsWith([{ id: 'e2', rating: 4 }], [], ['e1']),
      cursor: seeded.cursor,
    })

    expect(result).not.toHaveProperty('conflict')
    expect(
      (result as { rejected?: Record<string, readonly string[]> }).rejected,
    ).toBeUndefined()
    const state = await pull(handlers)
    expect(state.changes['events']?.updated).toEqual([
      expect.objectContaining({ id: 'e2', rating: 4 }),
    ])
    expect(state.changes['events']?.deleted).toEqual(['e1'])
  })
})
