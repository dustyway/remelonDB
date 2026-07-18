/**
 * The storage seam (docs/server-design.md): the server-side sibling of
 * SqliteDriver. A store knows rows, revisions, and scopes — nothing
 * about cursors, conflicts, or the wire. Eight methods; every protocol
 * semantic lives in the engine above.
 */
import type { DirtyRaw } from '@remelondb/core'

export type WireRow = DirtyRaw & { readonly id: string }

/** One row's sync-relevant state: wire-ready, or a tombstone. */
export interface StoredChange {
  readonly id: string
  readonly rev: number
  /** null = tombstone */
  readonly row: WireRow | null
}

export interface SyncStoreTx<Scope> {
  /** Every change to the scope's rows with rev > since, wire-ready. */
  changedSince(
    table: string,
    scope: Scope,
    since: number,
  ): Promise<readonly StoredChange[]>
  /** Highest revision among the scope's rows (0 when none). */
  maxRev(scope: Scope): Promise<number>
  /** Current revisions of the given ids within the scope (absent = unknown). */
  currentRevs(
    table: string,
    scope: Scope,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, number>>
  /** Ids among `ids` that exist but belong outside the scope. */
  foreignIds(
    table: string,
    scope: Scope,
    ids: readonly string[],
  ): Promise<readonly string[]>
  /**
   * Idempotent upserts, stamped with fresh revisions. MUST NOT touch
   * creation stamps of existing rows and MUST NOT resurrect tombstones.
   */
  upsert(table: string, scope: Scope, rows: readonly WireRow[]): Promise<void>
  /** Tombstone the ids (fresh revisions); unknown ids are a no-op. */
  tombstone(table: string, scope: Scope, ids: readonly string[]): Promise<void>
  /** Oldest revision still fully served (tombstone retention floor). */
  gcFloor(): Promise<number>
}

export interface SyncStore<Scope> {
  /**
   * Run work atomically in one consistent snapshot. `mode: 'push'` MUST
   * serialize per scope (the advisory-lock obligation): a scope's
   * pushes commit in revision order, or the engine's cursors lie.
   */
  transaction<T>(
    scope: Scope,
    mode: 'pull' | 'push',
    work: (tx: SyncStoreTx<Scope>) => Promise<T>,
  ): Promise<T>
}
