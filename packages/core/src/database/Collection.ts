/**
 * A Collection is the per-table API: CRUD (writer-gated), find with
 * identity-map semantics, query building, and per-table change
 * subscriptions.
 *
 * The engine operates on RawRecords (the cache, batching, notifications,
 * sync). When a Model class is bound (Database.open modelClasses), the
 * public record type M becomes that model: fetch/find/create/update
 * return one cached Model instance per id, wrapping the cached raw.
 * Without a model class, M is RawRecord and records pass through as-is.
 */
import type { Clause } from '../query/ast'
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
import {
  defineModelAccessors,
  type Model,
  type ModelClass,
} from '../model/Model'

export type ChangeType = 'created' | 'updated' | 'destroyed'

export interface CollectionChange {
  readonly record: RawRecord
  readonly type: ChangeType
}

export type CollectionChangeSet = readonly CollectionChange[]

export type Unsubscribe = () => void

export class Collection<M = RawRecord> {
  readonly cache = new RecordCache()
  private subscribers: Array<(changes: CollectionChangeSet) => void> = []
  private modelClass: ModelClass | null = null
  private models = new Map<string, Model>()

  constructor(
    readonly database: Database,
    readonly schema: TableSchema,
  ) {}

  get table(): string {
    return this.schema.name
  }

  /** @internal Called by Database.open for each registered model class. */
  _bindModelClass(cls: ModelClass): void {
    defineModelAccessors(cls, this.schema.columnArray)
    this.modelClass = cls
    this.onChange((changes) => {
      for (const change of changes) {
        if (change.type === 'destroyed') {
          this.models.delete(change.record.id)
        }
      }
    })
  }

  /** @internal Raw → public record type (Model when bound, raw otherwise). */
  _recordFor(raw: RawRecord): M {
    if (!this.modelClass) {
      return raw as M
    }
    let model = this.models.get(raw.id)
    if (!model) {
      model = new this.modelClass(this as Collection<Model>, raw)
      this.models.set(raw.id, model)
    }
    return model as M
  }

  query(...clauses: Clause[]): Query<M> {
    return new Query(this, Q.buildQueryDescription(clauses))
  }

  /** @internal The cached raw for an id, loaded from storage if needed. */
  async _findRaw(id: string): Promise<RawRecord> {
    const cached = this.cache.get(id)
    if (cached) {
      return cached
    }
    const raws = await this.query(Q.where('id', id)).fetchRaws()
    const raw = raws[0]
    if (!raw) {
      throw new Error(`Record '${this.table}/${id}' not found`)
    }
    return raw
  }

  /**
   * Fetch one record by id — the cached instance if present, else loaded
   * from the database. Throws if the record doesn't exist (or is deleted).
   */
  async find(id: string): Promise<M> {
    return this._recordFor(await this._findRaw(id))
  }

  /** Build a create operation without committing it (for Database.batch). */
  prepareCreate(fields: DirtyRaw = {}): BatchOperation {
    const stamped: { [key: string]: unknown } = { ...fields }
    const now = Date.now()
    if (this.schema.columns['created_at'] && stamped['created_at'] === undefined) {
      stamped['created_at'] = now
    }
    if (this.schema.columns['updated_at'] && stamped['updated_at'] === undefined) {
      stamped['updated_at'] = now
    }
    const raw = sanitizedRaw(stamped, this.schema)
    raw._status = 'created'
    raw._changed = ''
    return { type: 'create', table: this.table, raw }
  }

  /** Create and commit one record. Must be called inside database.write. */
  async create(fields: DirtyRaw = {}): Promise<M> {
    const operation = this.prepareCreate(fields)
    await this.database.batch([operation])
    return this._recordFor(operation.raw)
  }

  /**
   * Build an update operation: a modified copy of the record's raw, with
   * unknown columns rejected, values sanitized, dirty tracking applied
   * only for values that actually changed, and updated_at auto-touched.
   * The cached instance is not touched until the batch commits.
   */
  prepareUpdate(record: RawRecord, fields: DirtyRaw): BatchOperation {
    const stamped: { [key: string]: unknown } = { ...fields }
    if (this.schema.columns['updated_at'] && stamped['updated_at'] === undefined) {
      stamped['updated_at'] = Date.now()
    }
    const updated: RawRecord = { ...record }
    for (const [key, value] of Object.entries(stamped)) {
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
  async update(id: string, fields: DirtyRaw): Promise<M> {
    const raw = await this._findRaw(id)
    await this.database.batch([this.prepareUpdate(raw, fields)])
    return this._recordFor(raw)
  }

  /**
   * Mark a record as deleted (a sync tombstone: hidden from queries, kept
   * in the database until sync pushes the deletion). Must be inside write.
   */
  async markAsDeleted(id: string): Promise<void> {
    const raw = await this._findRaw(id)
    await this.database.batch([
      { type: 'markAsDeleted', table: this.table, raw },
    ])
  }

  /** Permanently delete a record's row. Must be called inside write. */
  async destroyPermanently(id: string): Promise<void> {
    const raw = await this._findRaw(id)
    await this.database.batch([
      { type: 'destroyPermanently', table: this.table, raw },
    ])
  }

  /** Subscribe to this table's committed changes (raw-level, low-level). */
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
