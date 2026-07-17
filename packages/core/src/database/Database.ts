/**
 * The Database: owns the driver, the collections, the writer queue, and
 * the change-notification bus.
 *
 * The batch failure contract (docs/architecture-layers.md, decision 7):
 * driver.executeBatch is atomic; cache changes and notifications are
 * applied only after it resolves. On rejection, in-memory state is
 * untouched and the error propagates to the writer block.
 *
 * Setup is two-phase (docs/reference/schema.md): open() reports
 * user_version; core decides fresh-setup / migrate / ready / error. A
 * missing migration path is an explicit error, never a silent reset.
 */
import type { SqliteDriver } from '../driver/SqliteDriver'
import type {
  AppSchema,
  ColumnName,
  ColumnsSpec,
  TableSchema,
} from '../schema/index'
import {
  stepsForMigration,
  type SchemaMigrations,
} from '../schema/migrations'
import { encodeMigrationSteps, encodeSchema } from '../schema/encodeSchema'
import type { QueryAssociation } from '../query/encodeQuery'
import {
  Collection,
  type CollectionChange,
  type CollectionChangeSet,
  type Unsubscribe,
} from './Collection'
import { encodeBatch, type BatchOperation } from './encodeBatch'
import { LocalStorage } from './LocalStorage'
import { WorkQueue } from './WorkQueue'
import type {
  ColumnsOf,
  Model,
  ModelClass,
  TypedModel,
  TypedModelClass,
} from '../model/Model'
import type { RawRecord } from '../rawRecord/index'

export interface DatabaseOptions {
  readonly driver: SqliteDriver
  readonly schema: AppSchema
  readonly migrations?: SchemaMigrations
  /**
   * Model classes to bind to their tables (static `table`). Their static
   * `associations` feed Q.on join compilation; field accessors are
   * generated from the schema.
   */
  readonly modelClasses?: readonly ModelClass[]
  /** Extra join metadata for Q.on queries on model-less tables. */
  readonly associations?: readonly QueryAssociation[]
  /** Database name/path passed to driver.open. */
  readonly name: string
}

export type DatabaseChangeSet = { readonly [table: string]: CollectionChangeSet }

interface DatabaseSubscriber {
  readonly tables: ReadonlySet<string>
  readonly handler: (changes: DatabaseChangeSet) => void
}

export class Database {
  readonly localStorage: LocalStorage
  readonly associations: readonly QueryAssociation[]
  private readonly queue = new WorkQueue()
  private readonly collections = new Map<string, Collection>()
  private subscribers: DatabaseSubscriber[] = []

  private constructor(
    readonly driver: SqliteDriver,
    readonly schema: AppSchema,
    associations: readonly QueryAssociation[],
    readonly migrations?: SchemaMigrations,
  ) {
    this.associations = associations
    this.localStorage = new LocalStorage(driver)
    for (const table of Object.values(schema.tables)) {
      this.collections.set(table.name, new Collection(this, table))
    }
  }

  /** Open the database, running setup or migrations as needed. */
  static async open(options: DatabaseOptions): Promise<Database> {
    const { driver, schema, migrations, name } = options
    const { userVersion } = await driver.open(name)

    if (userVersion === 0) {
      await driver.executeBatch(encodeSchema(schema).map((sql) => [sql, [[]]]))
      await driver.setUserVersion(schema.version)
    } else if (userVersion < schema.version) {
      const steps = migrations
        ? stepsForMigration(migrations, { from: userVersion, to: schema.version })
        : null
      if (steps === null) {
        throw new Error(
          `Database is at schema version ${userVersion} but no migration path to ${schema.version} exists. ` +
            'Provide migrations covering this range, or reset the database explicitly.',
        )
      }
      await driver.executeBatch(
        encodeMigrationSteps(steps).map((sql) => [sql, [[]]]),
      )
      await driver.setUserVersion(schema.version)
    } else if (userVersion > schema.version) {
      throw new Error(
        `Database is at schema version ${userVersion}, newer than the app's ${schema.version} — refusing to open (app downgrade?)`,
      )
    }

    const associations: QueryAssociation[] = [...(options.associations ?? [])]
    for (const modelClass of options.modelClasses ?? []) {
      for (const [to, info] of Object.entries(modelClass.associations ?? {})) {
        associations.push({ from: modelClass.table, to, info })
      }
    }
    const database = new Database(driver, schema, associations, migrations)
    for (const modelClass of options.modelClasses ?? []) {
      database.get(modelClass.table)._bindModelClass(modelClass)
    }
    return database
  }

