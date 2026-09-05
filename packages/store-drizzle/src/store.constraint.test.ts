import { describe, expect, it } from 'vitest';
import { createSyncEngine } from '@remelondb/server';
import { accepted, pulled } from '@remelondb/server/conformance';
import { freshDb, profiles } from './fixture';
import { createDrizzleStore } from './store';

/**
 * A database constraint refusing a row (unique handle here) is a content
 * refusal the wire contract owes the client as a per-record rejection:
 * never a thrown 500, never a poisoned transaction, and never a client
 * whose sync wedges on retry (dustyway/remelonDB#16).
 */

const pullArgs = { cursor: null, schemaVersion: 1, migration: null };

const makeEngine = async () => {
  const { db } = await freshDb();
  const store = createDrizzleStore<string>({
    db,
    tables: {
      profiles: {
        table: profiles,
        id: profiles.id,
        rev: profiles.rev,
        deletedAt: profiles.deletedAt,
        scope: profiles.owner,
        scrub: { handle: null },
      },
    },
  });
  return createSyncEngine({
    store,
    tables: { profiles: { validate: () => true } },
  });
};

const profileChanges = (
  rows: readonly { id: string; handle: string | null }[],
) => ({
  profiles: { created: [], updated: [...rows], deleted: [] },
});

describe('constraint violations surface as per-record rejections', () => {
  it('rejects the colliding row, applies the rest, and lets the client recover', async () => {
    const engine = await makeEngine();
    const userA = engine.as('scope-a');
    const userB = engine.as('scope-b');

    const startA = pulled(await userA.pull(pullArgs));
    accepted(
      await userA.push({
        cursor: startA.cursor,
        changes: profileChanges([{ id: 'a1', handle: 'zorro' }]),
      }),
    );

    // B pushes one colliding row and one clean row in the same batch
    const startB = pulled(await userB.pull(pullArgs));
    const result = accepted(
      await userB.push({
        cursor: startB.cursor,
        changes: profileChanges([
          { id: 'b1', handle: 'zorro' },
          { id: 'b2', handle: 'other' },
        ]),
      }),
    );

    // the collision is a rejection, not a throw; the clean row applied
    expect(result.rejected?.profiles).toEqual(['b1']);
    const afterB = pulled(await userB.pull(pullArgs));
    const applied = afterB.changes.profiles?.updated.map((r) => r.id) ?? [];
    expect(applied).toContain('b2');
    expect(applied).not.toContain('b1');

    // the transaction survived: the same push already wrote b2 and issued
    // a cursor, and the next push with a free handle goes through
    const recovered = accepted(
      await userB.push({
        cursor: result.cursor!,
        changes: profileChanges([{ id: 'b1', handle: 'fresh' }]),
      }),
    );
    expect(recovered.rejected?.profiles ?? []).toEqual([]);

    // A's original row is untouched throughout
    const afterA = pulled(await userA.pull(pullArgs));
    const aRows = afterA.changes.profiles?.updated ?? [];
    expect(aRows).toEqual([
      expect.objectContaining({ id: 'a1', handle: 'zorro' }),
    ]);
  });

  it('null handles never collide, and re-pushing your own handle is not a refusal', async () => {
    const engine = await makeEngine();
    const userA = engine.as('scope-a');
    const userB = engine.as('scope-b');

    const startA = pulled(await userA.pull(pullArgs));
    accepted(
      await userA.push({
        cursor: startA.cursor,
        changes: profileChanges([{ id: 'a1', handle: null }]),
      }),
    );
    const startB = pulled(await userB.pull(pullArgs));
    const bothNull = accepted(
      await userB.push({
        cursor: startB.cursor,
        changes: profileChanges([{ id: 'b1', handle: null }]),
      }),
    );
    expect(bothNull.rejected?.profiles ?? []).toEqual([]);

    // updating your own row keeps its handle: upsert on the same id is an
    // update, not a second insert, so no self-collision
    const currentA = pulled(await userA.pull(pullArgs));
    const named = accepted(
      await userA.push({
        cursor: currentA.cursor,
        changes: profileChanges([{ id: 'a1', handle: 'kept' }]),
      }),
    );
    const again = accepted(
      await userA.push({
        cursor: named.cursor!,
        changes: profileChanges([{ id: 'a1', handle: 'kept' }]),
      }),
    );
    expect(again.rejected?.profiles ?? []).toEqual([]);
  });
});
