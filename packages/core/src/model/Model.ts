/**
 * The Model layer: typed, ergonomic record classes over the raw-record
 * engine. Unlike upstream's Babel-decorator API, field accessors are
 * generated on the prototype from the table schema when a model class is
 * bound (Database.open modelClasses), and field *types* are inferred from
 * the table definition via the ModelFor factory
 * (docs/schema-inferred-types.md) — nothing is declared by hand:
 *
 *   class Task extends ModelFor(tasks) {
 *     static override associations = {
 *       projects: { type: 'belongs_to', key: 'project_id' },
 *       comments: { type: 'has_many', foreignKey: 'task_id' },
 *     } satisfies AssociationsMap
 *   }
 *
 * The generated accessors land on the prototype; a hand-written
 * getter/setter with the same name as a column throws at bind time (see
 * defineModelAccessors) — use a different name and read this._raw
 * directly.
 *
 * Writes only work inside an update() or prepareUpdate() builder; they flow
 * through the collection's sanitize + dirty-tracking path.
 */
import type { RawRecord, SyncStatus } from '../rawRecord/index';
import type { Collection, Unsubscribe } from '../database/Collection';
import type { BatchOperation } from '../database/encodeBatch';
import type { Query } from '../database/Query';
import type { ColumnName, InferRecord, TableSchema } from '../schema/index';
import * as Q from '../query/Q';

export type AssociationsMap = {
  readonly [table: string]:
    | { readonly type: 'belongs_to'; readonly key: string }
    | { readonly type: 'has_many'; readonly foreignKey: string };
};

export interface ModelClass<M extends Model = Model> {
  // Collection<any>: precise collection typing here creates variance
  // knots between Model subclasses and the binding machinery; the
  // table↔class pairing is checked at runtime by Database.open.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new (collection: Collection<any>, raw: RawRecord): M;
  readonly table: string;
  readonly associations?: AssociationsMap;
  readonly schema?: TableSchema;
}

/**
 * A Model whose fields are inferred from a table definition: the Model
 * behaviors plus mutable properties for every schema column (writes still
 * only work inside update or prepareUpdate builders). `id` comes from Model
 * and stays readonly.
 * @category Models
 */
export type TypedModel<T extends TableSchema> = Model &
  Omit<InferRecord<T>, 'id'>;

export interface TypedModelClass<T extends TableSchema> {
  // Collection<any> for the same reason as ModelClass above.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new (collection: Collection<any>, raw: RawRecord): TypedModel<T>;
  readonly table: string;
  readonly schema: T;
  readonly associations?: AssociationsMap;
}

/**
 * The typed model base-class factory (docs/schema-inferred-types.md):
 *
 *   const tasks = table('tasks', { name: column.string(), ... })
 * Field types come from the table definition; there is nothing to
 * declare and nothing that can drift. (A plain generic class cannot type
 * its instance fields from a type parameter, hence the factory.)
 *
 * @example
 * ```ts
 * class Task extends ModelFor(tasks) {
 *   static override associations = { ... } satisfies AssociationsMap
 * }
 * const task = await db.get(Task).create({ name: 'hello' })
 * ```
 * @category Models
 */
export function ModelFor<T extends TableSchema>(schema: T): TypedModelClass<T> {
  class Bound extends Model {
    static override readonly table = schema.name;
    static override readonly schema = schema;
  }
  return Bound as unknown as TypedModelClass<T>;
}

/**
 * The Q column names legal for a model class (used by Database.get).
 * @category Models
 */
export type ColumnsOf<MC> = MC extends { readonly schema: infer T }
  ? T extends TableSchema
    ? ColumnName<T>
    : string
  : string;

/**
 * Base record behavior: identity, update builders, deletion, per-record
 * observation. Subclass via `ModelFor(table)`.
 * @category Models
 */
export class Model {
  static readonly table: string = '';
  static readonly associations?: AssociationsMap;
  static readonly schema?: TableSchema;

  /** @internal Non-null only while an update builder runs. */
  _pendingFields: { [column: string]: unknown } | null = null;

  constructor(
    readonly collection: Collection<Model>,
    readonly _raw: RawRecord,
  ) {}

  get id(): string {
    return this._raw.id;
  }

  get syncStatus(): SyncStatus {
    return this._raw._status;
  }

  /**
   * Update fields via a builder. Must be called inside database.write().
   *
   *   await task.update(() => { task.name = 'new' })
   */
  async update(builder: (record: this) => void): Promise<this> {
    await this.collection.database.batch([this.prepareUpdate(builder)]);
    return this;
  }

