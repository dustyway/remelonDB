/**
 * The Model layer: typed, ergonomic record classes over the raw-record
 * engine. Unlike upstream's Babel-decorator API, field accessors are
 * generated on the prototype from the table schema when a model class is
 * bound (Database.open modelClasses) — subclasses declare fields
 * type-only:
 *
 *   class Task extends Model {
 *     static override table = 'tasks'
 *     static override associations = {
 *       projects: { type: 'belongs_to', key: 'project_id' },
 *       comments: { type: 'has_many', foreignKey: 'task_id' },
 *     } satisfies AssociationsMap
 *     declare name: string
 *     declare position: number
 *   }
 *
 * `declare` emits no runtime field, so the generated accessors work; a
 * hand-written getter/setter on the class takes precedence (the generator
 * skips existing properties... it throws, actually — see
 * defineModelAccessors — hand-written accessors must use a different name
 * than the column and read this._raw directly).
 *
 * Writes only work inside the update() builder; they flow through the
 * collection's sanitize + dirty-tracking path.
 */
import type { RawRecord, SyncStatus } from '../rawRecord/index'
import type { Collection, Unsubscribe } from '../database/Collection'
import type { Query } from '../database/Query'
import * as Q from '../query/Q'

export type AssociationsMap = {
  readonly [table: string]:
    | { readonly type: 'belongs_to'; readonly key: string }
    | { readonly type: 'has_many'; readonly foreignKey: string }
}

export interface ModelClass<M extends Model = Model> {
  new (collection: Collection<M>, raw: RawRecord): M
  readonly table: string
  readonly associations?: AssociationsMap
}

export class Model {
  static readonly table: string = ''
  static readonly associations?: AssociationsMap

  /** @internal Non-null only while an update() builder runs. */
  _pendingFields: { [column: string]: unknown } | null = null

  constructor(
    readonly collection: Collection<Model>,
    readonly _raw: RawRecord,
  ) {}

  get id(): string {
    return this._raw.id
  }

  get syncStatus(): SyncStatus {
    return this._raw._status
  }

  /**
   * Update fields via a builder. Must be called inside database.write().
   *
   *   await task.update(() => { task.name = 'new' })
   */
  async update(builder: (record: this) => void): Promise<this> {
    if (this._pendingFields) {
      throw new Error('Model.update: already updating')
    }
    this._pendingFields = {}
    let fields: { [column: string]: unknown }
    try {
      builder(this)
    } finally {
      fields = this._pendingFields
      this._pendingFields = null
    }
    await this.collection.update(this.id, fields)
    return this
  }

  markAsDeleted(): Promise<void> {
    return this.collection.markAsDeleted(this.id)
  }

  destroyPermanently(): Promise<void> {
    return this.collection.destroyPermanently(this.id)
  }

  /**
   * Observe this record: emits the record immediately, again after each
   * committed update, and null when it is deleted.
   */
  observe(subscriber: (record: this | null) => void): Unsubscribe {
    subscriber(this)
    return this.collection.onChange((changes) => {
      for (const { record, type } of changes) {
        if (record.id === this.id) {
          subscriber(type === 'destroyed' ? null : this)
        }
      }
    })
  }

  private association(table: string) {
    const associations = (this.constructor as ModelClass).associations
    const association = associations?.[table]
    if (!association) {
      throw new Error(
        `${this.constructor.name} has no association to '${table}' — declare it in static associations`,
      )
    }
    return association
  }

  /** Query of this record's has_many children in the given table. */
  children<M = unknown>(table: string): Query<M> {
    const association = this.association(table)
    if (association.type !== 'has_many') {
      throw new Error(`Association to '${table}' is not has_many`)
    }
    return this.collection.database
      .get<M>(table)
      .query(Q.where(association.foreignKey, this.id))
  }

  /** The belongs_to parent in the given table, or null if unset. */
  async related<M = unknown>(table: string): Promise<M | null> {
    const association = this.association(table)
    if (association.type !== 'belongs_to') {
      throw new Error(`Association to '${table}' is not belongs_to`)
    }
    const foreignId = this._raw[association.key]
    if (foreignId === null || foreignId === undefined) {
      return null
    }
    return this.collection.database.get<M>(table).find(String(foreignId))
  }
}

/**
 * Generate get/set accessors for every schema column on a model class
 * prototype. Reads come from the raw (or pending fields mid-update);
 * writes are only legal inside an update() builder.
 */
const boundClasses = new WeakSet<ModelClass>()

export function defineModelAccessors(
  cls: ModelClass,
  columns: readonly { name: string }[],
): void {
  if (boundClasses.has(cls)) {
    return // already bound (e.g. same class across several databases)
  }
  boundClasses.add(cls)
  for (const { name } of columns) {
    if (name in cls.prototype) {
      throw new Error(
        `Column '${cls.table}.${name}' conflicts with a property of ${cls.name} — rename the column or the property`,
      )
    }
    Object.defineProperty(cls.prototype, name, {
      enumerable: true,
      get(this: Model) {
        if (this._pendingFields && name in this._pendingFields) {
          return this._pendingFields[name]
        }
        return this._raw[name]
      },
      set(this: Model, value: unknown) {
        if (!this._pendingFields) {
          throw new Error(
            `Cannot set '${cls.table}.${name}' outside of update() — records are read-only`,
          )
        }
        this._pendingFields[name] = value
      },
    })
  }
}
