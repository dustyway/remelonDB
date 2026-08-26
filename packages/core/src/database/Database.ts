/**
 * The Database: owns the driver, the collections, the writer queue, and
 * the change-notification bus.
 *
 * The batch failure contract (docs/layers.md, decision 7):
 * driver.executeBatch is atomic; cache changes and notifications are
 * applied only after it resolves. On rejection, in-memory state is
 * untouched and the error propagates to the writer block.
 *
 * Setup is two-phase (docs/reference/schema.md): open() reports
 * user_version; core decides fresh-setup / migrate / ready / error. A
 * missing migration path is an explicit error, never a silent reset.
 */
import type {
  ExternalChangeSet,
  SqlArgs,
  SqliteDriver,
} from '../driver/SqliteDriver';
import type {
  AppSchema,
  ColumnName,
  ColumnsSpec,
  TableSchema,
} from '../schema/index';
import { stepsForMigration, type SchemaMigrations } from '../schema/migrations';
import { encodeMigrationSteps, encodeSchema } from '../schema/encodeSchema';
import type { QueryAssociation } from '../query/encodeQuery';
import type { QueryDescription } from '../query/ast';
import {
  Collection,
  type CollectionChange,
  type CollectionChangeSet,
  type Unsubscribe,
} from './Collection';
import { setDirectRunner } from './directWork';
import { encodeBatch, type BatchOperation } from './encodeBatch';
import { LocalStorage } from './LocalStorage';
import { WorkQueue } from './WorkQueue';
import type {
  ColumnsOf,
  Model,
  ModelClass,
  TypedModel,
  TypedModelClass,
} from '../model/Model';
import type { RawRecord } from '../rawRecord/index';

export interface DatabaseOptions {
  readonly driver: SqliteDriver;
  readonly schema: AppSchema;
  readonly migrations?: SchemaMigrations;
  /**
   * Model classes to bind to their tables (static `table`). Their static
   * `associations` feed Q.on join compilation; field accessors are
   * generated from the schema.
   */
  readonly modelClasses?: readonly ModelClass[];
  /** Extra join metadata for Q.on queries on model-less tables. */
  readonly associations?: readonly QueryAssociation[];
  /** Database name/path passed to driver.open. */
  readonly name: string;
  /** Optional, passive instrumentation for reactive query refetches. */
  readonly onObservation?: (event: ObservationDiagnostic) => void;
}

export interface ObservationDiagnostic {
  readonly kind: 'records' | 'count';
  readonly trigger: 'initial' | 'change';
  readonly outcome: 'success' | 'error' | 'discarded';
  readonly table: string;
  readonly description: QueryDescription;
  readonly durationMs: number;
  readonly resultCount?: number;
  readonly error?: Error;
}

export type DatabaseChangeSet = {
  readonly [table: string]: CollectionChangeSet;
};

interface DatabaseSubscriber {
  readonly tables: ReadonlySet<string>;
  readonly handler: (changes: DatabaseChangeSet) => void;
}

/**
 * The database: owns the driver, the typed collections, the FIFO
 * write queue, and change notification. One instance per database file.
 *
 * @example
 * ```ts
 * const db = await Database.open({
 *   driver: new NodeSqliteDriver(),   // or WebSqliteDriver / RnSqliteDriver
 *   schema,
 *   modelClasses: [Task],
 *   name: 'app.db',
 * })
 * await db.write(() => db.get(Task).create({ name: 'hello' }))
 * ```
 * @category Database & queries
 */
export class Database {
  readonly localStorage: LocalStorage;
  readonly associations: readonly QueryAssociation[];
  private readonly queue = new WorkQueue();
  private readonly collections = new Map<string, Collection>();
  private subscribers: DatabaseSubscriber[] = [];
  /** Phase one: set the moment close() is called, before anything awaits. */
  private closeRequested = false;
  /** Phase two: set when the teardown barrier reaches the front. */
  private teardownStarted = false;
  private closePromise: Promise<void> | null = null;
  /** read/write calls admitted and not yet finished, slot release included. */
  private acceptedWork = 0;
  private acceptedWorkDrained: (() => void) | null = null;
  /** Core driver work that does not go through the queue. */
  private directWork = 0;
  private directWorkDrained: (() => void) | null = null;

  private constructor(
    readonly driver: SqliteDriver,
    readonly schema: AppSchema,
    associations: readonly QueryAssociation[],
    readonly migrations?: SchemaMigrations,
    readonly onObservation?: (event: ObservationDiagnostic) => void,
  ) {
    this.associations = associations;
    this.localStorage = new LocalStorage(driver);
    // Both this database and its local storage account their direct
    // driver work here, without either class growing a public method.
    const gate: <T>(work: () => Promise<T>) => Promise<T> = (work) =>
      this.gateDirect(work);
    setDirectRunner(this, gate);
    setDirectRunner(this.localStorage, gate);
    for (const table of Object.values(schema.tables)) {
      this.collections.set(table.name, new Collection(this, table));
    }
  }

