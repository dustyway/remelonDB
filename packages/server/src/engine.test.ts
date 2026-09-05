import { describe, expect, it } from 'vitest';
import { registerServerConformance } from './conformance/index';
import {
  createMemoryStore,
  createSyncEngine,
  SyncProtocolError,
  type SyncStore,
} from './index';

// The engine over the memory store must pass the full backend contract;
// a real adapter proves itself the same way, engine included.
let counter = 0;
const newId = (): string => `row-${++counter}`;

registerServerConformance({
  name: 'engine over MemoryStore',
  makeContext: async () => {
    const engine = createSyncEngine({
      store: createMemoryStore(),
      tables: {
        tasks: { validate: (row) => row['name'] !== '' },
        events: { validate: () => true, appendOnly: true },
      },
    });
    return {
      handlers: engine.as('scope-a'),
      secondUser: engine.as('scope-b'),
    };
  },
  fixtures: {
    tasks: {
      validRow: () => ({ id: newId(), name: 'a task', done: false }),
      mutate: (row) => ({ ...row, name: `${String(row['name'])} (edited)` }),
      invalidRow: () => ({ id: newId(), name: '', done: false }),
    },
  },
  appendOnly: {
    table: 'events',
    fixture: {
      validRow: () => ({ id: newId(), note: 'happened' }),
      mutate: (row) => ({ ...row, note: 'rewritten' }),
    },
  },
});

describe('appendOnly tables', () => {
  const setup = () => {
    const engine = createSyncEngine({
      store: createMemoryStore(),
      tables: { events: { appendOnly: true } },
    });
    return engine.as('scope-a');
  };
  const pull = async (h: ReturnType<typeof setup>) => {
    const result = await h.pull({
      cursor: null,
      schemaVersion: 1,
      migration: null,
    });
    if (!('cursor' in result)) throw new Error('unexpected resync');
    return result;
  };
  const eventsWith = (
    created: { id: string; rating: number }[],
    updated: { id: string; rating: number }[] = [],
    deleted: string[] = [],
  ) => ({ events: { created, updated, deleted } });

  it('rejects a write to an existing id and keeps the stored content', async () => {
    const handlers = setup();
    const start = await pull(handlers);
    await handlers.push({
      changes: eventsWith([{ id: 'e1', rating: 3 }]),
      cursor: start.cursor,
    });
    const seeded = await pull(handlers);

    const result = await handlers.push({
      changes: eventsWith([], [{ id: 'e1', rating: 1 }]),
      cursor: seeded.cursor,
    });

    expect(result).not.toHaveProperty('conflict');
    expect(
      (result as { rejected?: Record<string, readonly string[]> }).rejected
        ?.events,
    ).toEqual(['e1']);
    const state = await pull(handlers);
    expect(state.changes['events']?.updated).toEqual([
      expect.objectContaining({ id: 'e1', rating: 3 }),
    ]);
  });

  it('still allows new rows and deletes', async () => {
    const handlers = setup();
    const start = await pull(handlers);
    await handlers.push({
      changes: eventsWith([{ id: 'e1', rating: 3 }]),
      cursor: start.cursor,
    });
    const seeded = await pull(handlers);

    const result = await handlers.push({
      changes: eventsWith([{ id: 'e2', rating: 4 }], [], ['e1']),
      cursor: seeded.cursor,
    });

    expect(result).not.toHaveProperty('conflict');
    expect(
      (result as { rejected?: Record<string, readonly string[]> }).rejected,
    ).toBeUndefined();
    const state = await pull(handlers);
    expect(state.changes['events']?.updated).toEqual([
      expect.objectContaining({ id: 'e2', rating: 4 }),
    ]);
    expect(state.changes['events']?.deleted).toEqual(['e1']);
  });
});

