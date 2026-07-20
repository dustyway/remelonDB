/**
 * A Query pairs a Collection with a QueryDescription and offers fetch and
 * one observation strategy (docs/architecture-layers.md, decision 6):
 * re-fetch when any of the query's tables change, emit when the result
 * list actually differs — by membership, order, or the content of visible
 * columns. Identity alone can't detect content edits (the cache mutates
 * raws in place, so a refetch returns the same instances), which is why
 * each emission keeps a column snapshot to compare against. Bookkeeping
 * changes (_status/_changed, e.g. sync marking records synced) don't count.
 */
import { encodeQuery } from '../query/encodeQuery'
import type { QueryDescription } from '../query/ast'
import type { RawRecord } from '../rawRecord/index'
import type { Collection, Unsubscribe } from './Collection'

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
    ]
  }

  /** Raw-level fetch — the engine path (observation internals, sync). */
  async fetchRaws(): Promise<RawRecord[]> {
    const { database, schema } = this.collection
    const [sql, args] = encodeQuery({
      table: this.collection.table,
      description: this.description,
      associations: database.associations,
    })
    const rows = await database.driver.query(sql, args)
    return rows.map((row) => this.collection.cache.recordFromRow(row, schema))
  }

  async fetch(): Promise<M[]> {
    return (await this.fetchRaws()).map((raw) => this.collection._recordFor(raw))
  }

  async fetchCount(): Promise<number> {
    const { database } = this.collection
    const [sql, args] = encodeQuery(
      {
        table: this.collection.table,
        description: this.description,
        associations: database.associations,
      },
      { mode: 'count' },
    )
    const count = (await database.driver.query(sql, args))[0]?.['count']
    return typeof count === 'number' ? count : 0
  }

  /**
   * Observe the result list. Emits once with the initial results, then on
   * every relevant change. The emitted array is a fresh copy; the records
   * inside are the canonical cached instances.
   */
  observe(subscriber: (records: M[]) => void): Unsubscribe {
    const columns = ['id', ...Object.keys(this.collection.schema.columns)]
    let unsubscribed = false
    let previous: { raw: RawRecord; content: RawRecord }[] | null = null
    let generation = 0

    const differs = (records: readonly RawRecord[]): boolean => {
      if (previous === null || previous.length !== records.length) {
        return true
      }
      return records.some((raw, index) => {
        const before = previous![index]!
        return (
          before.raw !== raw ||
          columns.some((name) => before.content[name] !== raw[name])
        )
      })
    }

    const refetch = () => {
      const current = ++generation
      void this.fetchRaws().then((records) => {
        if (unsubscribed || current !== generation) {
          return
        }
        if (!differs(records)) {
          return
        }
        previous = records.map((raw) => ({ raw, content: { ...raw } }))
        subscriber(records.map((raw) => this.collection._recordFor(raw)))
      })
    }

    const unsubscribe = this.collection.database.onChange(this.allTables, refetch)
    refetch()
    return () => {
      unsubscribed = true
      unsubscribe()
    }
  }

  /** Observe the result count. Emits initially and whenever it changes. */
  observeCount(subscriber: (count: number) => void): Unsubscribe {
    let unsubscribed = false
    let previous: number | null = null
    let generation = 0

    const refetch = () => {
      const current = ++generation
      void this.fetchCount().then((count) => {
        if (unsubscribed || current !== generation || count === previous) {
          return
        }
        previous = count
        subscriber(count)
      })
    }

    const unsubscribe = this.collection.database.onChange(this.allTables, refetch)
    refetch()
    return () => {
      unsubscribed = true
      unsubscribe()
    }
  }

}
