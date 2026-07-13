/**
 * The identity map (docs/architecture-layers.md, decision 1): one RawRecord
 * instance per record id, owned entirely by JS. Drivers always return full
 * rows; this cache decides whether an existing instance is reused — there is
 * no cross-boundary cache state to desync.
 *
 * Cached instances are authoritative and updated in place on commit, so
 * object identity is stable across updates (observers rely on this for
 * cheap change detection).
 */
import type { Row } from '../driver/SqliteDriver'
import type { TableSchema } from '../schema/index'
import { sanitizedRaw, type RawRecord } from '../rawRecord/index'

export class RecordCache {
  private map = new Map<string, RawRecord>()

  get(id: string): RawRecord | undefined {
    return this.map.get(id)
  }

  add(raw: RawRecord): void {
    this.map.set(raw.id, raw)
  }

  delete(id: string): void {
    this.map.delete(id)
  }

  clear(): void {
    this.map.clear()
  }

  /**
   * Resolve a driver row to the canonical record instance: the cached one
   * if it exists (its in-memory state is authoritative), else a freshly
   * sanitized raw that becomes the cached instance.
   */
  recordFromRow(row: Row, table: TableSchema): RawRecord {
    const id = row['id']
    if (typeof id !== 'string') {
      throw new Error(
        `RecordCache: row from '${table.name}' has no string id — queries must select full rows`,
      )
    }
    const cached = this.map.get(id)
    if (cached) {
      return cached
    }
    const raw = sanitizedRaw(row, table)
    this.map.set(id, raw)
    return raw
  }
}
