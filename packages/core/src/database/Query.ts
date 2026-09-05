/**
 * A Query pairs a Collection with a QueryDescription and offers fetch and
 * one observation strategy (docs/layers.md, decision 6):
 * re-fetch when any of the query's tables change, emit when the result
 * list actually differs — by membership, order, or the content of visible
 * columns. Identity alone can't detect content edits (the cache mutates
 * raws in place, so a refetch returns the same instances), which is why
 * each emission keeps a column snapshot to compare against. Bookkeeping
 * changes (_status/_changed, e.g. sync marking records synced) don't count.
 */
import { encodeQuery } from '../query/encodeQuery';
import type { QueryDescription } from '../query/ast';
import { areValuesEqual, type RawRecord } from '../rawRecord/index';
import { runDirect } from './directWork';
import type { Collection, Unsubscribe } from './Collection';

/**
 * A fetchable, observable query — a Collection plus Q clauses. Get one
 * from `collection.query(...)`; call `fetch()` for a one-shot read or
 * `observe(cb)` to be called with results on every relevant change.
 * @category Database & queries
 */
export class Query<M = RawRecord> {
  constructor(
    readonly collection: Collection<M>,
    readonly description: QueryDescription,
  ) {}

  /** All tables this query depends on (for reload-on-change observation). */
  get allTables(): string[] {
    return [
      this.collection.table,
      ...this.description.joinTables,
      ...this.description.nestedJoinTables.map((join) => join.to),
    ];
  }

  /** Raw-level fetch — the engine path (observation internals, sync). */
  async fetchRaws(): Promise<RawRecord[]> {
    const { database, schema } = this.collection;
    const [sql, args] = encodeQuery({
      table: this.collection.table,
      description: this.description,
      associations: database.associations,
    });
    // The driver call, not the whole method: this is the observation hot
    // path, and wrapping the record mapping too puts extra microtask
    // hops in every re-fetch. Closing waits for the query itself, which
    // is the part that must not outlive the handle.
    const rows = await runDirect(database, () =>
      database.driver.query(sql, args),
    );
    return rows.map((row) => this.collection.cache.recordFromRow(row, schema));
  }

  async fetch(): Promise<M[]> {
    return (await this.fetchRaws()).map((raw) =>
      this.collection._recordFor(raw),
    );
  }

  async fetchCount(): Promise<number> {
    const { database } = this.collection;
    const [sql, args] = encodeQuery(
      {
        table: this.collection.table,
        description: this.description,
        associations: database.associations,
      },
      { mode: 'count' },
    );
    const rows = await runDirect(database, () =>
      database.driver.query(sql, args),
    );
    const count = rows[0]?.['count'];
    return typeof count === 'number' ? count : 0;
  }

