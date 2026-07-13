/**
 * A Query pairs a Collection with a QueryDescription and offers fetch and
 * the two observation strategies (docs/architecture-layers.md, decision 6):
 *
 * - simple: flat single-table queries (canEncodeMatcher) re-check membership
 *   in memory via the matcher on each collection change — no re-query.
 *   Emits on membership changes only.
 * - reloading: everything else re-fetches when any of the query's tables
 *   change, and emits when the result list actually differs (record
 *   identity — the cache guarantees stable instances).
 */
import { encodeQuery } from '../query/encodeQuery'
import type { QueryDescription } from '../query/ast'
import { canEncodeMatcher, encodeMatcher } from '../observation/encodeMatcher'
import type { RawRecord } from '../rawRecord/index'
import type {
  Collection,
  CollectionChangeSet,
  Unsubscribe,
} from './Collection'

const identicalArrays = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index])

export class Query {
  constructor(
    readonly collection: Collection,
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

  async fetch(): Promise<RawRecord[]> {
    const { database, schema } = this.collection
    const [sql, args] = encodeQuery({
      table: this.collection.table,
      description: this.description,
      associations: database.associations,
    })
    const rows = await database.driver.query(sql, args)
    return rows.map((row) => this.collection.cache.recordFromRow(row, schema))
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
  observe(subscriber: (records: RawRecord[]) => void): Unsubscribe {
    return canEncodeMatcher(this.description)
      ? this.observeSimple(subscriber)
      : this.observeReloading(subscriber)
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

  private observeSimple(subscriber: (records: RawRecord[]) => void): Unsubscribe {
    const matcher = encodeMatcher(this.description)
    let unsubscribed = false
    let records: RawRecord[] | null = null // null until the initial fetch
    let buffered: CollectionChangeSet[] = []

    const processChangeSet = (changes: CollectionChangeSet): boolean => {
      let changed = false
      for (const { record, type } of changes) {
        const index = records!.indexOf(record)
        const belongs = type !== 'destroyed' && matcher(record)
        if (index >= 0 && !belongs) {
          records!.splice(index, 1)
          changed = true
        } else if (index < 0 && belongs) {
          records!.push(record)
          changed = true
        }
      }
      return changed
    }

    // Subscribe before the initial fetch and buffer changes so nothing
    // committed during the fetch is missed.
    const unsubscribe = this.collection.onChange((changes) => {
      if (unsubscribed) {
        return
      }
      if (records === null) {
        buffered.push(changes)
        return
      }
      if (processChangeSet(changes)) {
        subscriber([...records!])
      }
    })

    void this.fetch().then((initial) => {
      if (unsubscribed) {
        return
      }
      records = initial
      for (const changes of buffered) {
        processChangeSet(changes)
      }
      buffered = []
      subscriber([...records])
    })

    return () => {
      unsubscribed = true
      unsubscribe()
    }
  }

  private observeReloading(
    subscriber: (records: RawRecord[]) => void,
  ): Unsubscribe {
    let unsubscribed = false
    let previous: RawRecord[] | null = null
    let generation = 0

    const refetch = () => {
      const current = ++generation
      void this.fetch().then((records) => {
        if (unsubscribed || current !== generation) {
          return
        }
        if (previous !== null && identicalArrays(previous, records)) {
          return
        }
        previous = records
        subscriber([...records])
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
