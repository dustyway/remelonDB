# @watermelon-rewrite/driver-web

The browser `SqliteDriver`: **SQLite-WASM running in a dedicated Worker**,
persistent via the OPFS SyncAccessHandle pool VFS, reached over a
postMessage RPC. This is the architecture the whole seam was designed
around: OPFS sync-access handles exist only in workers, the main thread
can only reach a worker asynchronously — hence the Promise-shaped driver
contract everywhere.

## Status: core verified against real sqlite-wasm; OPFS is browser-pending

The worker-side server is transport-abstracted (`Endpoint`), so the test
suite runs the **exact same server code against real SQLite-WASM
in-process under Node** — driver → RPC → wasm SQLite, end to end,
including the full stack (Database, models, observation, sync) on top.
What Node cannot provide is OPFS itself; the `storage: 'opfs'` path needs
a real browser run (checklist below).

## Usage

```ts
import { Database } from '@watermelon-rewrite/core'
import { WebSqliteDriver } from '@watermelon-rewrite/driver-web'

const db = await Database.open({
  driver: new WebSqliteDriver(), // storage: 'opfs' by default
  schema,
  migrations,
  modelClasses: [Task],
  name: 'app.db',
})
```

- **Persistence is never silently downgraded**: the default `storage:
  'opfs'` fails loudly if OPFS is unavailable (old browser, sandboxed
  iframe, Node). Pass `storage: 'memory'` only when non-persistence is
  intended (previews, tests).
- The OPFS SAH-pool VFS needs **no COOP/COEP headers** (unlike the
  SharedArrayBuffer-based VFS).
- The worker is spawned via
  `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`
  — Vite and comparable bundlers resolve this pattern and bundle the
  worker (including the wasm asset from `@sqlite.org/sqlite-wasm`).

## Layout

| Piece | Role |
| --- | --- |
| `src/protocol.ts` | RPC message types + the `Endpoint` transport abstraction |
| `src/server.ts` | worker-side server: connections by name, statement cache, boolean→0/1 binding, atomic batches with rollback, OPFS/memory storage resolution |
| `src/worker.ts` | browser Worker entry (sqlite-wasm init + server) |
| `src/WebSqliteDriver.ts` | main-thread driver: request/response correlation, seam contract |

## Browser-verification checklist

- [x] Full driver contract against real sqlite-wasm (Node, in-process
      endpoint): round-trip, batch rollback, boolean binding,
      user_version, error surfaces
- [x] Full stack on the driver: Database + models + observation + sync
- [x] Loud failure when OPFS is unavailable (no silent downgrade)
- [x] `storage: 'opfs'` in real Chromium (vitest browser mode +
      Playwright): the FULL conformance suite on OPFS, persistence,
      `destroy()` unlinking pool + journal files, and durability across
      worker termination (page-reload equivalent). Run:
      `pnpm --filter @watermelon-rewrite/driver-web test:browser`
- [x] Worker + wasm loading through the Vite pipeline (vitest browser
      mode) — a production Vite app build remains a one-time smoke test
- [ ] Multi-tab behavior (SAH pool is single-connection by design —
      document the recommended SharedWorker/leader-election pattern)
