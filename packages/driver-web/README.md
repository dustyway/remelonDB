# @remelondb/driver-web

The browser `SqliteDriver`: **SQLite-WASM running in a dedicated Worker**,
persistent via the OPFS SyncAccessHandle pool VFS, reached over a
postMessage RPC. This is the architecture the whole seam was designed
around: OPFS sync-access handles exist only in workers, the main thread
can only reach a worker asynchronously, hence the Promise-shaped driver
contract everywhere.

## Status: verified on OPFS in Chromium, Firefox, WebKit, and Safari

The worker-side server is transport-abstracted (`Endpoint`), so the test
suite runs the **exact same server code against real SQLite-WASM
in-process under Node**: driver → RPC → wasm SQLite, end to end,
including the full stack (Database, models, observation, sync) on top.
The `storage: 'opfs'` path additionally runs as a real-browser
conformance suite on all three engines, plus real Safari via
safaridriver (checklist below).

## Usage

```ts
import { Database } from '@remelondb/core'
import { WebSqliteDriver } from '@remelondb/driver-web'

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

## Multi-tab usage

The OPFS SAH-pool VFS acquires **exclusive** sync access handles: one
connection per database, full stop. A second tab that tries to open the
same database fails loudly (consistent with the no-silent-downgrade
rule) — it does not corrupt anything, and it does not silently fall
back to memory.

So a multi-tab app must route every tab through one connection. Two
patterns, in order of preference:

1. **Web Locks leader election** (works everywhere, including Chrome
   for Android, which has no `SharedWorker`): every tab requests the
   same exclusive lock; the winner opens the `Database` and serves the
   others over a `BroadcastChannel`. The lock releases automatically
   when the leader tab closes, and the next tab in line takes over and
   reopens.

   ```ts
   navigator.locks.request('remelondb:app.db', async () => {
     const db = await Database.open({ driver: new WebSqliteDriver(), ... })
     serveOverBroadcastChannel(db)          // your RPC layer
     await new Promise(() => {})            // hold the lock for tab lifetime
   })
   // tabs that don't hold the lock talk to the leader instead
   ```

2. **A `SharedWorker` owning the database**: move `Database.open` (or
   just the driver) into a SharedWorker that every tab connects to.
   Structurally simpler — one owner by construction, no election, no
   handover — but unavailable on Chrome for Android.

Neither is shipped as a helper yet; the driver deliberately stays a
single-connection seam. If you only target desktop browsers, prefer the
SharedWorker; if Android web matters, use the lock election.

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
- [x] `storage: 'opfs'` in real Chromium, Firefox, and WebKit (vitest
      browser mode + Playwright): the FULL conformance suite on OPFS,
      persistence, `destroy()` unlinking pool + journal files, and
      durability across worker termination (page-reload equivalent). Run:
      `pnpm --filter @remelondb/driver-web test:browser` (`BROWSER=firefox`
      / `BROWSER=webkit` for the others; WebKit needs the persistent
      context wired up in `vitest.webkit-provider.ts` — ephemeral WebKit
      contexts have no OPFS backing store. WebKit OPFS is macOS-only:
      the Linux GTK port doesn't ship the sync-access-handle APIs, so
      CI runs WebKit on a macOS runner)
- [x] Real Safari via `BROWSER=safari` (webdriverio + safaridriver,
      macOS only): the full conformance suite, 51/51. One-time setup:
      enable "Allow remote automation" in Safari's Developer settings
      (`sudo safaridriver --enable`). Not headless — Safari can't. Only
      one automation session may exist; kill stray `safaridriver`
      processes if the session refuses to start.
- [x] Worker + wasm loading through the Vite pipeline (vitest browser
      mode) **and a real production build**: `pnpm --filter
      @remelondb/driver-web smoke:vite` packs the tarballs, scaffolds a
      Vite app consuming them the way the root README documents,
      `vite build` + `vite preview`, and drives headless Chromium at the
      output — OPFS open from the production bundle, data persisted
      across a page reload
- [x] Multi-tab behavior: single-connection by design, documented below
      (see "Multi-tab usage")