  /** Open the database, running setup or migrations as needed. */
  static async open(options: DatabaseOptions): Promise<Database> {
    const { driver, schema, migrations, name } = options;
    const { userVersion } = await driver.open(name);

    if (userVersion === 0) {
      // DDL and the version stamp travel as ONE atomic batch: a client
      // that loses a concurrent first-open race (two tabs, cold origin)
      // collides on the DDL, and because the winner's batch committed
      // whole, the version re-read below explains the collision — the
      // loser then joins the winner's setup instead of failing.
      const setup: Array<[string, [SqlArgs]]> = [
        ...encodeSchema(schema).map((sql): [string, [SqlArgs]] => [sql, [[]]]),
        [`pragma user_version = ${schema.version}`, [[]]],
      ];
      try {
        await driver.executeBatch(setup);
      } catch (error) {
        const rows = await driver.query('pragma user_version', []);
        const now = Number(
          (rows as readonly { user_version?: unknown }[])[0]?.user_version ?? 0,
        );
        if (now !== schema.version) {
          throw error; // not a setup race — surface the real failure
        }
      }
    } else if (userVersion < schema.version) {
      const steps = migrations
        ? stepsForMigration(migrations, {
            from: userVersion,
            to: schema.version,
          })
        : null;
      if (steps === null) {
        throw new Error(
          `Database is at schema version ${userVersion} but no migration path to ${schema.version} exists. ` +
            'Provide migrations covering this range, or reset the database explicitly.',
        );
      }
      await driver.executeBatch(
        encodeMigrationSteps(steps).map((sql) => [sql, [[]]]),
      );
      await driver.setUserVersion(schema.version);
    } else if (userVersion > schema.version) {
      throw new Error(
        `Database is at schema version ${userVersion}, newer than the app's ${schema.version} — refusing to open (app downgrade?)`,
      );
    }

    const associations: QueryAssociation[] = [...(options.associations ?? [])];
    for (const modelClass of options.modelClasses ?? []) {
      for (const [to, info] of Object.entries(modelClass.associations ?? {})) {
        associations.push({ from: modelClass.table, to, info });
      }
    }
    const database = new Database(
      driver,
      schema,
      associations,
      migrations,
      options.onObservation,
    );
    for (const modelClass of options.modelClasses ?? []) {
      database.get(modelClass.table)._bindModelClass(modelClass);
    }
    // Change propagation, receiving half (docs/multi-tab.md): commits
    // from other contexts flow into this cache and its observers. The
    // rejection swallow is deliberate: a change set for an unknown table
    // cannot occur while every context runs the same schema, and a
    // failed external apply must never take down the driver's listener.
    driver.onExternalChanges?.((changes) => {
      void database
        .applyExternalChanges(changes as DatabaseChangeSet)
        .catch(() => {});
    });
    return database;
  }

  /**
   * The collection for a table. Pass a model class or a table definition
   * for a typed collection (records, Q column names); the string form is
   * for dynamic/internal access and is untyped.
   */
  get<
    MC extends {
      new (...args: any[]): Model;
      readonly table: string;
      readonly schema: TableSchema<ColumnsSpec>;
    },
  >(modelClass: MC): Collection<InstanceType<MC>, ColumnsOf<MC>>;
  get<T extends TableSchema<ColumnsSpec>>(
    table: T,
  ): Collection<TypedModel<T>, ColumnName<T>>;
  get<M = RawRecord>(table: string): Collection<M>;
  get(
    arg: string | TableSchema | TypedModelClass<TableSchema<ColumnsSpec>>,
  ): Collection<unknown, string> {
    const table =
      typeof arg === 'string'
        ? arg
        : typeof arg === 'function'
          ? arg.table
          : arg.name;
    const collection = this.collections.get(table);
    if (!collection) {
      throw new Error(
        `No collection for table '${table}' — is it in the schema?`,
      );
    }
    return collection as Collection<unknown, string>;
  }

  /**
   * Run exclusive write work. Mutations are only allowed inside.
   *
   * This is a serialized writer window, NOT a transaction: each
   * `batch()` / `create()` / `update()` / delete inside commits on its
   * own, and an error mid-block does not roll back earlier commits.
   * For all-or-nothing multi-record work (delete cascades, seeding),
   * group prepared operations into ONE `db.batch()` call — that is the
   * atomic unit.
   */
  write<T>(work: () => Promise<T>): Promise<T> {
    return this.withWorkSlot(true, work);
  }

