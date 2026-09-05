# React bindings

Reference guide for `@remelondb/core/react`: the provider, the manager
hooks, and the query hooks. React is an optional peer dependency; this
subpath is the only part of core that imports it, and it loads only
when imported.

The problem these solve is the usual impedance mismatch. The database
is push-based and lives in time: `query.observe(cb)` calls back now and
on every future change until unsubscribed. A React component is
pull-based and lives per render: a pure function of current state,
re-executed at React's discretion, with no native notion of a stream.
The bindings carry traffic between the two — subscribe once per
component and query, turn emissions into re-renders, tear down
reliably — so application code never writes that wiring. Everything
rides `useSyncExternalStore`, which makes the hooks safe under
concurrent rendering and StrictMode's deliberate double-mounting.

## Setup

Wrap the tree in a provider to unlock the zero-argument hooks:

```tsx
import { DatabaseProvider } from '@remelondb/core/react';
import { manager } from './db';

<DatabaseProvider manager={manager}>
  <App />
</DatabaseProvider>;
```

The provider is a convenience, not a requirement: `useDatabaseState`
accepts an explicit manager argument, and the query hooks need no
provider at all (a query already knows its database). Tests and
multi-database setups can skip the provider entirely.

## Manager hooks

```tsx
const { status, error } = useDatabaseState(); // lifecycle transitions
const db = useDatabase(); // Database | null until ready
```

The two hooks answer different questions. `useDatabaseState` is for
the component that reacts to lifecycle. That can be a blocking gate
(spinner, error screen, or app), but the shape that fits offline-first
better is a banner: render the UI immediately, and mount one component
that shows nothing while the manager is healthy and surfaces
`taken-over` or `error` with a retry button. It re-renders exactly on
manager state transitions (`idle`, `loading`, `ready`, `taken-over`,
`error`).

Every other component only needs the database itself. Deriving it by
hand (`state.status === 'ready' ? manager.database : null`) invites a
crash, since `manager.database` throws before ready. `useDatabase` is
that derivation done once: null until ready, then the open database,
re-rendering only when readiness changes. Its null flows into the
query hooks below, which idle until the database arrives; that
null-flow is what makes the non-blocking shape work.
Both take an optional explicit manager and otherwise read the provider;
calling them with neither throws immediately with instructions.

