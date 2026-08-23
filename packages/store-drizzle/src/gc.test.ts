import { describe, expect, it } from 'vitest';
import type { SyncChanges } from '@remelondb/core';
import { createSyncEngine } from '@remelondb/server';
import { pulled } from '@remelondb/server/conformance';
import { freshDb, tasks } from './fixture';
import { createDrizzleStore } from './store';

const pullArgs = (cursor: string | null) => ({
  cursor,
  schemaVersion: 1,
  migration: null,
});
const created = (rows: Record<string, unknown>[]): SyncChanges =>
  ({
    tasks: { created: rows, updated: [], deleted: [] },
  }) as unknown as SyncChanges;
const deleted = (ids: string[]): SyncChanges =>
  ({
    tasks: { created: [], updated: [], deleted: ids },
  }) as unknown as SyncChanges;

describe('gc and scrub', () => {
  it('scrubs tombstoned content, prunes below the floor, degrades old cursors', async () => {
    const { client, db } = await freshDb();
    const store = createDrizzleStore<string>({
      db,
      tables: {
        tasks: {
          table: tasks,
          id: tasks.id,
          rev: tasks.rev,
          deletedAt: tasks.deletedAt,
          scope: tasks.owner,
          scrub: { name: '' },
        },
      },
    });
    const engine = createSyncEngine({ store, tables: { tasks: {} } });
    const h = engine.as('scope-a');

    const empty = pulled(await h.pull(pullArgs(null)));
    await h.push({
      changes: created([
        { id: 'keep', name: 'keep me', done: false },
        { id: 'gone', name: 'personal data', done: true },
      ]),
      cursor: empty.cursor,
    });
    const seeded = pulled(await h.pull(pullArgs(null)));
    await h.push({ changes: deleted(['gone']), cursor: seeded.cursor });

    // erasure is immediate: content scrubbed in the same stroke as the tombstone
    const scrubbed = await client.query<{ name: string; deleted_at: unknown }>(
      `select name, deleted_at from tasks where id = 'gone'`,
    );
    expect(scrubbed.rows[0]!.name).toBe('');
    expect(scrubbed.rows[0]!.deleted_at).not.toBeNull();

    // the deletion still syncs before gc
    const synced = pulled(await h.pull(pullArgs(seeded.cursor)));
    expect(synced.changes['tasks']?.deleted).toContain('gone');

    // gc prunes the tombstone and persists the floor
    await store.gc(Number(synced.cursor));
    const remaining = await client.query(`select id from tasks`);
    expect(remaining.rows.map((row) => (row as { id: string }).id)).toEqual([
      'keep',
    ]);

    // a cursor from before the floor degrades to resync...
    expect(await h.pull(pullArgs(seeded.cursor))).toHaveProperty(
      'resyncRequired',
    );
    // ...a cursor at the floor is still served incrementally
    pulled(await h.pull(pullArgs(synced.cursor)));
    // ...and a full re-pull converges without the deleted record
    const rebuilt = pulled(await h.pull(pullArgs(null)));
    const ids = [
      ...(rebuilt.changes['tasks']?.created ?? []),
      ...(rebuilt.changes['tasks']?.updated ?? []),
    ].map((row) => String(row['id']));
    expect(ids).toEqual(['keep']);

    // the floor never lowers
    await store.gc(1);
    expect(await h.pull(pullArgs(seeded.cursor))).toHaveProperty(
      'resyncRequired',
    );
  }, 20_000);
});
