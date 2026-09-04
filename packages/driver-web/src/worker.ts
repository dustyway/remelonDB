/**
 * The browser Worker entry: sqlite-wasm + the server, wired to the
 * dedicated-worker global scope. Loaded by WebSqliteDriver via
 * `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`
 * (bundlers resolve this pattern).
 *
 * Typed structurally instead of via lib "WebWorker" so the workspace can
 * typecheck without conflicting global libs.
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createSqliteWorkerServing } from './server';
import type { Endpoint } from './protocol';

interface PortLike {
  postMessage(message: unknown): void;
  addEventListener(
    type: 'message',
    listener: (event: { data: unknown }) => void,
  ): void;
  start?(): void;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- DedicatedWorkerGlobalScope is not in this project's lib, so the worker scope's own postMessage/addEventListener are declared here.
const scope = globalThis as unknown as {
  postMessage(message: unknown): void;
  addEventListener(
    type: 'message',
    listener: (event: { data: unknown; ports?: readonly PortLike[] }) => void,
  ): void;
};

const endpoint: Endpoint = {
  postMessage: (message) => {
    scope.postMessage(message);
  },
  addMessageListener: (listener) => {
    scope.addEventListener('message', (event) => {
      listener(event.data);
    });
  },
};

// the init options (print/printErr) are untyped in sqlite-wasm's d.ts,
// so this assertion adds what the runtime accepts. eslint's
// no-unnecessary-type-assertion misjudges it and its fixer breaks the
// call below; the disable is deliberate.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
const init = sqlite3InitModule as (options?: {
  print?: (message: string) => void;
  printErr?: (message: string) => void;
}) => ReturnType<typeof sqlite3InitModule>;

// silence sqlite-wasm's console chatter; errors still throw
const serve = createSqliteWorkerServing(() =>
  init({ print: () => {}, printErr: () => {} }),
);
serve(endpoint);

// Port adoption (docs/multi-tab.md): the spawning tab hands us a port
// wired to the SharedWorker broker; the same server answers on it.
scope.addEventListener('message', (event) => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the message is `unknown` across the boundary; the optional field is read defensively below rather than trusted.
  const data = event.data as { __remelondbAdoptPort?: boolean } | null;
  const port = event.ports?.[0];
  if (data?.__remelondbAdoptPort === true && port) {
    serve({
      postMessage: (message) => {
        port.postMessage(message);
      },
      addMessageListener: (listener) => {
        port.addEventListener('message', (portEvent) => {
          listener(portEvent.data);
        });
      },
    });
    port.start?.();
  }
});
