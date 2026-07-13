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
import { serveSqliteWorker } from './server'
import type { Endpoint } from './protocol'

const scope = globalThis as unknown as {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
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
serveSqliteWorker(endpoint, () => init({ print: () => {}, printErr: () => {} }))
