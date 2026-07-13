/**
 * Sync protocol types (docs/sync-design.md). The cursor is an opaque token
 * the client stores and echoes — never inspected, compared, or ordered
 * client-side. Records on the wire carry user columns + id only; _status
 * and _changed never cross in either direction.
 */
import type { DirtyRaw } from '../rawRecord/index'

export type Cursor = string

export interface SyncTableChanges {
  readonly created: readonly DirtyRaw[]
  readonly updated: readonly DirtyRaw[]
  readonly deleted: readonly string[]
}

export type SyncChanges = { readonly [table: string]: SyncTableChanges }

/** Schema info sent with a pull after a local migration. */
export interface MigrationSyncChanges {
  readonly from: number
  readonly tables: readonly string[]
  readonly columns: readonly { table: string; columns: readonly string[] }[]
}

export interface SyncPullArgs {
  readonly cursor: Cursor | null
  readonly schemaVersion: number
  readonly migration: MigrationSyncChanges | null
}

export type SyncPullResult =
  | { readonly changes: SyncChanges; readonly cursor: Cursor }
  /** The server can no longer serve this cursor — full resync required. */
  | { readonly resyncRequired: true }

export interface SyncPushArgs {
  readonly changes: SyncChanges
  readonly cursor: Cursor
}

export type SyncPushResult =
  | {
      /**
       * New cursor covering the push, plus foreign changes committed
       * between the request cursor and the push — both or neither
       * (cursor: null = degraded mode; the next pull re-delivers the echo,
       * which apply absorbs).
       */
      readonly cursor: Cursor | null
      readonly changes: SyncChanges | null
      /** Per-record rejections; rejected records stay dirty. */
      readonly rejected?: { readonly [table: string]: readonly string[] }
    }
  /** A pushed record changed on the server after `cursor` — pull and retry. */
  | { readonly conflict: true }
