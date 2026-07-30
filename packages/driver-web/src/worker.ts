/**
 * The browser Worker entry: sqlite-wasm + the server, wired to the
 * dedicated-worker global scope. Loaded by WebSqliteDriver via
 * `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`
 * (bundlers resolve this pattern).
 *
 * Typed structurally instead of via lib "WebWorker" so the workspace can
 * typecheck without conflicting global libs.
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { createSqliteWorkerServing } from './server'
import type { Endpoint } from './protocol'

interface PortLike {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  start?(): void
}

const scope = globalThis as unknown as {
  postMessage(message: unknown): void
  addEventListener(
    type: 'message',
    listener: (event: { data: unknown; ports?: readonly PortLike[] }) => void,
  ): void
}

const endpoint: Endpoint = {
  postMessage: (message) => scope.postMessage(message),
  addMessageListener: (listener) =>
    scope.addEventListener('message', (event) => listener(event.data)),
}

// the init options (print/printErr) are untyped in sqlite-wasm's d.ts
const init = sqlite3InitModule as (options?: {
  print?: (message: string) => void
  printErr?: (message: string) => void
}) => ReturnType<typeof sqlite3InitModule>

// silence sqlite-wasm's console chatter; errors still throw
const serve = createSqliteWorkerServing(() =>
  init({ print: () => {}, printErr: () => {} }),
)
serve(endpoint)

// Port adoption (docs/multi-tab.md): the spawning tab hands us a port
// wired to the SharedWorker broker; the same server answers on it.
scope.addEventListener('message', (event) => {
  const data = event.data as { __remelondbAdoptPort?: boolean } | null
  const port = event.ports?.[0]
  if (data?.__remelondbAdoptPort === true && port) {
    serve({
      postMessage: (message) => port.postMessage(message),
      addMessageListener: (listener) =>
        port.addEventListener('message', (portEvent) => listener(portEvent.data)),
    })
    port.start?.()
  }
})
