# Sync reference

How to _use_ the sync engine. The protocol's design and rationale (the
opaque commit-ordered cursor, why push responds like a pull, the backend
MUSTs) live in [../sync-design.md](../sync-design.md). The backend itself
ships as [`@remelondb/server`](../../packages/server); read the design doc
first if you're backing it with your own `SyncStore` adapter or building
a backend from scratch. _When_ to call it (the trigger set,
server-signalled sync, battery, background sync per platform) is
[../sync-triggering.md](../sync-triggering.md).

## Calling synchronize

```ts
import { synchronize } from '@remelondb/core';
import { syncSchemas } from '@remelondb/core/zod';

const wire = syncSchemas({ tasks: TaskRow });

await synchronize({
  database: db,

  pullChanges: async ({ cursor, schemaVersion, migration }) => {
    const response = await fetch(`/sync/pull`, {
      method: 'POST',
      body: JSON.stringify({ cursor, schemaVersion, migration }),
    });
    if (!response.ok) throw new Error(`pull: HTTP ${response.status}`);
    return response.json(); // { changes, cursor } | { resyncRequired: true }
  },

  pushChanges: async ({ changes, cursor }) => {
    const response = await fetch(`/sync/push`, {
      method: 'POST',
      body: JSON.stringify({ changes, cursor }),
    });
    if (!response.ok) throw new Error(`push: HTTP ${response.status}`);
    return response.json(); // { cursor, changes, rejected? } | { conflict: true }
  },

  // Optional but recommended at an untrusted network boundary:
  validatePullResult: (value) => wire.pullResult.parse(value),
  validatePushResult: (value) => wire.pushResult.parse(value),
});
```

