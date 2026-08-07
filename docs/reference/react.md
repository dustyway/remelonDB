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
import { DatabaseProvider } from '@remelondb/core/react'
import { manager } from './db'

<DatabaseProvider manager={manager}>
  <App />
</DatabaseProvider>
```

The provider is a convenience, not a requirement: `useDatabaseState`
accepts an explicit manager argument, and the query hooks need no
provider at all (a query already knows its database). Tests and
multi-database setups can skip the provider entirely.

## Manager hooks

```tsx
const { status, error } = useDatabaseState()  // lifecycle transitions
const db = useDatabase()                      // Database | null until ready
```

`useDatabaseState` re-renders exactly on manager state transitions
(`idle`, `loading`, `ready`, `taken-over`, `error`). `useDatabase` is
the 90%-case sugar: null until the manager is ready, then the open
database, with the null flowing naturally into the query hooks below.
Both take an optional explicit manager and otherwise read the provider;
calling them with neither throws immediately with instructions.

## Query hooks

```tsx
const db = useDatabase()
const { data: decks, isLoading, error } = useQuery(
  db && db.get(Deck).query(Q.sortBy('created_at', Q.desc)),
)
const due = useQueryCount(db && dueCardsQuery(db, now))
```

`useQuery` subscribes to a query's results and re-renders whenever
matching local data changes — user writes and applied sync pulls alike.
`useQueryCount` does the same through the engine's cheaper count
observation and returns a plain number. Both accept `null`/`undefined`
for the not-ready phase: `useQuery(null)` is `{ data: [], isLoading:
false, error: null }`, `useQueryCount(null)` is `0`.

### No dependency arrays: structural identity

There is deliberately no deps argument anywhere. Queries are data — a
frozen description plus a table — so the hooks key their subscription
on that *structure*, not on object identity. Rebuilding an equivalent
query every render is free and reuses the live subscription; changing
the query's actual content (a different `Q.where`, another table) tears
down and resubscribes. The class of stale-dependency bugs that
`useMemo`-wrapped subscriptions invite cannot be expressed against this
API.

The corollary: the first structurally-equal query instance is the one
that gets observed; later equivalent instances are ignored. Since
equivalent queries return equivalent results by definition, this is
invisible — but a query whose *meaning* depends on out-of-band state it
does not encode (nothing in Q does this) would be miskeyed.

### Shared subscriptions

Components observing structurally equal queries on the same database
share one live observation, refcounted: the first subscriber starts it,
the last one leaving stops it and drops it from the registry. A screen
where a header badge, a list, and a footer all watch the same query
costs one observation, not three. Sharing is per database instance, so
independent databases never cross.

### Deriving values: `select`

```tsx
const { data: count } = useQuery(q, { select: (rows) => rows.length })
const { data: newest } = useQuery(q, { select: (rows) => rows[0] ?? null })
```

`select` derives the rendered value from the rows, per consumer — two
components can select differently from one shared subscription. It runs
when the rows change and is memoized on them, so passing an inline
lambda costs nothing. Selectors must be pure.

For anything richer than per-row derivation, reach for the query
language first: joins and conditions belong in Q, where the engine
evaluates them and one subscription covers the composed result (see
[q-dsl-and-one-engine](q-dsl-and-one-engine.md)). The bindings
deliberately ship no stream operators — combining, debouncing, and
switching between live results is a job for a dedicated reactive
library on top, not for this module.

## Loading and error shape

`useQuery` resolves to one of three shapes, in order: `{ data: [],
isLoading: true }` until the first emission for this subscription
(instant when a shared subscription already has data), then `{ data,
isLoading: false, error: null }` on every emission. If starting the
observation throws, the error lands in `error` with `isLoading: false`
and an empty `data` — the component decides how to present it.

## Server-side rendering

The server snapshots are the empty states: `data: []`, `useDatabase()`
null. Hydration then subscribes and fills in on the client. There is no
server-side data story, by design — the database is a client-side
concept.

## Worked example

`examples/todo-sync` uses these bindings on both platforms: the web
frontend (`frontend/src/App.tsx`) and the React Native client
(`mobile/App.tsx`) each render live todos through `useQuery` with no
local bridge code.
