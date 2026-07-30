# todo-sync

A small offline-first todo list that syncs between devices. Three
packages, one shared schema:

- `backend/`: the shared schema (`schema.ts`), the client code both
  UIs reuse (`client.ts`), and a ~50-line sync server (`server.ts`)
- `frontend/`: a React web client
- `mobile/`: a React Native client (Expo)

What it demonstrates:

- One schema definition drives everything. The Zod object in
  `schema.ts` produces the client table, the record types, the model
  class, and the wire validators both sides use.
- Client code shared across platforms. The React bridge (`useQuery`)
  and the sync loop (`createSync`) live in `backend/client.ts`; the
  web and native apps differ only in their base URL and their styling
  (CSS vs `StyleSheet`).
- Local-first writes. Every create, edit, toggle, and delete lands in
  the device's own SQLite database first (OPFS on web, expo-sqlite on
  native); the UI updates through an observed query; sync runs in the
  background, deletes travelling as tombstones.
- Offline work. Cut the connection and keep going; changes push when it
  returns.
- A swappable server store. The backend runs in memory by default and
  on Postgres when `DATABASE_URL` is set (`backend/store.ts`, via
  `@remelondb/store-drizzle`) — same engine, same wire, same clients;
  only persistence changes.
- Conflicts, visibly. Concurrent changes to different fields of one
  todo merge field by field; a same-field race resolves through
  pull-and-retry, and both UIs surface a brief note while it happens.

## Run it

From the repository root:

```sh
pnpm install
pnpm --filter example-todo-sync server     # terminal 1: sync server on :8787
pnpm --filter example-todo-sync-web dev    # terminal 2: web client on :5173
```

The server keeps todos in memory (a restart empties the list). Point it
at Postgres and they persist — the same Zod object's keys become the
table's columns, stored via `@remelondb/store-drizzle`:

```sh
docker run -d -p 5433:5432 -e POSTGRES_PASSWORD=pg postgres:18-alpine
DATABASE_URL=postgres://postgres:pg@localhost:5433/postgres \
  pnpm --filter example-todo-sync server
```

For the mobile client (a development build, not Expo Go — the SQLite
driver is native code):

```sh
pnpm --filter example-todo-sync-native android   # build + launch on an emulator or device
```

Android emulators reach the local server automatically (`10.0.2.2`);
a physical device needs `EXPO_PUBLIC_SYNC_URL` pointing at a server it
can reach (see "Deploying the demo").