Transport is entirely yours; the engine only sees the two functions. In
the canonical HTTP binding ([sync-wire.md](../sync-wire.md)) every
protocol outcome, `resyncRequired` and `conflict` included, is an
HTTP 200 with the variant in the body, so the adapters stay this thin.
Transport-level failures (401, 5xx) throw, and the sync reports as
failed with local state untouched. A server may encode outcomes in
status codes instead; the adapter then translates, and the engine never
knows the difference. For the canonical binding you do not have to
write the adapters at all: [the HTTP transport](#the-http-transport)
below supplies them.

When validators are supplied, every response passes through them before
the engine inspects a variant, writes records, marks local changes synced,
or adopts a cursor. A validation failure rejects the sync with local state
untouched. `syncSchemas()` supplies validators derived from the same Zod
row schemas used to declare the client tables.

Parsing inside your own `pullChanges` wrapper works too, but covers only
the call sites you remember. The push acknowledgement (with its
`rejected` list and `conflict` variant) and the re-pull after
`resyncRequired` are the responses DIY validation tends to skip, and an
unvalidated response there writes straight into local records. Declaring
the validators once hands all of those paths to core, and keeps the
adapters pure transport.

Validators are parse-shaped: core adopts their **return value**, so they
may narrow or transform (Zod's `.parse` slots in as-is). An assert-style
validator that returns nothing makes core consume `undefined`. Return
the value.

`pushChanges` is optional (pull-only replicas). Also exported:
`hasUnsyncedChanges(db)`, and the lower-level phases
(`fetchLocalChanges`, `applyRemoteChanges`, `markLocalChangesAsSynced`)
for building custom flows.

## The wire shapes

```ts
// changesets, both directions
{ [table]: { created: [record], updated: [record], deleted: [id] } }

// records: user columns + id. _status/_changed NEVER cross the wire.
// pull response:  { changes, cursor }  or  { resyncRequired: true }
// push response:  { cursor, changes, rejected? }  or  { conflict: true }
```

The cursor is an opaque string; store-and-echo. In the push response,
`cursor` + `changes` come **as a package**. A cursor without the
interleaved foreign changes is rejected as a backend bug (it would
reintroduce the lost-write race). Degraded backends return
`cursor: null, changes: null`: correct, but the client's own writes echo
back on the next pull (and are absorbed).

## What a sync run does

1. **Pull**: `pullChanges(cursor)` → apply inside one write block →
   store the new cursor. Concurrent `synchronize()` calls for the same
   database **coalesce**. A call arriving mid-sync joins the running one
   (the runner's options apply). Before applying, the stored cursor is
   also re-checked as a guard against out-of-band writers (another tab
   or process); that case aborts with an error.
   Incoming records are validated as **full records**. A nonconforming
   server omitting columns is rejected loudly instead of silently
   clobbering local values with defaults, and local-state lookups are
   chunked, so arbitrarily large pulls don't hit SQLite parameter limits.
2. **Push** (if configured and there are local changes): snapshot dirty
   records (tables declared `{ localOnly: true }` are skipped, so their
   rows never leave the device) → `pushChanges` → mark records synced, destroy pushed
   tombstones, adopt the push cursor and apply interleaved changes.
3. **Conflict loop**: a `{ conflict: true }` push response loops back to
   step 1 (the pull merges the server's version), bounded by
   `conflictRetries` (default 5), then throws.

Sync never blocks the app: reads and writes work throughout; only the
apply/mark commits hold the writer queue briefly.

## What a run reports

`synchronize()` resolves to a result the application should branch on
rather than parsing logs:

```ts
{
  (lease, resynced, pulled, pushed, rejected, rejectedRecords, retryCount);
}
```

The rejection fields matter most for UI honesty. `rejected` is the
count of rows the server refused this round; `rejectedRecords` names
them (`{ [table]: ids[] }`, tables with no rejections omitted, so it is
`{}` exactly when the count is 0). Rejected rows stay dirty and are
retried on every later push. That is correct for transient refusals, but a
deterministic refusal (a unique-constraint duplicate) retries forever
and will never resolve itself. A status indicator that treats every
non-throwing run as "synced" is therefore lying whenever `rejected > 0`;
show an attention state and use `rejectedRecords` to point at the
record that needs the user. The full recipe, the four run outcomes and
when to validate before accepting input, is in
[sync-basics.md](../sync-basics.md#when-the-server-says-no-handling-rejections).

## The HTTP transport

`synchronize` takes two functions and does not care how they reach a
server. For the common case, the backend half mounted over HTTP the way
`@remelondb/server` hands it out, `@remelondb/core/transport` supplies
them:

```ts
import {
  createSyncTransport,
  readSyncResponse,
} from '@remelondb/core/transport';
import { syncSchemas } from '@remelondb/core/zod';

const wire = syncSchemas({ tasks: TaskRow });

const post = (path: 'pull' | 'push', body: unknown, signal?: AbortSignal) =>
  readSyncResponse(path, () =>
    fetch(`/sync/${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    }),
  );

const { pullChanges, pushChanges } = createSyncTransport({
  post,
  validatePullResult: (raw) => wire.pullResult.parse(raw),
  validatePushResult: (raw) => wire.pushResult.parse(raw),
});
```

The transport enforces the protocol/transport split. `conflict`,
`resyncRequired`, and per-record rejections are instructions the engine
acts on, so they arrive as HTTP 200 and pass through as values. A
response the engine cannot act on becomes a `SyncTransportError`, the
run fails, and local dirty state stays untouched:

| response                   | becomes                                     |
| -------------------------- | ------------------------------------------- |
| fetch rejects (no network) | `SyncTransportError`, `status` undefined    |
| non-2xx                    | `SyncTransportError` carrying the status    |
| body is not JSON           | `SyncTransportError`                        |
| JSON fails the validator   | `SyncTransportError` ("invalid wire shape") |

`post` is the platform seam. It owns the URL and the authentication,
nothing else. The browser version above lets the cookie jar attach the
session (`credentials: 'include'`). React Native's `fetch` has no cookie
jar, so a native app reads its session cookie at the start of every
request (logins and logouts change it) and attaches it itself:

```ts
const post = (path: 'pull' | 'push', body: unknown, signal?: AbortSignal) => {
  const cookie = authClient.getCookie();
  return readSyncResponse(path, () =>
    fetch(`${apiURL}/sync/${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
      signal,
    }),
  );
};
```

For the canonical URL shape the `post` above does not need writing
either. `createHttpPost` covers it: JSON body, signal forwarded,
`credentials` passed through, and a `headers` thunk called at the start
of every request so credentials that change (a native session cookie)
are always current:

```ts
const post = createHttpPost({ baseUrl: '', credentials: 'include' }); // web
const post = createHttpPost({
  baseUrl: apiURL,
  headers: () =>
    authClient.getCookie() ? { cookie: authClient.getCookie() } : {},
}); // native
```

Anything it cannot express (another URL shape, retries, a non-HTTP
channel) is a hand-written `post`; the options stay those three.

An empty credential sends no header; the server's 401 is the signal.
Both validators must be given, in the same shape `synchronize`'s own
`validatePullResult` accepts, and `syncSchemas` from
[`@remelondb/core/zod`](../zod-adapter.md) fits directly. To skip
validation, pass an identity function; the skip is then written down
where a reviewer sees it.

## The sync controller

`synchronize` runs once when called. An app wants it run at the right
moments without ever running twice at once, and it wants a status to
show. `createSyncController` (a root export, the sibling of
`createDatabaseManager`) owns that:

```ts
import { createRunSync, createSyncController } from '@remelondb/core';

const controller = createSyncController({
  runSync: createRunSync({ database: db, pullChanges, pushChanges }),
  triggers: (fire) => {
    const onOnline = () => fire();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  },
});
controller.start();
```

`start()` syncs once, then again on every interval tick (`intervalMs`,
default 60s, `null` disables the clock), on every trigger fire, and two
seconds (`debounceMs`) after the last `notifyLocalWrite()`. Runs are
single flight: triggers during a run coalesce into at most one
follow-up. `syncNow()` is the button; it also re-arms syncing after an
auth error. `dispose()` ends the controller for good: it aborts the
in-flight run through the signal `runSync` receives, stops every timer
and trigger, and goes silent. Dispose before closing the database, in
that order, so a logout cannot leave a request racing a closed
database.

`triggers` subscribes any wake-up source and returns its unsubscribe:
online/visibility on the web, network-restored and app-foregrounded on
React Native, or a server-push channel (an `EventSource` whose messages
call `fire`; the wire stays pull-based, a push message only means "pull
soon", so a lossy channel is fine alongside a slow interval). A fully
manual app skips `start()` and wires `syncNow()` to a button; every
verb works without `start()`.

State is data for the UI, published to `subscribe` listeners:

```ts
{
  (status, lastSyncAt, error, cause, lastResult);
}
// status: 'idle' | 'syncing' | 'offline' | 'error' | 'resync-required'
// error: the message; cause: the value the run threw, null after success
```

`error` is a string for display. `cause` is the thrown value itself, kept
for logging: `JSON.stringify(state)` drops an Error's stack, so log
`state.cause` directly when the message is not enough.

Thrown run errors are classified by two predicates. `isAuthError`
(default: `SyncTransportError` with status 401) marks the session gone:
status becomes `error` and automatic syncing stops until `syncNow()`,
because retrying into a dead session spams the server and the logs.
`isOfflineError` (default: `SyncTransportError` without a status) shows
as `offline`, which is a normal condition, not a fault. Everything else
is `error`. A run that completes with rejections is **not** an error:
the result lands in `lastResult` and the status stays `idle`; deciding
that `rejected > 0` deserves an attention state is the app's call (see
[What a run reports](#what-a-run-reports)).

## Conflict semantics (client-resolved)

- **Per-column, client-wins**: the merged record is the server version
  with the locally-changed columns (`_changed`) laid on top; it stays
  dirty so the merge is pushed back. Override per record with
  `conflictResolver(table, local, remote, resolved)`. Recipes for
  common policies (newest edit wins, discarding stale offline edits)
  are in [sync-basics.md](../sync-basics.md).
- **Remote delete beats local edits**; **local delete beats remote
  edits** (the tombstone is pushed next).
- **Equality gate**: a record modified while the push was in flight is
  not marked synced; it stays dirty for the next run. Rejected ids
  (`rejected`) likewise.

## Deletion and tombstones

Deletion is a synced write, not a removal. `markAsDeleted(id)` turns the
record into a local tombstone: gone from queries and observers, kept in
the database until a push ships it in the `deleted` array (a successful
push then destroys it locally, step 2 above). `destroyPermanently(id)`
skips sync entirely; never use it on records the server knows about, or
other devices keep theirs.

Backends mirror this ([sync-wire.md](../sync-wire.md)): a delete marks
the row dead under a fresh revision, so later pulls serve it in
`deleted`. A conflicting upsert against a dead row changes nothing.
Tombstones never resurrect; the stale editor learns of the deletion on
its next pull, and re-deleting is a no-op. Server tombstones are
retained until the gc floor passes them; a cursor older than the floor
gets `resyncRequired` instead of silent gaps.

Why deletion must work this way: [sync-basics.md](../sync-basics.md).

## Resync

When the server answers `resyncRequired` (pruned history, expired
cursor), the engine re-pulls from `cursor: null` and applies in
_replacement_ mode. Within each table present in the response, matching
records are reconciled and missing ones are created. **Local synced records
absent from that table's snapshot are destroyed**, while dirty records survive
and push afterwards. An omitted table remains unchanged. That includes
tombstones: an offline delete survives the rebuild and is pushed after it
(records in the snapshot never resurrect over a pending local delete).

## Migration pulls

If your schema evolves, pass `migrationsEnabledAtVersion` (the schema
version you first shipped sync with). After a local migration, the next
pull includes `migration: { from, tables, columns }` so the backend can
send full records for newly tracked tables/columns. The engine tracks the
last-synced schema version in local storage automatically.

## Testing a backend

`packages/driver-node/src/syncIntegration.test.ts` contains a minimal
_conforming_ fake backend (rev cursor, per-record conflict detection,
push-returns-cursor+changes): a useful template for what your server
must do, and the test scenarios double as an executable spec of client
behavior.