The sync sibling is `useSyncState(controller)`: the state of a
[`createSyncController`](sync.md#the-sync-controller) as a
subscription, re-rendering exactly on transitions.

```tsx
const { status, lastResult } = useSyncState(controller);
// status: 'idle' | 'syncing' | 'offline' | 'error' | 'resync-required'
```

It takes the controller explicitly (there is no controller provider;
apps typically own one per authenticated database next to the
manager). `lastResult` carries the rejection fields; folding them, and
the five statuses, into whatever your UI shows is the component's
decision.

## The session hook

`useSessionDatabase` owns the whole per-user lifecycle: one manager for
the signed-in user, a sync controller running whenever that database is
ready, teardown in the right order when the session ends, and the next
session's open queued behind the previous close.

```tsx
const { manager, syncController, closeError } = useSessionDatabase({
  userId, // null while signed out
  createManager: (id) => createUserDatabaseManager(id),
  sync: { pullChanges, pushChanges },
  controller: { triggers: browserSyncTriggers },
});
```

It renders nothing. Wrap the tree yourself once the manager exists:

```tsx
if (!manager) return <SignedOut />;
return (
  <DatabaseProvider manager={manager}>
    <App controller={syncController} />
  </DatabaseProvider>
);
```

**Where you call it is part of the contract.** The queue that makes the
next open wait for the previous close lives in the hook, so it lives as
long as the component calling it. Call it from something that stays
mounted across session _and_ route changes, and let route layouts read
the manager from context. Calling it inside a layout your router
unmounts brings back the race it prevents: the queue is empty again on
remount, so the next open has nothing to wait for, and routers destroy
and recreate a layout faster than a close finishes. Nothing in the types
stops you putting it in the wrong place.

Sync attaches whenever the database is ready and detaches when it is
not, rather than following one `init()` call. Two things follow. A
database recovered by something else — an error banner's Retry calling
`init()` on the manager — still gets sync. And a reopen after an error
hands back a different `Database`, so the controller is rebuilt against
it rather than left pointing at the old one.

`createManager`, `sync`, and `controller` are read when a session
starts, so passing fresh object literals every render does not restart
the database you already opened. Changing them affects the next session.

Pass `userId: null` while the session check is still running, not just
when signed out. A user id that might change on the next tick would
open a file the hook then has to close.

The result is tagged with the user it belongs to, so the render
React does after a session change but before the effect cleans up hands
back nulls rather than the previous account's database.

In StrictMode the effect runs, cleans up, and runs again. Because a
manager is created only once the previous close has finished, the
discarded run usually creates nothing at all: its cleanup lands first
and cancels it. If it did get as far as a manager, the run that
replaces it waits for that one's close, the same as any session
change.

A session's manager is not created until the previous session's close
has finished. Not merely unopened: not handed to you at all, since a
manager you hold is one you could `init()` yourself, around the wait.
Cleanup closes straight away rather than queueing, because `close()` is
what invalidates an open still in flight — queue it and a logout during
a slow open lets that database arrive with nobody closing it.

A close that fails stops the next session rather than starting one.
That database may still be open, and a second one over the same file is
the thing this hook exists to prevent, so `closeError` carries the
failure and `manager` stays null. It is sticky, like the manager's own
failed close: recovery is a reload, not another attempt.

## Query hooks

```tsx
const db = useDatabase();
const {
  data: decks,
  isLoading,
  error,
} = useQuery(db && db.get(Deck).query(Q.sortBy('created_at', Q.desc)));
const due = useQueryCount(db && dueCardsQuery(db, now));
const dueState = useQueryCountResult(db && dueCardsQuery(db, now));
```

`useQuery` subscribes to a query's results and re-renders whenever
matching local data changes — user writes and applied sync pulls alike.
`useQueryCount` does the same through the engine's cheaper count
observation and returns a plain number. `useQueryCountResult` exposes the
same count as `{ data, isLoading, error }`; the two hooks share one
underlying observation. All accept `null`/`undefined`
for the not-ready phase: `useQuery(null)` is `{ data: [], isLoading:
false, error: null, isPreviousData: false }`, `useQueryCount(null)`
is `0`.

### No dependency arrays: structural identity

There is deliberately no deps argument anywhere. Queries are data — a
frozen description plus a table — so the hooks key their subscription
on that _structure_, not on object identity. Rebuilding an equivalent
query every render is free and reuses the live subscription; changing
the query's actual content (a different `Q.where`, another table) tears
down and resubscribes. The class of stale-dependency bugs that
`useMemo`-wrapped subscriptions invite cannot be expressed against this
API.

The corollary: the first structurally-equal query instance is the one
that gets observed; later equivalent instances are ignored. Since
equivalent queries return equivalent results by definition, this is
invisible — but a query whose _meaning_ depends on out-of-band state it
does not encode (nothing in Q does this) would be miskeyed.

### Shared subscriptions

Components observing structurally equal queries on the same database
share one live observation, refcounted: the first subscriber starts it,
the last one leaving stops it and drops it from the registry. A screen
where a header badge, a list, and a footer all watch the same query
costs one observation, not three. Sharing is per database instance, so
independent databases never cross.

This also sets the default for app structure: subscribe in the
component that renders the data, rather than funneling every query
through one aggregate store hook. An aggregate hook re-renders all its
consumers when any of its queries changes; fine-grained hooks cost the
same single observation per distinct query and re-render less.

### Deriving values: `select`

```tsx
const { data: count } = useQuery(q, { select: (rows) => rows.length });
const { data: newest } = useQuery(q, { select: (rows) => rows[0] ?? null });
```

`select` derives the rendered value from the rows, per consumer — two
components can select differently from one shared subscription. It
recomputes when either the rows or selector identity changes, so a selector
that closes over changing props stays correct without restarting the query
observation. Selectors must be pure; memoize an expensive selector if its
inputs are stable.

For anything richer than per-row derivation, reach for the query
language first: joins and conditions belong in Q, where the engine
evaluates them and one subscription covers the composed result (see
[the one-engine rule](../layers.md#the-q-dsl-and-the-one-engine-rule)). The bindings
deliberately ship no stream operators — combining, debouncing, and
switching between live results is a job for a dedicated reactive
library on top, not for this module.

### Query changes: `keepPreviousData`

```tsx
const { data, isPreviousData } = useQuery(searchQuery(term), {
  keepPreviousData: true,
});
```

When the query's structure changes (a new search term, another page),
the subscription is keyed on the new structure and starts empty — by
default the hook drops to `isLoading: true` and the list blanks out.
With `keepPreviousData: true` the hook keeps rendering the previous
query's rows until the new one delivers. The transition is visible as
`isPreviousData: true` (dim the list, keep it interactive);
`isLoading` stays reserved for having nothing renderable at all.

The semantics, precisely:

- The first delivery of the new query replaces the rows and clears
  `isPreviousData`. Success always wins.
- If the new query _fails_ before its first delivery, the error
  surfaces immediately in `error` while the previous rows stay
  rendered and `isPreviousData` stays true; the first later success
  clears both.
- Retention is per consumer and never enters the shared query store:
  two components arriving at the same query from different previous
  queries each keep their own rows, and a third component subscribing
  fresh sees a plain loading state.
- Retained rows are dropped the moment the database object changes
  (switching accounts never flashes one user's rows under another) or
  the query becomes null.
- `select` applies to whatever is rendered, previous rows included.

One steering note: for a periodically re-parameterized query over a
bounded row set (a due-by-now clause re-keying every few seconds),
prefer a stable query plus `select`. It recomputes locally instead of
restarting the observation on every tick. `keepPreviousData` is for
queries that genuinely must change — search, pagination — where the
row set can't be pulled whole and derived from.

## Mutations: `useMutation`

The write-side counterpart of the query hooks. Wrap an async write and
get state instead of a bare promise to babysit:

```ts
import { useMutation } from '@remelondb/core/react';

const { mutate, mutateAsync, data, error, isPending, reset } = useMutation(
  (title: string) => db.write(() => db.get(Deck).create({ title })),
);
```

`mutate(...args)` is fire-and-observe: it returns `void`, so a floating
call is safe by construction, and a failure lands in `error` rather
than becoming an unhandled rejection. `mutateAsync(...args)` keeps
normal promise semantics (resolves with the result, rejects with the
original error) for flows that must continue only after success:

```ts
const onSubmit = async (fields: FormFields) => {
  await mutateAsync(fields.title);
  closeDialog(); // only reached when the write committed
};
```

The two entry points are deliberate. A `mutate` that both swallowed
rejection and returned a promise would let `await mutate()` continue
down the success path after a failure, which is the exact bug the hook
exists to prevent: a dialog dismissed on a failed write reports a
success the database never agreed to.

State semantics:

- `isPending` is true while any tracked invocation is in flight; use it
  to disable the submit control.
- `data` and `error` are owned by the latest invocation. A stale
  completion arriving out of order only drains `isPending` and cannot
  overwrite newer state.
- Starting a new invocation clears the previous `error`; `data` keeps
  its last value until the owning invocation replaces it.
- `reset()` returns to idle; in-flight completions are ignored.
- Completions after unmount are inert.
- The mutation function is read at call time, so a re-render capturing
  a new closure is picked up without any dependency array.

## Migrating from a hand-rolled bridge

If you already wrote a `useState`/`useEffect` bridge over `observe()`,
these hooks replace it wholesale, and call sites barely change: the
result shape here is the same `{ data, isLoading, error }`, so the
usual diff is one line per site.

```tsx
// before: factory plus dependency array
const { data } = useQuery(() => (db ? getDecksQuery(db) : null), [db]);

// after: plain expression, no deps
const { data } = useQuery(db && getDecksQuery(db));
```

What to delete along with the bridge file:

- Query factories and dependency arrays. Structural keying makes a
  rebuilt query free, so the plain expression is enough (see above).
- The by-hand database derivation
  (`status === 'ready' ? manager.database : null`) and any effect that
  calls `manager.init()` when idle. `useDatabase()` covers the first;
  calling `manager.init()` once at app start covers the second.
- Aggregate store hooks whose job was letting components share query
  results. Sharing is built in, so subscribe where you render (see
  Shared subscriptions above).

Behavior differences to expect, all in the migration's favor: equal
queries across components share one observation instead of one per
mount, the hooks are tear-safe under StrictMode's double-mounting and
concurrent rendering, and a component mounting into an already-live
subscription gets data on first render instead of a loading flash.

## Loading and error shape

`useQuery` resolves to one of three shapes, in order: `{ data: [],
isLoading: true }` until the first emission for this subscription
(instant when a shared subscription already has data), then `{ data,
isLoading: false, error: null }` on every emission. If a refetch fails,
the error lands in `error` with `isLoading: false` while `data` retains
the last successful rows. `useQueryCountResult` follows the same rule,
retaining its last successful count. `useQuery` results also
carry `isPreviousData`, false except during a `keepPreviousData`
transition (see above).

## Server-side rendering

The server snapshots are the empty states: `data: []`, `useDatabase()`
null. Hydration then subscribes and fills in on the client. There is no
server-side data story, by design — the database is a client-side
concept.

## Worked example

`examples/todo-sync` uses these bindings on both platforms: the web
frontend (`frontend/src/App.tsx`) and the React Native client
(`mobile/App.tsx`) render live todos through `useQuery` and write
through `useMutation` with no local bridge code. The web frontend's
search box is a live `keepPreviousData` demonstration. The query's
structure changes with every keystroke while the list stays rendered.
Both apps render their sync badge through `useSyncState` on the
controller their `attach` helper owns, folding the five controller
states into the demo's three, and the example e2e suite exercises all
of it against the real sync server.