// #8: crossValidateChanges sees the full proposed change set — rows AND
// deletions — so referential rules can reject a delete, which the old
// rows-only crossValidate could never inspect.
describe('cross-change validation', () => {
  const setup = (
    hooks: Partial<
      Pick<
        Parameters<typeof createSyncEngine>[0],
        'crossValidate' | 'crossValidateChanges'
      >
    >,
  ) => {
    const engine = createSyncEngine({
      store: createMemoryStore(),
      tables: { decks: {}, cards: {} },
      ...hooks,
    });
    return engine.as('scope-a');
  };
  const pull = async (h: ReturnType<typeof setup>) => {
    const result = await h.pull({
      cursor: null,
      schemaVersion: 1,
      migration: null,
    });
    if (!('cursor' in result)) throw new Error('unexpected resync');
    return result;
  };
  type Part = Partial<{
    created: Record<string, unknown>[];
    deleted: string[];
  }>;
  const changes = (spec: { decks?: Part; cards?: Part }) =>
    Object.fromEntries(
      Object.entries(spec).map(([table, part]) => [
        table,
        { created: [], updated: [], deleted: [], ...part },
      ]),
    );

  it('rejects a deletion that would orphan children', async () => {
    const handlers = setup({
      crossValidateChanges: async (tx, scope, proposed) => {
        const rejectedDecks: string[] = [];
        for (const deckId of proposed['decks']?.deleted ?? []) {
          const survivors = await tx.currentRevs('cards', scope, ['c1']);
          const deletingCards = new Set(proposed['cards']?.deleted ?? []);
          if (survivors.size > 0 && !deletingCards.has('c1')) {
            rejectedDecks.push(deckId);
          }
        }
        return { decks: rejectedDecks };
      },
    });
    const start = await pull(handlers);
    await handlers.push({
      changes: changes({
        decks: { created: [{ id: 'd1', title: 'deck' }] },
        cards: { created: [{ id: 'c1', deck_id: 'd1' }] },
      }),
      cursor: start.cursor,
    });
    const seeded = await pull(handlers);

    // deleting the deck while its card survives: rejected, nothing applied
    const result = await handlers.push({
      changes: changes({ decks: { deleted: ['d1'] } }),
      cursor: seeded.cursor,
    });
    expect(result).not.toHaveProperty('conflict');
    expect(
      (result as { rejected?: Record<string, readonly string[]> }).rejected
        ?.decks,
    ).toEqual(['d1']);
    const state = await pull(handlers);
    expect(state.changes['decks']?.updated).toEqual([
      expect.objectContaining({ id: 'd1' }),
    ]);
    expect(state.changes['decks']?.deleted).toEqual([]);

    // deleting deck and card together satisfies the rule and applies
    const cascade = await handlers.push({
      changes: changes({
        decks: { deleted: ['d1'] },
        cards: { deleted: ['c1'] },
      }),
      cursor: state.cursor,
    });
    expect(cascade).not.toHaveProperty('conflict');
    expect((cascade as { rejected?: object }).rejected).toBeUndefined();
    const after = await pull(handlers);
    expect(after.changes['decks']?.deleted).toEqual(['d1']);
    expect(after.changes['cards']?.deleted).toEqual(['c1']);
  });

  it('rejects an upsert by id, same as the legacy hook', async () => {
    const handlers = setup({
      crossValidateChanges: async (_tx, _scope, proposed) => ({
        cards: (proposed['cards']?.rows ?? [])
          .filter((row) => row['deck_id'] === 'missing')
          .map((row) => row.id),
      }),
    });
    const start = await pull(handlers);
    const result = await handlers.push({
      changes: changes({
        cards: { created: [{ id: 'c1', deck_id: 'missing' }] },
      }),
      cursor: start.cursor,
    });
    expect(
      (result as { rejected?: Record<string, readonly string[]> }).rejected
        ?.cards,
    ).toEqual(['c1']);
    const state = await pull(handlers);
    expect(state.changes['cards']?.updated).toEqual([]);
  });

  it('legacy crossValidate keeps working alongside the new hook', async () => {
    const handlers = setup({
      crossValidate: async (_tx, _scope, rows) => ({
        cards: (rows['cards'] ?? []).map((row) => row.id),
      }),
      crossValidateChanges: async (_tx, _scope, proposed) => ({
        decks: proposed['decks']?.deleted ?? [],
      }),
    });
    const start = await pull(handlers);
    await handlers.push({
      changes: changes({ decks: { created: [{ id: 'd1', title: 't' }] } }),
      cursor: start.cursor,
    });
    const seeded = await pull(handlers);

    const result = await handlers.push({
      changes: changes({
        decks: { deleted: ['d1'] },
        cards: { created: [{ id: 'c1', deck_id: 'd1' }] },
      }),
      cursor: seeded.cursor,
    });
    const rejected = (
      result as { rejected?: Record<string, readonly string[]> }
    ).rejected;
    expect(rejected?.cards).toEqual(['c1']);
    expect(rejected?.decks).toEqual(['d1']);
  });
});

describe('push pipeline guards', () => {
  const changes = {
    tasks: {
      created: [{ id: 't1', name: 'task' }],
      updated: [],
      deleted: [],
    },
  };

  it('rejects a cursor beyond the scope horizon', async () => {
    const handlers = createSyncEngine({
      store: createMemoryStore(),
      tables: { tasks: {} },
    }).as('scope-a');

    expect(await handlers.push({ changes, cursor: '999' })).toEqual({
      conflict: true,
    });
  });

  it.each([
    {
      name: 'unknown table',
      rejected: { ghosts: ['t1'] },
    },
    {
      name: 'id absent from the request',
      rejected: { tasks: ['other'] },
    },
  ])('throws when a hook rejects an $name', async ({ rejected }) => {
    const handlers = createSyncEngine({
      store: createMemoryStore(),
      tables: { tasks: {} },
      crossValidate: async () => rejected,
    }).as('scope-a');

    await expect(handlers.push({ changes, cursor: '0' })).rejects.toMatchObject(
      {
        name: 'SyncProtocolError',
        code: 'invalid-rejection',
      } satisfies Partial<SyncProtocolError>,
    );
  });

  it('degrades when gc advances while the interleave is collected', async () => {
    let floor = 0;
    const store: SyncStore<string> = {
      transaction: async (_scope, _mode, work) =>
        work({
          changedSince: async () => {
            floor = 1;
            return [];
          },
          maxRev: async () => 1,
          currentRevs: async () => new Map(),
          foreignIds: async () => [],
          tombstonedIds: async () => [],
          upsert: async () => undefined,
          tombstone: async () => undefined,
          gcFloor: async () => floor,
        }),
    };
    const handlers = createSyncEngine({
      store,
      tables: { tasks: {} },
    }).as('scope-a');

    expect(await handlers.push({ changes: {}, cursor: '0' })).toEqual({
      cursor: null,
      changes: null,
    });
  });
});
