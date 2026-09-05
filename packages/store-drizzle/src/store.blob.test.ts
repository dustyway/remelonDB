import { describe, expect, it } from 'vitest';
import { createSyncEngine } from '@remelondb/server';
import { accepted, pulled } from '@remelondb/server/conformance';
import { assets, freshDb } from './fixture';
import { createDrizzleStore } from './store';

describe('blob storage', () => {
  it('round-trips Uint8Array through PostgreSQL bytea', async () => {
    const { db } = await freshDb();
    const store = createDrizzleStore<string>({
      db,
      tables: {
        assets: {
          table: assets,
          id: assets.id,
          rev: assets.rev,
          deletedAt: assets.deletedAt,
          scope: assets.owner,
        },
      },
    });
    const handlers = createSyncEngine({
      store,
      tables: { assets: { validate: () => true } },
    }).as('scope-a');
    const start = pulled(
      await handlers.pull({ cursor: null, schemaVersion: 1, migration: null }),
    );

    accepted(
      await handlers.push({
        cursor: start.cursor,
        changes: {
          assets: {
            created: [
              {
                id: 'a1',
                data: new Uint8Array([0, 127, 255]),
                preview: null,
              },
            ],
            updated: [],
            deleted: [],
          },
        },
      }),
    );

    const result = pulled(
      await handlers.pull({ cursor: null, schemaVersion: 1, migration: null }),
    );
    expect(result.changes.assets?.updated).toEqual([
      {
        id: 'a1',
        data: new Uint8Array([0, 127, 255]),
        preview: null,
      },
    ]);
  });
});