  /**
   * The collection for a table. Pass a model class or a table definition
   * for a typed collection (records, Q column names); the string form is
   * for dynamic/internal access and is untyped.
   */
  get<
    MC extends {
      new (...args: any[]): Model
      readonly table: string
      readonly schema: TableSchema<ColumnsSpec>
    },
  >(
    modelClass: MC,
  ): Collection<InstanceType<MC>, ColumnsOf<MC>>
  get<T extends TableSchema<ColumnsSpec>>(
    table: T,
  ): Collection<TypedModel<T>, ColumnName<T>>
  get<M = RawRecord>(table: string): Collection<M>
  get(
    arg: string | TableSchema | TypedModelClass<TableSchema<ColumnsSpec>>,
  ): Collection<unknown, string> {
    const table =
      typeof arg === 'string'
        ? arg
        : typeof arg === 'function'
          ? arg.table
          : arg.name
    const collection = this.collections.get(table)
    if (!collection) {
      throw new Error(`No collection for table '${table}' — is it in the schema?`)
    }
    return collection as Collection<unknown, string>
  }

  /** Run exclusive write work. Mutations are only allowed inside. */
  write<T>(work: () => Promise<T>): Promise<T> {
    return this.queue.enqueue(work, true)
  }

  /** A consistency window: no writer runs while this block does. */
  read<T>(work: () => Promise<T>): Promise<T> {
    return this.queue.enqueue(work, false)
  }

  /** Commit operations atomically. Must be called inside database.write. */
  async batch(operations: readonly BatchOperation[]): Promise<void> {
    if (!this.queue.isWriterRunning) {
      throw new Error('Database.batch must be called from inside database.write()')
    }
    if (operations.length === 0) {
      return
    }

    await this.driver.executeBatch(encodeBatch(operations, this.schema))

    // Success: first bring every cache up to date, then notify (so all
    // subscribers observe a consistent world).
    const changesByTable = new Map<string, CollectionChange[]>()
    for (const operation of operations) {
      const collection = this.get(operation.table)
      const changes =
        changesByTable.get(operation.table) ??
        changesByTable.set(operation.table, []).get(operation.table)!
      switch (operation.type) {
        case 'create':
          collection.cache.add(operation.raw)
          changes.push({ record: operation.raw, type: 'created' })
          break
        case 'update': {
          const cached = collection.cache.get(operation.raw.id)
          if (cached && cached !== operation.raw) {
            Object.assign(cached, operation.raw)
          } else {
            collection.cache.add(operation.raw)
          }
          changes.push({
            record: collection.cache.get(operation.raw.id)!,
            type: 'updated',
          })
          break
        }
        case 'markAsDeleted':
        case 'destroyPermanently': {
          const record = collection.cache.get(operation.raw.id) ?? operation.raw
          record._status = 'deleted'
          collection.cache.delete(operation.raw.id)
          changes.push({ record, type: 'destroyed' })
          break
        }
      }
    }

    const changeSet: { [table: string]: CollectionChangeSet } = {}
    for (const [table, changes] of changesByTable) {
      changeSet[table] = changes
    }
    for (const { tables, handler } of [...this.subscribers]) {
      if (Object.keys(changeSet).some((table) => tables.has(table))) {
        handler(changeSet)
      }
    }
    for (const [table, changes] of changesByTable) {
      this.get(table)._notify(changes)
    }
  }

  /** Subscribe to committed changes touching any of the given tables. */
  onChange(
    tables: readonly string[],
    handler: (changes: DatabaseChangeSet) => void,
  ): Unsubscribe {
    const subscriber: DatabaseSubscriber = { tables: new Set(tables), handler }
    this.subscribers.push(subscriber)
    return () => {
      const index = this.subscribers.indexOf(subscriber)
      if (index !== -1) {
        this.subscribers.splice(index, 1)
      }
    }
  }
}
