/**
 * In-process transport for tests: the same SqliteWorkerServer that runs
 * inside a browser Worker, wired to the driver through paired endpoints
 * delivering asynchronously like postMessage. Real sqlite-wasm, no
 * browser required.
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { Endpoint } from './protocol';
import { serveSqliteWorker } from './server';
import { WebSqliteDriver } from './WebSqliteDriver';

export function createChannel(): [Endpoint, Endpoint] {
  const aListeners: Array<(m: unknown) => void> = [];
  const bListeners: Array<(m: unknown) => void> = [];
  const post = (peers: Array<(m: unknown) => void>) => (message: unknown) => {
    // clone at the send, like postMessage: a test must fail here on
    // anything a real structured clone would reject or flatten
    const cloned = structuredClone(message);
    queueMicrotask(() => {
      peers.forEach((listener) => {
        listener(cloned);
      });
    });
  };
  return [
    {
      postMessage: post(bListeners),
      addMessageListener: (l) => aListeners.push(l),
    },
    {
      postMessage: post(aListeners),
      addMessageListener: (l) => bListeners.push(l),
    },
  ];
}

// the init options (print/printErr) are untyped in sqlite-wasm's d.ts,
// so this assertion adds what the runtime accepts. eslint's
// no-unnecessary-type-assertion misjudges it and its fixer breaks the
// call below; the disable is deliberate.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
const init = sqlite3InitModule as (options?: {
  print?: (message: string) => void;
  printErr?: (message: string) => void;
}) => ReturnType<typeof sqlite3InitModule>;
const sqlite3 = init({ print: () => {}, printErr: () => {} });

/** A driver wired to a fresh in-process server, memory storage. */
export function createInProcessDriver(): WebSqliteDriver {
  const [driverSide, serverSide] = createChannel();
  serveSqliteWorker(serverSide, () => sqlite3);
  return new WebSqliteDriver({
    storage: 'memory', // OPFS needs a real browser worker
    createEndpoint: () => driverSide,
  });
}
