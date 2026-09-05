import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { createSyncEngine } from '@remelondb/server';
import { accepted, pulled } from '@remelondb/server/conformance';
import { assets, freshDb } from './fixture';
import { createDrizzleStore } from './store';
import { bytea } from './bytea';

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

const postgresUrl = process.env['REMELON_TEST_PG'];
const realPostgres = postgresUrl ? describe : describe.skip;
const postgresAssets = pgTable('blob_assets', {
  id: text('id').primaryKey(),
  data: bytea('data').notNull(),
  preview: bytea('preview'),
});

realPostgres('blob storage on real postgres', () => {
  it('normalizes node-postgres Buffer values to Uint8Array', async () => {
    const pool = new Pool({ connectionString: postgresUrl });
    try {
      await pool.query('drop table if exists blob_assets');
      await pool.query(
        'create table blob_assets (id text primary key, data bytea not null, preview bytea)',
      );
      const db = drizzle(pool);
      await db.insert(postgresAssets).values({
        id: 'a1',
        data: new Uint8Array([0, 127, 255]),
        preview: null,
      });

      expect(await db.select().from(postgresAssets)).toEqual([
        {
          id: 'a1',
          data: new Uint8Array([0, 127, 255]),
          preview: null,
        },
      ]);
    } finally {
      await pool.query('drop table if exists blob_assets');
      await pool.end();
    }
  });
});
