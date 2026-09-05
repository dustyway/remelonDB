/**
 * The postMessage RPC between WebSqliteDriver (main thread) and the
 * worker-side server. Everything is structured-clonable plain data.
 * The Endpoint abstraction is what makes the driver fully testable in
 * Node: the same server code runs against a real browser Worker or an
 * in-process message channel.
 */
import type { ExternalChangeSet, SqlValue } from '@remelondb/core';

export interface Endpoint {
  postMessage(message: unknown): void;
  addMessageListener(listener: (message: unknown) => void): void;
  /** Tear down the transport (a real Worker terminates — this is what
   * releases the SAH pool's file locks). In-process endpoints may omit it. */
  terminate?(): void;
}

export type StorageKind = 'opfs' | 'memory';

export type WorkerRequest = { readonly id: number } & (
  | {
      readonly op: 'open';
      readonly name: string;
      readonly storage: StorageKind;
    }
  | { readonly op: 'close'; readonly name: string }
  | {
      readonly op: 'query';
      readonly name: string;
      readonly sql: string;
      readonly args: readonly SqlValue[];
    }
  | {
      readonly op: 'execute';
      readonly name: string;
      readonly sql: string;
      readonly args: readonly SqlValue[];
    }
  | {
      readonly op: 'executeBatch';
      readonly name: string;
      readonly statements: readonly (readonly [
        string,
        readonly (readonly SqlValue[])[],
      ])[];
    }
  | {
      readonly op: 'setUserVersion';
      readonly name: string;
      readonly version: number;
    }
  | { readonly op: 'destroy'; readonly name: string }
  /** Liveness probe (the broker checks its compute channel with it). */
  | { readonly op: 'ping' }
  /**
   * Write-block arbitration (docs/multi-tab.md), answered by the broker
   * itself — these never reach SQLite. An exclusive slot excludes every
   * other slot; shared slots (read consistency windows) coexist.
   */
  | { readonly op: 'acquireSlot'; readonly exclusive: boolean }
  | { readonly op: 'releaseSlot'; readonly slot: number }
  /**
   * Change broadcast (docs/multi-tab.md), answered by the broker: relays
   * a committed change set to every OTHER tab holding `name` open.
   */
  | {
      readonly op: 'publishChanges';
      readonly name: string;
      readonly changes: ExternalChangeSet;
    }
  /**
   * Sync-lease request (broker-answered): granted when the asker holds
   * the lease, or it is free or expired. Asking again renews.
   */
  | { readonly op: 'syncTurn'; readonly name: string; readonly leaseMs: number }
);

export type WorkerResponse =
  | { readonly id: number; readonly ok: true; readonly result: unknown }
  | { readonly id: number; readonly ok: false; readonly error: string };

/** Unsolicited broker messages sent to a connected page. */
export type BrokerControlMessage =
  | { readonly control: 'spawnWorker' }
  | { readonly control: 'discardWorker' }
  | {
      readonly control: 'externalChanges';
      readonly name: string;
      readonly changes: ExternalChangeSet;
    }
  /** Another tab destroyed this database; every other holder is closed. */
  | { readonly control: 'databaseDestroyed'; readonly name: string };

/** Compute-worker handoff sent from a page to the broker. */
export type ClientControlMessage = {
  readonly control: 'adoptWorkerPort';
};
