// @vitest-environment jsdom
/**
 * The react bindings over a real database on real SQLite — the one
 * place the hooks meet actual Query objects instead of fakes. Pins the
 * structural surface the hooks read (query.description,
 * query.collection.schema.name, query.collection.database): if core
 * reshapes any of it, this fails while the fake-based tests stay green.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { appSchema, Database, Q, column as c, table } from '@remelondb/core';
import { useQuery, useQueryCount } from '@remelondb/core/react';
import { NodeSqliteDriver } from './NodeSqliteDriver';

const schema = appSchema({
  version: 1,
  tables: [
    table('tasks', {
      name: c.string(),
      position: c.number().indexed(),
      is_done: c.boolean(),
    }),
  ],
});

describe('react bindings over a real database', () => {
  let driver: NodeSqliteDriver;
  let db: Database;

  beforeEach(async () => {
    driver = new NodeSqliteDriver();
    db = await Database.open({ driver, schema, name: ':memory:' });
  });

  afterEach(async () => {
    await driver.destroy().catch(() => {});
  });

  it('renders live results and re-renders on writes', async () => {
    const query = () =>
      db.get('tasks').query(Q.where('is_done', false), Q.sortBy('position'));

    const { result } = renderHook(() => useQuery(query()));
    expect(result.current.isLoading).toBe(true);

    await act(() =>
      db.write(() =>
        db.get('tasks').create({ name: 'a', position: 1, is_done: false }),
      ),
    );
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data.map((r) => r.name)).toEqual(['a']);

    await act(() =>
      db.write(() =>
        db.get('tasks').create({ name: 'b', position: 0, is_done: false }),
      ),
    );
    expect(result.current.data.map((r) => r.name)).toEqual(['b', 'a']);
  });

  it('reuses the subscription across structurally equal rebuilds', async () => {
    await db.write(() =>
      db.get('tasks').create({ name: 'a', position: 1, is_done: false }),
    );

    const make = () => db.get('tasks').query(Q.where('is_done', false));
    const first = make();
    const { result, rerender } = renderHook(({ q }) => useQuery(q), {
      initialProps: { q: first },
    });
    await act(async () => {});
    expect(result.current.data).toHaveLength(1);

    // a rebuilt equivalent query must not observe anew
    const rebuilt = make();
    const observeSpy = vi.spyOn(rebuilt, 'observe');
    rerender({ q: rebuilt });
    expect(observeSpy).not.toHaveBeenCalled();
    expect(result.current.data).toHaveLength(1);

    // a structurally different query resubscribes and refetches
    rerender({ q: db.get('tasks').query(Q.where('is_done', true)) });
    await act(async () => {});
    expect(result.current.data).toHaveLength(0);
  });

  it('tracks counts through the count observation', async () => {
    const { result } = renderHook(() =>
      useQueryCount(db.get('tasks').query(Q.where('is_done', false))),
    );
    await act(async () => {});
    expect(result.current).toBe(0);

    await act(() =>
      db.write(() =>
        db.get('tasks').create({ name: 'a', position: 1, is_done: false }),
      ),
    );
    expect(result.current).toBe(1);
  });
});