  /** A consistency window: no writer runs while this block does. */
  read<T>(work: () => Promise<T>): Promise<T> {
    return this.withWorkSlot(false, work);
  }

  /**
   * Hold the driver's cross-context slot (docs/multi-tab.md) around a
   * block, when the driver has one. The slot is acquired BEFORE entering
   * the local queue, deliberately: while this context waits for its
   * grant, the queue stays free to apply change broadcasts from other
   * contexts — and the transport's FIFO ordering guarantees the grant
   * arrives after every broadcast committed before it (the previous
   * holder publishes before it releases). Acquiring inside the queue
   * instead would park those applies behind this block, whose reads
   * would then trust a cache that is missing the other context's
   * committed writes — a lost update. Cross-call FIFO is preserved
   * because the broker's grant queue is itself FIFO in request order.
   * Drivers without shared storage don't implement the hook; their
   * blocks enqueue directly, exactly as before.
   */
  private async withWorkSlot<T>(
    exclusive: boolean,
    work: () => Promise<T>,
  ): Promise<T> {
    if (this.closeRequested) {
      throw new Error('Database is closing');
    }
    // Counted from here rather than from queue entry: a block waiting on
    // acquireWorkSlot is not in the queue yet, so a teardown that only
    // watched the queue would close the driver out from under it. The
    // count drops after release(), so the slot is given back first.
    this.acceptedWork += 1;
    try {
      const acquire = this.driver.acquireWorkSlot;
      if (!acquire) {
        return await this.queue.enqueue(work, exclusive);
      }
      const release = await acquire.call(this.driver, exclusive);
      try {
        return await this.queue.enqueue(work, exclusive);
      } finally {
        await release();
      }
    } finally {
      this.acceptedWork -= 1;
      if (this.acceptedWork === 0) {
        this.acceptedWorkDrained?.();
      }
    }
  }

  /**
   * Run core-owned driver work that does not go through the queue —
   * query fetches, local storage, the sync helpers. Admitted until the
   * teardown barrier starts, which is later than close() is requested:
   * an accepted read or write block may issue one of these, and core
   * cannot tell that call from an unrelated caller's without portable
   * async context.
   *
   * The work here must never enqueue. Teardown holds the queue while it
   * waits for this count to reach zero, so a direct operation waiting to
   * enter the same queue would deadlock. If a direct path ever needs
   * queue ordering, redesign the two layers rather than reaching into
   * the queue from here.
   *
   */
  private async gateDirect<T>(work: () => Promise<T>): Promise<T> {
    if (this.teardownStarted) {
      throw new Error('Database is closing');
    }
    this.directWork += 1;
    try {
      return await work();
    } finally {
      this.directWork -= 1;
      if (this.directWork === 0) {
        this.directWorkDrained?.();
      }
    }
  }

