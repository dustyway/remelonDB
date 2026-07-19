# todo-sync

A small offline-first todo list that syncs between browsers. Two
packages:

- `examples/todo-sync` (this directory): the shared schema
  (`schema.ts`) and a ~50-line sync server (`server.ts`)
- `examples/todo-sync-web`: a React client

What it demonstrates:

- One schema definition drives everything. The Zod object in
  `schema.ts` produces the client table, the record types, the model
  class, and the wire validators both sides use.
- Local-first writes. Every change lands in the browser's own SQLite
  database (OPFS) first; the UI updates through an observed query; sync
  runs in the background.
- Offline work. Cut the connection and keep going; changes push when it
  returns.

## Run it

From the repository root:

```sh
pnpm install
pnpm --filter example-todo-sync server     # terminal 1: sync server on :8787
pnpm --filter example-todo-sync-web dev    # terminal 2: web client on :5173
```

Open the client twice: one normal window and one **private** window.
Two tabs in the same profile share one OPFS database (and the driver
holds a single connection), so a private window or a second browser is
what plays the part of a second device. A second normal tab gets a
clear "open in another tab" error; the driver's takeover option and
the planned every-tab-live design are covered in the
[driver README](../../packages/driver-web/README.md#multi-tab-usage)
and [docs/multi-tab.md](../../docs/multi-tab.md).

The script:

1. Add a todo in one window. It appears in the other within about two
   seconds.
2. Click a todo to toggle it done. The strike-through follows in the
   other window.
3. Go offline in one window (devtools network panel). Its dot turns
   red; keep adding and toggling. The other window sees none of it.
4. Go online again. The backlog pushes and both windows converge.

Stopping the server also works for act 3, with one caveat: state lives
in memory (`createMemoryStore`), so a restart loses it. Clients then
receive `resyncRequired` on their next pull and re-pull from scratch.
Unpushed local changes survive that and are pushed afterwards; todos
the server had already accepted are gone, because the server genuinely
lost them.

## Tests

```sh
pnpm --filter example-todo-sync-web e2e
```

boots both processes and replays the script in headless Chromium: two
isolated browser contexts (each with its own OPFS), create and toggle
propagation in both directions, an outage in which offline writes stay
local, and recovery. CI runs this on every push.

## Files worth reading

- `schema.ts`: the single source of truth, about ten lines.
- `server.ts`: the entire backend. `createSyncEngine` +
  `createMemoryStore` behind two `node:http` routes, requests validated
  with the same wire schemas the client validates responses with.
- `../todo-sync-web/src/useQuery.ts`: the whole React bridge, twelve
  lines. `observe()` is the reactivity; the hook only pipes emissions
  into state.
- `../todo-sync-web/src/sync.ts`: `synchronize()` with wire validation
  and a small sync-status store the UI's colored dot subscribes to.
- `../todo-sync-web/vite.config.ts`: the one integration trap. The
  driver chain must be excluded from Vite's dependency pre-bundling,
  otherwise the driver's worker URL points nowhere and opening the
  database hangs.

## Copying this into your own project

Inside this repository the example depends on the workspace sources
(`workspace:*`), which is why the server runs through `tsx`. In your
own project, depend on the published packages instead:

```sh
npm install @remelondb/core @remelondb/driver-web @remelondb/server @remelondb/zod zod
```

The published packages ship compiled JavaScript with type
declarations, so no TypeScript-aware runner is needed beyond your
normal build.
