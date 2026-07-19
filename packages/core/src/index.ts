export type {
  SqlValue,
  SqlArgs,
  Row,
  BatchStatement,
  SqliteDriver,
} from './driver/SqliteDriver'

/**
 * The query DSL. Clauses are plain serializable data (that is what makes
 * queries observable and sync-friendly); `collection.query(...)` accepts
 * them and checks column names against the table definition.
 *
 * @example
 * ```ts
 * db.get(Task).query(
 *   Q.where('is_done', false),
 *   Q.where('position', Q.gt(3)),
 *   Q.sortBy('position', Q.desc),
 *   Q.take(20),
 * )
 * ```
 * @category Database & queries
 */
export * as Q from './query/Q'

export { appSchema, column, table } from './schema/index'
export type {
  AppSchema,
  ColumnDef,
  ColumnName,
  ColumnSchema,
  ColumnsSpec,
  ColumnType,
  InferRecord,
  TableSchema,
} from './schema/index'

export {
  schemaMigrations,
  createTable,
  addColumns,
  unsafeExecuteSql,
  stepsForMigration,
} from './schema/migrations'
export type { SchemaMigrations, Migration, MigrationStep } from './schema/migrations'

export { encodeSchema, encodeTable, encodeMigrationSteps } from './schema/encodeSchema'

export { sanitizedRaw, setRawSanitized, nullValue, markAsChanged } from './rawRecord/index'
export type { RawRecord, DirtyRaw, SyncStatus } from './rawRecord/index'

export { randomId } from './utils/randomId'

export { canEncodeMatcher, encodeMatcher } from './observation/encodeMatcher'
export type { Matcher, EncodeMatcherOptions } from './observation/encodeMatcher'

export { Database } from './database/Database'
export type { DatabaseOptions, DatabaseChangeSet } from './database/Database'
export { Collection } from './database/Collection'
export type {
  ChangeType,
  CollectionChange,
  CollectionChangeSet,
  Unsubscribe,
} from './database/Collection'
export { Query } from './database/Query'
export { LocalStorage } from './database/LocalStorage'
export { WorkQueue } from './database/WorkQueue'
export { encodeBatch } from './database/encodeBatch'
export type { BatchOperation } from './database/encodeBatch'

export { Model, ModelFor, defineModelAccessors } from './model/Model'
export type {
  AssociationsMap,
  ColumnsOf,
  ModelClass,
  TypedModel,
  TypedModelClass,
} from './model/Model'

export { synchronize, CURSOR_KEY, LAST_SCHEMA_VERSION_KEY } from './sync/synchronize'
export type { SynchronizeOptions } from './sync/synchronize'
export { fetchLocalChanges, hasUnsyncedChanges } from './sync/fetchLocal'
export type { LocalChanges } from './sync/fetchLocal'
export { applyRemoteChanges } from './sync/applyRemote'
export type { ApplyRemoteOptions, ConflictResolver } from './sync/applyRemote'
export { markLocalChangesAsSynced } from './sync/markAsSynced'
export type {
  Cursor,
  SyncChanges,
  SyncTableChanges,
  MigrationSyncChanges,
  SyncPullArgs,
  SyncPullResult,
  SyncPushArgs,
  SyncPushResult,
} from './sync/types'

export { encodeQuery } from './query/encodeQuery'
export type {
  AssociationInfo,
  QueryAssociation,
  CompilableQuery,
  EncodeQueryOptions,
  CompiledQuery,
} from './query/encodeQuery'

export type {
  Value,
  NonNullValue,
  ColumnDescription,
  Comparison,
  ComparisonOperator,
  ComparisonRight,
  Where,
  WhereDescription,
  And,
  Or,
  On,
  UnsafeSqlExpr,
  SortBy,
  SortOrder,
  Take,
  Skip,
  JoinTables,
  NestedJoinTable,
  UnsafeSqlQuery,
  Clause,
  QueryDescription,
} from './query/ast'
