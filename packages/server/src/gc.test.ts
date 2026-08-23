import { describe, expect, it } from 'vitest';
import type { SyncChanges } from '@remelondb/core';
import { pulled } from './conformance/index';
import { createMemoryStore } from './memoryStore';
import { createSyncEngine } from './engine';

// The floor path (docs/sync-wire.md degrade obligation) exercised
// against the reference store: pruning may drop a scope's live max
// below the floor, and a quiet scope's max may never reach it — neither
// may strand a client in resync.
const pull = (cursor: string | null) => ({
  cursor,
  schemaVersion: 1,
  migration: null,
});
const rows = (changes: SyncChanges): string[] => {
  const set = changes['tasks'] ?? { created: [], updated: [], deleted: [] };
  return [...set.created, ...set.updated].map((row) => String(row['id']));
};

describe('gc floor semantics', () => {
  it('serves the floor, degrades below it, and never strands a scope', async () => {
    const store = createMemoryStore();
    const engine = createSyncEngine({ store, tables: { tasks: {} } });
    const h = engine.as('scope-a');

    const empty = pulled(await h.pull(pull(null)));
    await h.push({
      changes: {
        tasks: {
          created: [
            { id: 'keep', name: 'keep' },
            { id: 'gone', name: 'gone' },
          ],
          updated: [],
          deleted: [],
        },
      },
      cursor: empty.cursor,
    });
    const seeded = pulled(await h.pull(pull(null)));
    await h.push({
      changes: { tasks: { created: [], updated: [], deleted: ['gone'] } },
      cursor: seeded.cursor,
    });
    const synced = pulled(await h.pull(pull(seeded.cursor)));
    expect(synced.changes['tasks']?.deleted).toContain('gone');

    store.gc(Number(synced.cursor));

    // below the floor: the pruned deletion is gone from the window
    expect(await h.pull(pull(seeded.cursor))).toHaveProperty('resyncRequired');
    // at the floor: still served, even though the scope's live max
    // (the pruned tombstone held it) now sits below the floor
    pulled(await h.pull(pull(synced.cursor)));
    // the full pull a resync depends on is served and converges
    const rebuilt = pulled(await h.pull(pull(null)));
    expect(rows(rebuilt.changes)).toEqual(['keep']);
    expect(Number(rebuilt.cursor)).toBeGreaterThanOrEqual(
      Number(synced.cursor),
    );

    // a quiet scope that never wrote is not stranded below the floor:
    // its first pull's cursor starts at the floor and stays servable
    const quiet = engine.as('scope-b');
    const first = pulled(await quiet.pull(pull(null)));
    expect(Number(first.cursor)).toBeGreaterThanOrEqual(Number(synced.cursor));
    pulled(await quiet.pull(pull(first.cursor)));
  });
});
