/**
 * The postMessage RPC between WebSqliteDriver (main thread) and the
 * worker-side server. Everything is structured-clonable plain data.
 * The Endpoint abstraction is what makes the driver fully testable in
 * Node: the same server code runs against a real browser Worker or an
 * in-process message channel.
 */
import type { SqlValue } from '@remelondb/core'

export interface Endpoint {
  postMessage(message: unknown): void
  addMessageListener(listener: (message: unknown) => void): void
  /** Tear down the transport (a real Worker terminates — this is what
   * releases the SAH pool's file locks). In-process endpoints may omit it. */
  terminate?(): void
}

export type StorageKind = 'opfs' | 'memory'

export type WorkerRequest = { readonly id: number } & (
  | { readonly op: 'open'; readonly name: string; readonly storage: StorageKind }
  | { readonly op: 'close'; readonly name: string }
  | {
      readonly op: 'query'
      readonly name: string
      readonly sql: string
      readonly args: readonly SqlValue[]
    }
  | {
      readonly op: 'execute'
      readonly name: string
      readonly sql: string
      readonly args: readonly SqlValue[]
    }
  | {
      readonly op: 'executeBatch'
      readonly name: string
      readonly statements: readonly (readonly [string, readonly (readonly SqlValue[])[]])[]
    }
  | { readonly op: 'setUserVersion'; readonly name: string; readonly version: number }
  | { readonly op: 'destroy'; readonly name: string }
)

export type WorkerResponse =
  | { readonly id: number; readonly ok: true; readonly result: unknown }
  | { readonly id: number; readonly ok: false; readonly error: string }
