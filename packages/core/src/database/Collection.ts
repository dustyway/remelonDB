/**
 * A Collection is the per-table API: CRUD (writer-gated), find with
 * identity-map semantics, query building, and per-table change
 * subscriptions. Records are RawRecords for now — the Model layer will
 * build on these primitives.
 */
import type { Clause } from '../query/ast'
import { buildQueryDescription } from '../query/Q'
import * as Q from '../query/Q'
import type { TableSchema } from '../schema/index'
import {
  markAsChanged,
  sanitizedRaw,
  setRawSanitized,
  type DirtyRaw,
  type RawRecord,
} from '../rawRecord/index'
import type { BatchOperation } from './encodeBatch'
import { Query } from './Query'
import { RecordCache } from './RecordCache'
import type { Database } from './Database'

export type ChangeType = 'created' | 'updated' | 'destroyed'

export interface CollectionChange {
  readonly record: RawRecord
  readonly type: ChangeType
}

export type CollectionChangeSet = readonly CollectionChange[]

export type Unsubscribe = () => void

export class Collection {
  readonly cache = new RecordCache()
  private subscribers: Array<(changes: CollectionChangeSet) => void> = []

  constructor(
    readonly database: Database,
    readonly schema: TableSchema,
  ) {}

  get table(): string {
    return this.schema.name
  }

  query(...clauses: Clause[]): Query {
    return new Query(this, buildQueryDescription(clauses))
  }

  /**
   * Fetch one record by id — the cached instance if present, else loaded
   * from the database. Throws if the record doesn't exist (or is deleted).
   */
  async find(id: string): Promise<RawRecord> {
    const cached = this.cache.get(id)
    if (cached) {
      return cached
    }
    const records = await this.query(Q.where('id', id)).fetch()
    const record = records[0]
    if (!record) {
      throw new Error(`Record '${this.table}/${id}' not found`)
    }
    return record
  }

  /** Build a create operation without committing it (for Database.batch). */
  prepareCreate(fields: DirtyRaw = {}): BatchOperation {
    const raw = sanitizedRaw(fields, this.schema)
    raw._status = 'created'
    raw._changed = ''
    return { type: 'create', table: this.table, raw }
  }

  /** Create and commit one record. Must be called inside database.write. */
  async create(fields: DirtyRaw = {}): Promise<RawRecord> {
    const operation = this.prepareCreate(fields)
    await this.database.batch([operation])
    return operation.raw
  }

  /**
   * Build an update operation: a modified copy of the record's raw, with
   * unknown columns rejected, values sanitized, and dirty tracking applied
   * only for values that actually changed. The cached instance is not
   * touched until the batch commits.
   */
  prepareUpdate(record: RawRecord, fields: DirtyRaw): BatchOperation {
    const updated: RawRecord = { ...record }
    for (const [key, value] of Object.entries(fields)) {
      const column = this.schema.columns[key]
      if (!column) {
        throw new Error(`Cannot update unknown column '${this.table}.${key}'`)
      }
      const before = updated[key]
      setRawSanitized(updated, value, column)
      if (updated[key] !== before) {
        markAsChanged(updated, key)
      }
    }
    return { type: 'update', table: this.table, raw: updated }
  }

  /** Update and commit one record. Must be called inside database.write. */
  async update(id: string, fields: DirtyRaw): Promise<RawRecord> {
    const record = await this.find(id)
    await this.database.batch([this.prepareUpdate(record, fields)])
    return record
  }

  /**
   * Mark a record as deleted (a sync tombstone: hidden from queries, kept
   * in the database until sync pushes the deletion). Must be inside write.
   */
  async markAsDeleted(id: string): Promise<void> {
    const record = await this.find(id)
    await this.database.batch([
      { type: 'markAsDeleted', table: this.table, raw: record },
    ])
  }

  /** Permanently delete a record's row. Must be called inside write. */
  async destroyPermanently(id: string): Promise<void> {
    const record = await this.find(id)
    await this.database.batch([
      { type: 'destroyPermanently', table: this.table, raw: record },
    ])
  }

  /** Subscribe to this table's committed changes. */
  onChange(subscriber: (changes: CollectionChangeSet) => void): Unsubscribe {
    this.subscribers.push(subscriber)
    return () => {
      const index = this.subscribers.indexOf(subscriber)
      if (index !== -1) {
        this.subscribers.splice(index, 1)
      }
    }
  }

  /** @internal Called by Database after a successful batch. */
  _notify(changes: CollectionChangeSet): void {
    for (const subscriber of [...this.subscribers]) {
      subscriber(changes)
    }
  }
}
