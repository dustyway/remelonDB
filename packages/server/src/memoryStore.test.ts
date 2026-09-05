import { describe, expect, it } from 'vitest';
import { createSyncEngine } from './engine';
import { createMemoryStore } from './memoryStore';
import { accepted, pulled } from './conformance/index';

const pullArgs = { cursor: null, schemaVersion: 1, migration: null };
const push = (cursor: string, name: string) => ({
  cursor,
  changes: {
    tasks: {
      created: [] as Record<string, unknown>[],
      updated: [{ id: 'x', name }],
      deleted: [] as string[],
    },
  },
});

describe('memoryStore push serialization', () => {
  it('two concurrent pushes at one cursor: exactly one wins, one conflicts', async () => {
    const store = createMemoryStore();
    const handlers = createSyncEngine({
      store,
      tables: { tasks: { validate: () => true } },
    }).as('u1');
    const seed = accepted(
      await handlers.push({
        cursor: pulled(await handlers.pull(pullArgs)).cursor,
        changes: {
          tasks: {
            created: [{ id: 'x', name: 'v1' }],
            updated: [],
            deleted: [],
          },
        },
      }),
    );

    const cursor = seed.cursor;
    if (cursor === null) throw new Error('the seed push returned no cursor');

    const [a, b] = await Promise.all([
      handlers.push(push(cursor, 'from-A')),
      handlers.push(push(cursor, 'from-B')),
    ]);
    const conflicts = [a, b].filter((r) => 'conflict' in r);
    expect(conflicts).toHaveLength(1);

    const state = pulled(await handlers.pull(pullArgs));
    const winner = [a, b].find((r) => !('conflict' in r));
    const winnerName = winner === a ? 'from-A' : 'from-B';
    const tasksChanges = state.changes.tasks;
    expect(tasksChanges).toBeDefined();
    const rows = [
      ...(tasksChanges?.created ?? []),
      ...(tasksChanges?.updated ?? []),
    ];
    expect(rows).toEqual([
      expect.objectContaining({ id: 'x', name: winnerName }),
    ]);
  });

  it('cross-scope upsert never modifies another scope of the same id', async () => {
    const store = createMemoryStore();
    await store.transaction('victim', 'push', (tx) =>
      tx.upsert('tasks', 'victim', [{ id: 'secret-1', name: 'private' }]),
    );
    await store.transaction('attacker', 'push', (tx) =>
      tx.upsert('tasks', 'attacker', [{ id: 'secret-1', name: 'PWNED' }]),
    );
    const rows = await store.transaction('victim', 'pull', (tx) =>
      tx.changedSince('tasks', 'victim', 0),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.row).toMatchObject({ id: 'secret-1', name: 'private' });
  });
});

// A cursor is an opaque echo of a string the engine issued; anything
// else is unknown, not a number to coerce. `Number('')` is 0 (a full
// history replay) and `Number('0x10')` is 16 (a cursor never issued).
describe('cursor parsing', () => {
  it('refuses every spelling but the one it issued', async () => {
    const handlers = createSyncEngine({
      store: createMemoryStore(),
      tables: { tasks: { validate: () => true } },
    }).as('u1');
    let cursor = pulled(await handlers.pull(pullArgs)).cursor;
    // enough revisions that a coerced cursor lands inside the served
    // range instead of being refused for being out of it
    for (let i = 0; i < 20; i++) {
      const done = accepted(
        await handlers.push({
          cursor,
          changes: {
            tasks: {
              created: [{ id: `r${i}`, name: 'n' }],
              updated: [],
              deleted: [],
            },
          },
        }),
      );
      cursor = done.cursor ?? pulled(await handlers.pull(pullArgs)).cursor;
    }

    for (const bogus of [
      '',
      '  ',
      ` ${cursor}`,
      `${cursor} `,
      `0${cursor}`,
      `+${cursor}`,
      '0x10',
      Number(cursor).toExponential(),
      '-0',
      '9007199254740993',
    ]) {
      expect(
        await handlers.pull({
          cursor: bogus,
          schemaVersion: 1,
          migration: null,
        }),
      ).toEqual({ resyncRequired: true });
      expect(await handlers.push({ cursor: bogus, changes: {} })).toEqual({
        conflict: true,
      });
    }

    // the issued cursor itself still works
    expect(
      pulled(await handlers.pull({ cursor, schemaVersion: 1, migration: null }))
        .cursor,
    ).toBe(cursor);
  });
});