  /**
   * Build an update operation without committing it. The cached record stays
   * unchanged until Database.batch commits the operation.
   */
  prepareUpdate(builder: (record: this) => void): BatchOperation {
    // A stale handle to a deleted record must fail loudly, as the
    // committed path always did via its by-id lookup: the raw here
    // outlives the cache eviction, and an update op built from it
    // would quietly write onto a tombstone.
    if (this._raw._status === 'deleted') {
      throw new Error(
        `Model.prepareUpdate: record '${this.collection.table}/${this.id}' is deleted`,
      );
    }
    if (this._pendingFields) {
      throw new Error('Model.prepareUpdate: already updating');
    }
    this._pendingFields = {};
    let fields: { [column: string]: unknown };
    try {
      builder(this);
    } finally {
      fields = this._pendingFields;
      this._pendingFields = null;
    }
    return this.collection.prepareUpdate(this._raw, fields);
  }

  markAsDeleted(): Promise<void> {
    return this.collection.markAsDeleted(this.id);
  }

  destroyPermanently(): Promise<void> {
    return this.collection.destroyPermanently(this.id);
  }

  /** Build a delete-tombstone operation for Database.batch (atomic cascades). */
  prepareMarkAsDeleted(): BatchOperation {
    return this.collection.prepareMarkAsDeleted(this._raw);
  }

  /** Build a permanent-delete operation for Database.batch. */
  prepareDestroyPermanently(): BatchOperation {
    return this.collection.prepareDestroyPermanently(this._raw);
  }

  /**
   * Observe this record: emits the record immediately, again after each
   * committed update, and null when it is deleted.
   */
  observe(subscriber: (record: this | null) => void): Unsubscribe {
    subscriber(this);
    return this.collection.onChange((changes) => {
      for (const { record, type } of changes) {
        if (record.id === this.id) {
          subscriber(type === 'destroyed' ? null : this);
        }
      }
    });
  }

  private association(table: string) {
    const associations = (this.constructor as ModelClass).associations;
    const association = associations?.[table];
    if (!association) {
      throw new Error(
        `${this.constructor.name} has no association to '${table}' — declare it in static associations`,
      );
    }
    return association;
  }

  /** Query of this record's has_many children in the given table. */
  children<M = unknown>(table: string): Query<M> {
    const association = this.association(table);
    if (association.type !== 'has_many') {
      throw new Error(`Association to '${table}' is not has_many`);
    }
    return this.collection.database
      .get<M>(table)
      .query(Q.where(association.foreignKey, this.id));
  }

  /**
   * The belongs_to parent in the given table, or null when the key is
   * unset or points at a record that is gone (sync can delete a parent
   * while a child still references it).
   */
  async related<M = unknown>(table: string): Promise<M | null> {
    const association = this.association(table);
    if (association.type !== 'belongs_to') {
      throw new Error(`Association to '${table}' is not belongs_to`);
    }
    const foreignId = this._raw[association.key];
    if (foreignId === null || foreignId === undefined) {
      return null;
    }
    const [record] = await this.collection.database
      .get<M>(table)
      .query(Q.where('id', String(foreignId)))
      .fetch();
    return record ?? null;
  }
}

/**
 * Generate get/set accessors for every schema column on a model class
 * prototype. Reads come from the raw (or pending fields mid-update);
 * writes are only legal inside an update() or prepareUpdate() builder.
 */
const boundClasses = new WeakSet<ModelClass>();

export function defineModelAccessors(
  cls: ModelClass,
  columns: readonly { name: string }[],
): void {
  if (boundClasses.has(cls)) {
    return; // already bound (e.g. same class across several databases)
  }
  boundClasses.add(cls);
  for (const { name } of columns) {
    if (name in cls.prototype) {
      throw new Error(
        `Column '${cls.table}.${name}' conflicts with a property of ${cls.name} — rename the column or the property`,
      );
    }
    Object.defineProperty(cls.prototype, name, {
      enumerable: true,
      get(this: Model) {
        if (this._pendingFields && name in this._pendingFields) {
          return this._pendingFields[name];
        }
        return this._raw[name];
      },
      set(this: Model, value: unknown) {
        if (!this._pendingFields) {
          throw new Error(
            `Cannot set '${cls.table}.${name}' outside of update() or prepareUpdate() — records are read-only`,
          );
        }
        this._pendingFields[name] = value;
      },
    });
  }
}