Open the web client twice — both ways work, and they demonstrate
different things. Two **tabs** in the same profile share one live
database (the client runs the driver's shared mode): edits mirror
between them instantly, no server involved. A **private** window or a
second browser has its own OPFS storage and plays the part of a second
device, syncing through the server. The lifecycle bootstrap is
`createDatabaseManager` + `useDatabaseState` from
`@remelondb/core/react` (see `src/db.ts` and `src/main.tsx` — three
lines each); shared mode and its fallback are covered in the
[driver README](../../packages/driver-web/README.md#multi-tab-usage)
and [docs/multi-tab.md](../../docs/multi-tab.md).

The script:

1. Add a todo in one window. It appears in the other within about two
   seconds.
2. Click a todo to toggle it done. The strike-through follows in the
   other window.
3. Edit a todo's text (Edit button on either platform; long-press also
   works on the phone). The new text follows too.
4. Delete a todo (confirm the dialog). It disappears from the other
   window too — deletes travel as tombstones, not as absence.
5. Go offline in one window (devtools network panel). Its dot turns
   red; keep adding and toggling. The other window sees none of it.
6. Go online again. The backlog pushes and both windows converge. For
   the conflict showpiece: while offline, edit a todo's text in one
   window and toggle the same todo in the other — on reconnect both
   changes survive in one row, and a same-field race shows the brief
   "push conflict" note while the losing side re-pulls and retries.

Stopping the server also works for step 5, with one caveat: state lives
in memory (`createMemoryStore`), so a restart loses it. Clients then
receive `resyncRequired` on their next pull and re-pull from scratch.
Unpushed local changes survive that and are pushed afterwards; todos
the server had already accepted are gone, because the server genuinely
lost them.

## Tests

```sh
pnpm --filter example-todo-sync-web e2e
```

boots both processes and replays the story in headless Chromium as
eight steps: two isolated browser contexts (each with its own OPFS),
create and toggle propagation in both directions, an outage in which
offline writes stay local, recovery, a same-row race in which the
losing push receives `conflict` and re-pulls (the winning push is held
at the network layer until the other client commits, so the conflict
is deterministic, not timing luck), a server restart after which both
clients receive `resyncRequired`, re-pull from scratch, and only
unpushed local writes survive, and a field-level merge in which an
offline text edit and a remote toggle of the same todo both survive
the reunion. CI runs this on every push.

## Files worth reading

- `backend/schema.ts`: the single source of truth, about ten lines.
- `backend/requests.http`: the wire protocol as clickable requests
  (JetBrains HTTP client / VS Code REST Client) — every outcome the
  spec defines, from the happy path to `conflict`, `resyncRequired`,
  and validation rejections.
- `backend/server.ts`: the entire backend. `createSyncEngine` +
  `createMemoryStore` behind two `node:http` routes, requests validated
  with the same wire schemas the client validates responses with.
- `backend/client.ts`: everything the two UIs share. The React bridge
  (`useQuery`, twelve lines — `observe()` is the reactivity, the hook
  only pipes emissions into state) and `createSync`: `synchronize()`
  with wire validation and a small sync-status store the UI's colored
  dot subscribes to. Each app's own `sync.ts` supplies only its base
  URL.
- `frontend/e2e/steps.mjs`: the story as executable steps, including the
  deterministic conflict and the resync after a server wipe.
- `backend/serve.ts` and `Dockerfile`: a deployment of the demo as one
  container — the same sync routes plus static serving of the built
  web client.
- `frontend/vite.config.ts`: the one integration trap. The
  driver chain must be excluded from Vite's dependency pre-bundling,
  otherwise the driver's worker URL points nowhere and opening the
  database hangs.
- `mobile/metro.config.js`: the same lesson for React Native — Metro
  must be taught the workspace root, or workspace-linked packages
  don't resolve.

## What it does not demonstrate

The gaps are as deliberate as the coverage; each has a better home:

- **Migrations.** The schema has never moved past version 1, so the
  `schemaVersion`/`migration` fields ride along unused on every pull.
- **Scoping.** The server runs `engine.as('everyone')`: one shared
  list, no accounts. Per-user scopes are an engine feature this demo's
  no-auth design does not reach.
- **Custom conflict resolution.** `synchronize()` accepts a
  `conflictResolver`; the example uses the default.
- **A realistic sync trigger.** The app syncs every two seconds so two
  windows converge while you watch. That is demo pacing, not a
  recommendation — a real app syncs on app start, on foreground, on
  `online`, and after each local write, and adds a server signal only
  when changes arrive faster than sessions do.
  [docs/sync-triggering.md](../../docs/sync-triggering.md) has the
  decision and the tradeoffs.
- **Rejection handling in the UI.** The server validates every pushed
  row at the door, but the app never sends an invalid row, so nothing
  in the UI reacts to a rejection. `backend/requests.http` and
  [docs/sync-tour.md](../../docs/sync-tour.md) show the wire responses.
- **Protocol edge cases** (partial lost pushes, id reuse, full
  rejection) are specified in [docs/sync-wire.md](../../docs/sync-wire.md)
  and verified by the formal model and the conformance suites, not by
  this app.

## Deploying the demo

```sh
docker build -f examples/todo-sync/Dockerfile -t todo-sync .   # repo root
docker run -p 8787:8787 todo-sync
```

`backend/serve.ts` serves the built web client and the sync routes
from one process; put any TLS-terminating reverse proxy in front.
Without a `DATABASE_URL` the memory store means one shared
world-writable list that resets on restart — acceptable for a demo,
nothing more. Pass the container a `DATABASE_URL` and the list persists
in Postgres instead — as a compose pair:

```yaml
services:
  todo-sync:
    image: todo-sync
    ports: ["8787:8787"]
    environment:
      DATABASE_URL: postgres://postgres:${DB_PASSWORD}@todo-db:5432/postgres
    depends_on: [todo-db]
  todo-db:
    image: postgres:18-alpine
    environment:
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - todo-db-data:/var/lib/postgresql
volumes:
  todo-db-data:
```

The server creates its own tables on first start; no migrations to run.
Postgres 18's image wants its volume at `/var/lib/postgresql` (not the
older `/data` suffix), and a reverse proxy that resolves upstreams at
config load needs a reload after the app container is recreated.
For a device build of the mobile app, set `EXPO_PUBLIC_SYNC_URL` (a
`.env.local` in `mobile/` works) to point it at the deployed server.

## Copying this into your own project

Inside this repository the example depends on the workspace sources
(`workspace:*`), which is why the server runs through `tsx`. In your
own project, depend on the published packages instead:

```sh
npm install @remelondb/core @remelondb/driver-web @remelondb/server zod
```

The published packages ship compiled JavaScript with type
declarations, so no TypeScript-aware runner is needed beyond your
normal build.

One thing not to copy verbatim: the two-second sync interval in
`App.tsx`. Replace it with the arrival triggers described in
[docs/sync-triggering.md](../../docs/sync-triggering.md) — on a phone,
a two-second poll keeps the radio awake continuously.