  /**
   * Observe the result list. Emits once with the initial results, then on
   * every relevant change. The emitted array is a fresh copy; the records
   * inside are the canonical cached instances.
   */
  observe(
    subscriber: (records: M[]) => void,
    onError?: (error: Error) => void,
  ): Unsubscribe {
    const columns = ['id', ...Object.keys(this.collection.schema.columns)];
    let unsubscribed = false;
    let previous: { raw: RawRecord; content: RawRecord }[] | null = null;
    let generation = 0;
    const diagnostics = this.collection.database.onObservation;

    const report = (
      started: number,
      trigger: 'initial' | 'change',
      outcome: 'success' | 'error' | 'discarded',
      resultCount?: number,
      error?: Error,
    ) => {
      if (!diagnostics) return;
      try {
        diagnostics({
          kind: 'records',
          trigger,
          outcome,
          table: this.collection.table,
          description: this.description,
          durationMs: Date.now() - started,
          ...(resultCount === undefined ? {} : { resultCount }),
          ...(error ? { error } : {}),
        });
      } catch {
        // Diagnostics are passive and must never affect query behavior.
      }
    };

    const differs = (records: readonly RawRecord[]): boolean => {
      const snapshot = previous;
      if (snapshot === null || snapshot.length !== records.length) {
        return true;
      }
      return records.some((raw, index) => {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- the lengths were just compared equal.
        const before = snapshot[index]!;
        return (
          before.raw !== raw ||
          columns.some(
            (name) =>
              !areValuesEqual(before.content[name] ?? null, raw[name] ?? null),
          )
        );
      });
    };

    const refetch = (trigger: 'initial' | 'change') => {
      const current = ++generation;
      const started = diagnostics ? Date.now() : 0;
      // Two-argument then: the failure handler sees only fetch rejections.
      // A subscriber that throws is an app bug and stays a loud unhandled
      // rejection rather than masquerading as a query error.
      void this.fetchRaws().then(
        (records) => {
          if (unsubscribed || current !== generation) {
            report(started, trigger, 'discarded');
            return;
          }
          report(started, trigger, 'success', records.length);
          if (!differs(records)) {
            return;
          }
          previous = records.map((raw) => ({ raw, content: { ...raw } }));
          subscriber(records.map((raw) => this.collection._recordFor(raw)));
        },
        (cause: unknown) => {
          if (unsubscribed || current !== generation) {
            report(started, trigger, 'discarded');
            return;
          }
          const error =
            cause instanceof Error ? cause : new Error(String(cause));
          report(started, trigger, 'error', undefined, error);
          if (onError) {
            onError(error);
            return;
          }
          // Reject the ignored .then promise. This stays an unhandled
          // rejection, while discarded observations returned above stay quiet.
          throw error;
        },
      );
    };

    const unsubscribe = this.collection.database.onChange(
      this.allTables,
      () => {
        refetch('change');
      },
    );
    refetch('initial');
    return () => {
      unsubscribed = true;
      unsubscribe();
    };
  }

  /** Observe the result count. Emits initially and whenever it changes. */
  observeCount(
    subscriber: (count: number) => void,
    onError?: (error: Error) => void,
  ): Unsubscribe {
    let unsubscribed = false;
    let previous: number | null = null;
    let generation = 0;
    const diagnostics = this.collection.database.onObservation;

    const report = (
      started: number,
      trigger: 'initial' | 'change',
      outcome: 'success' | 'error' | 'discarded',
      resultCount?: number,
      error?: Error,
    ) => {
      if (!diagnostics) return;
      try {
        diagnostics({
          kind: 'count',
          trigger,
          outcome,
          table: this.collection.table,
          description: this.description,
          durationMs: Date.now() - started,
          ...(resultCount === undefined ? {} : { resultCount }),
          ...(error ? { error } : {}),
        });
      } catch {
        // Diagnostics are passive and must never affect query behavior.
      }
    };

    const refetch = (trigger: 'initial' | 'change') => {
      const current = ++generation;
      const started = diagnostics ? Date.now() : 0;
      // Two-argument then, for the same reason as observe(): only fetch
      // rejections reach the failure handler, never subscriber throws.
      void this.fetchCount().then(
        (count) => {
          if (unsubscribed || current !== generation) {
            report(started, trigger, 'discarded');
            return;
          }
          report(started, trigger, 'success', count);
          if (count === previous) {
            return;
          }
          previous = count;
          subscriber(count);
        },
        (cause: unknown) => {
          if (unsubscribed || current !== generation) {
            report(started, trigger, 'discarded');
            return;
          }
          const error =
            cause instanceof Error ? cause : new Error(String(cause));
          report(started, trigger, 'error', undefined, error);
          if (onError) {
            onError(error);
            return;
          }
          // Same contract as observe(): live failures stay unhandled
          // rejections, while discarded observations stay quiet.
          throw error;
        },
      );
    };

    const unsubscribe = this.collection.database.onChange(
      this.allTables,
      () => {
        refetch('change');
      },
    );
    refetch('initial');
    return () => {
      unsubscribed = true;
      unsubscribe();
    };
  }
}
