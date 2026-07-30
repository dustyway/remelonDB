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

The recommended app bootstrap is the database manager — one shared
open, retryable failure, takeover handled — with the React hook for
lifecycle state:

```ts
import { createDatabaseManager, Database } from '@remelondb/core'
import { useDatabaseState } from '@remelondb/core/react'
import { WebSqliteDriver } from '@remelondb/driver-web'

const manager = createDatabaseManager({
  open: (onTakenOver) =>
    Database.open({
      driver: new WebSqliteDriver({ shared: true, takeover: true, onTakenOver }),
      schema,
      migrations,
      modelClasses: [Task],
      name: 'app.db',
    }),
})

// in a component: const { status, error } = useDatabaseState(manager)
// when status is 'ready': manager.database
```

`Database.open` is the primitive underneath — fine to call directly in
tests and scripts; apps should let the manager own the lifecycle. The
todo-sync example's `frontend/src/db.ts` is the working reference.

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
rule) — it does not corrupt anything, does not silently fall back to
memory, and the error says what is going on: the database is open in
another tab.

**Single-owner with takeover** is built into the driver. Tabs
coordinate through a Web Lock (`remelondb:<name>`) held for the
connection's lifetime:

```ts
const driver = new WebSqliteDriver({
  takeover: true,          // take the database from another tab
  onTakenOver: () => {     // ...and learn when one takes it from us
    showBanner('This app was opened in another tab.')
  },
})
```

- Default (`takeover` unset): opening a database another tab holds
  rejects with `'<name>' is open in another tab or window`.
- `takeover: true`: `open()` steals the lock. The losing driver
  terminates its worker — which is what releases the pool's handles;
  in-flight statements there are abandoned, committed data is safe on
  disk — fires its `onTakenOver` callback, and every later call on it
  rejects with a clear error. The winning `open()` retries until the
  handles come free (tab death also releases them via worker teardown,
  so the retry always converges).
- Environments without the Web Locks API (Node tests, non-secure
  contexts) skip coordination entirely and behave as before.

Only one tab is active at a time, but the handoff is explicit and
nothing can race.

The same rule rules out background sync on the web. A service worker
woken by Web Push cannot open the database to sync: it either fails
because a tab holds it, or takes it over and terminates that tab's
worker. So Web Push can tell the user something changed; the data
lands when the tab is next opened or focused. The Background Sync API
is blocked for the same reason. Mobile has no such restriction — see
[when to sync](https://github.com/dustyway/remelonDB/blob/main/docs/sync-triggering.md).

For every tab live simultaneously, opt in to **shared mode**:

```ts
const driver = new WebSqliteDriver({ shared: true })
```

All tabs then route through one SharedWorker broker to a single
connection: same-name opens share it instead of contending (no lock,
no takeover), commits in any tab reach every other tab's record cache
and observers, and `db.write` blocks are serialized across tabs by the
broker so racing read-modify-write converges (see "The RPC protocol"
below and [docs/multi-tab.md](../../docs/multi-tab.md) for the design,
including the ordering invariant; [docs/multi-tab.qnt](../../docs/multi-tab.qnt)
model-checks it). Where `SharedWorker` is unavailable (Chrome for
Android), the option gracefully falls back to the single-owner
behavior above — same API, same errors, the takeover UI simply becomes
reachable again.

Sync also coordinates itself: `synchronize` runs only in the tab
holding the broker's sync lease (renewed on each tick, inherited when
the holder closes), so a naive per-tab sync interval is correct. The
remaining sharp edges before shared mode becomes the default are the
open questions in docs/multi-tab.md.

## The RPC protocol

Every request carries an `id`; the answering side replies with
`{id, ok, result}` or `{id, ok: false, error}`. Requests and responses
are structured-clonable plain data (`src/protocol.ts` is the source of
truth). Who answers depends on the op:

| Op | Answered by | Purpose |
| --- | --- | --- |
| `open` | worker | open by name, report `user_version` (async: awaits pool install) |
| `close` | worker | close the named connection |
| `query` / `execute` | worker | one SELECT / one non-SELECT statement |
| `executeBatch` | worker | atomic multi-statement transaction |
| `setUserVersion` | worker | `PRAGMA user_version` after setup/migration |
| `destroy` | worker | delete the database and sidecar files |
| `ping` | worker | liveness probe (the broker checks its compute channel) |
| `acquireSlot` / `releaseSlot` | broker | cross-tab write-block arbitration (never reach SQLite) |
| `publishChanges` | broker | relay a commit's change set to the other tabs |
| `syncTurn` | broker | sync-lease request: grant/renew for the holder, deny others |

In shared mode the broker additionally pushes two unsolicited control
messages to tabs: `{control: 'spawnWorker'}` (asking a tab to host the
compute worker) and `{control: 'externalChanges', name, changes}`
(another tab's commit). In dedicated mode only the worker-answered ops
occur, over a direct Worker transport.

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

### Known flake: Playwright-WebKit OPFS pool reuse

`BROWSER=webkit` is retried up to 3× (`vitest.browser.config.ts`); the
other targets are not. Playwright's WebKit build has a timing-dependent
OPFS SAH-pool bug: when the conformance suite churns ephemeral databases
through the one shared pool, a recycled slot occasionally returns stale
state, so a just-created table reads back missing (`SQLITE_ERROR: no
such table`) or a fresh database reads as corrupt (`SQLITE_NOTADB`).

It reproduces only on Playwright-WebKit — **real Safari (safaridriver)
and Chromium pass the identical suite on every run** — and it clears on
immediate re-run, which is what the retry absorbs. It is not a product
bug: applications open one long-lived database and never churn the pool
this way (verified: a full write cycle per database over a fresh pool
never corrupts; the failure needs the shared-pool open/destroy churn the
tests create). Ruled out as causes: the request dispatcher (serialized,
covered by `server.concurrency.test.ts`), pool capacity (fails at 512
too), `unlink` accumulation (pool stays at one file), and stale
sqlite-wasm (already on the latest, 3.53.0-build1, which carries the
2023 SAH-pool filename-buffer fix). A green WebKit run still means every
test passed. To reproduce the raw flake, set the WebKit `retry` to 0.