  /**
   * Close the database: work it already accepted finishes, then the
   * driver goes away. Idempotent — concurrent calls share one teardown,
   * and a failed one stays the answer, since the driver may still be
   * open and a clean resolve would be a lie.
   *
   * Two phases. New `read`, `write`, and `applyExternalChanges` calls
   * are refused at once; work already accepted runs to completion, and
   * the direct operations it may start along the way are allowed. Once
   * everything accepted has finished, a barrier enters the queue behind
   * whatever is still in it, and from that point new direct work is
   * refused too.
   *
   * Not covered: application code holding `database.driver` and calling
   * it itself. Core cannot see that work.
   *
   * Not reentrant. Code inside an admitted read, write, query,
   * local-storage, or sync operation must not await this — close waits
   * for that operation, so it would be waiting for itself.
   */
  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closeRequested = true; // synchronous: nothing new is admitted
    this.closePromise = (async () => {
      if (this.acceptedWork > 0) {
        await new Promise<void>((resolve) => {
          this.acceptedWorkDrained = resolve;
        });
        this.acceptedWorkDrained = null;
      }
      // Exclusive, so it runs behind anything already queued — an
      // external-change apply accepted before the close, for instance.
      await this.queue.enqueue(async () => {
        this.teardownStarted = true;
        if (this.directWork > 0) {
          await new Promise<void>((resolve) => {
            this.directWorkDrained = resolve;
          });
          this.directWorkDrained = null;
        }
        await this.driver.close();
      }, true);
    })();
    return this.closePromise;
  }

  /** Commit operations atomically. Must be called inside database.write. */
  async batch(operations: readonly BatchOperation[]): Promise<void> {
    if (!this.queue.isWriterRunning) {
      throw new Error(
        'Database.batch must be called from inside database.write()',
      );
    }
    if (operations.length === 0) {
      return;
    }

    await this.driver.executeBatch(encodeBatch(operations, this.schema));

    // Success: first bring every cache up to date, then notify (so all
    // subscribers observe a consistent world).
    const changesByTable = new Map<string, CollectionChange[]>();
    for (const operation of operations) {
      const collection = this.get(operation.table);
      const changes =
        changesByTable.get(operation.table) ??
        changesByTable.set(operation.table, []).get(operation.table)!;
      switch (operation.type) {
        case 'create':
          collection.cache.add(operation.raw);
          changes.push({ record: operation.raw, type: 'created' });
          break;
        case 'update': {
          const cached = collection.cache.get(operation.raw.id);
          if (cached && cached !== operation.raw) {
            Object.assign(cached, operation.raw);
          } else {
            collection.cache.add(operation.raw);
          }
          changes.push({
            record: collection.cache.get(operation.raw.id)!,
            type: 'updated',
          });
          break;
        }
        case 'markAsDeleted':
        case 'destroyPermanently': {
          const record =
            collection.cache.get(operation.raw.id) ?? operation.raw;
          record._status = 'deleted';
          collection.cache.delete(operation.raw.id);
          changes.push({ record, type: 'destroyed' });
          break;
        }
      }
    }

    const changeSet = this.notifyChanges(changesByTable);
    // Change propagation, sending half (docs/multi-tab.md). Only real
    // commits publish — applyExternalChanges must not re-publish what it
    // received, or two contexts would echo changes forever.
    this.driver.publishChanges?.(changeSet as ExternalChangeSet);
  }

  /**
   * Apply a change set committed by ANOTHER context sharing this storage
   * (docs/multi-tab.md): bring the record cache up to date and notify
   * observers, without writing — storage already has the data. Runs
   * exclusively like a commit; must not be called from inside
   * database.write or database.read (the queue is not re-entrant).
   *
   * Idempotent by design: a re-broadcast create for a cached id degrades
   * to an update, and a destroy for an unknown id is a no-op.
   */
  async applyExternalChanges(changes: DatabaseChangeSet): Promise<void> {
    // Enqueues directly rather than through withWorkSlot, so it needs
    // its own refusal. An apply accepted before the close stays ahead of
    // the teardown barrier.
    if (this.closeRequested) {
      throw new Error('Database is closing');
    }
    await this.queue.enqueue(async () => {
      const changesByTable = new Map<string, CollectionChange[]>();
      for (const [tableName, tableChanges] of Object.entries(changes)) {
        const collection = this.get(tableName);
        const applied: CollectionChange[] = [];
        for (const change of tableChanges) {
          const raw = change.record;
          switch (change.type) {
            case 'created':
            case 'updated': {
              const cached = collection.cache.get(raw.id);
              if (cached && cached !== raw) {
                Object.assign(cached, raw);
              } else if (!cached) {
                collection.cache.add(raw);
              }
              applied.push({
                record: collection.cache.get(raw.id)!,
                type: cached ? 'updated' : 'created',
              });
              break;
            }
            case 'destroyed': {
              const record = collection.cache.get(raw.id);
              if (!record) {
                break; // never seen here: nothing observed, nothing to do
              }
              record._status = 'deleted';
              collection.cache.delete(raw.id);
              applied.push({ record, type: 'destroyed' });
              break;
            }
          }
        }
        if (applied.length > 0) {
          changesByTable.set(tableName, applied);
        }
      }
      if (changesByTable.size > 0) {
        this.notifyChanges(changesByTable);
      }
    }, true);
  }

  /** Notify database subscribers and collection buses about a commit. */
  private notifyChanges(
    changesByTable: Map<string, CollectionChange[]>,
  ): DatabaseChangeSet {
    const changeSet: { [table: string]: CollectionChangeSet } = {};
    for (const [table, changes] of changesByTable) {
      changeSet[table] = changes;
    }
    for (const { tables, handler } of [...this.subscribers]) {
      if (Object.keys(changeSet).some((table) => tables.has(table))) {
        handler(changeSet);
      }
    }
    for (const [table, changes] of changesByTable) {
      this.get(table)._notify(changes);
    }
    return changeSet;
  }

  /** Subscribe to committed changes touching any of the given tables. */
  onChange(
    tables: readonly string[],
    handler: (changes: DatabaseChangeSet) => void,
  ): Unsubscribe {
    const subscriber: DatabaseSubscriber = { tables: new Set(tables), handler };
    this.subscribers.push(subscriber);
    return () => {
      const index = this.subscribers.indexOf(subscriber);
      if (index !== -1) {
        this.subscribers.splice(index, 1);
      }
    };
  }
}
