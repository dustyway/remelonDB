# A tour of the sync wire protocol

The protocol in eight requests against the example server, with real
responses — and provably real: `scripts/check-sync-tour.mjs` extracts
every request/response pair below and replays them against the example
server in CI, so this page cannot drift from behavior.
[sync-wire.md](sync-wire.md) is the normative spec this tour walks
through;
[`examples/todo-sync/backend/requests.http`](../examples/todo-sync/backend/requests.http)
is the same sequence as clickable requests. To follow along:

```sh
pnpm --filter example-todo-sync server   # sync server on :8787
```

Two rules frame everything below. Every protocol outcome is an HTTP
200 with the variant in the body; only a malformed request is a 400.
And the cursor is an opaque string the server mints: clients store it
and echo it back, never interpret it.

Each stop shows the request body sent to `/sync/pull` or `/sync/push`
(pulls carry `schemaVersion`, pushes carry `changes`), then the
response.

## 1. A fresh client pulls

A client that has never synced sends `cursor: null`:

```json
{ "cursor": null, "schemaVersion": 1, "migration": null }
```

```json
{ "changes": { "todos": { "created": [], "updated": [], "deleted": [] } }, "cursor": "0" }
```

The store is empty, so the changes are empty — but the cursor is the
real payload: "you are now current as of position 0". Everything later
is relative to a cursor.

## 2. Push a created todo

```json
{ "cursor": "0",
  "changes": { "todos": {
    "created": [ { "id": "h1", "text": "created over http", "done": false, "created_at": 1753000000000 } ],
    "updated": [], "deleted": [] } } }
```

```json
{ "cursor": "1", "changes": { "todos": { "created": [], "updated": [], "deleted": [] } } }
```

A push answers like a pull: the new cursor plus any foreign changes
committed since the cursor you sent. Here nobody else wrote, so the
interleave is empty. This shape is what kills the echo problem — the
client advances its cursor past its own write in the same round trip,
so the next pull cannot hand its own change back to it.

Ids are client-generated; the record existed on the device before the
server ever heard of it. That is the offline-first contract.

## 3. A second fresh client pulls

Same request as stop 1, different world:

```json
{ "cursor": null, "schemaVersion": 1, "migration": null }
```

```json
{ "changes": { "todos": { "created": [],
    "updated": [ { "text": "created over http", "done": false, "created_at": 1753000000000, "id": "h1" } ],
    "deleted": [] } }, "cursor": "1" }
```

The todo arrives in `updated`, not `created`. Pull deltas are upserts:
an unknown id in `updated` means create it, a known one means update
it. The created/updated distinction only carries meaning on push,
where the server uses it for validation and conflict handling.

## 4. Push an update

Toggling `done`, with the current cursor:

```json
{ "cursor": "1",
  "changes": { "todos": {
    "created": [],
    "updated": [ { "id": "h1", "text": "created over http", "done": true, "created_at": 1753000000000 } ],
    "deleted": [] } } }
```

```json
{ "cursor": "2", "changes": { "todos": { "created": [], "updated": [], "deleted": [] } } }
```

Rows on the wire are always complete records, not field patches;
per-column conflict merging is the client engine's job, done before
pushing.

## 5. Push with a stale cursor

Replaying that update as if the client had never advanced:

```json
{ "cursor": "0",
  "changes": { "todos": {
    "created": [],
    "updated": [ { "id": "h1", "text": "stale write", "done": false, "created_at": 1753000000000 } ],
    "deleted": [] } } }
```

```json
{ "conflict": true }
```

The server refuses to apply writes from a client that has not seen the
latest changes. The client's move is mechanical: pull (which merges),
then push again. `synchronize()` does this loop automatically.

## 6. Delete travels as a tombstone

```json
{ "cursor": "2",
  "changes": { "todos": { "created": [], "updated": [], "deleted": ["h1"] } } }
```

```json
{ "cursor": "3", "changes": { "todos": { "created": [], "updated": [], "deleted": [] } } }
```

A client that last pulled at cursor `"2"` now receives the deletion:

```json
{ "cursor": "2", "schemaVersion": 1, "migration": null }
```

```json
{ "changes": { "todos": { "created": [], "updated": [], "deleted": ["h1"] } }, "cursor": "3" }
```

Deletions are data, not absence. A client that was offline for the
deletion still learns about it, which is why records are tombstoned
locally rather than erased until sync confirms.

## 7. A cursor the server cannot serve

```json
{ "cursor": "999999", "schemaVersion": 1, "migration": null }
```

```json
{ "resyncRequired": true }
```

Not an error — the lawful answer for any cursor the server does not
recognize or has garbage-collected past. The client wipes synced
records and re-pulls from `null`; locally created or edited records
survive the resync and are pushed afterwards.

## 8. Validation at the door

An invalid row (empty `text` where the schema demands `min(1)`) is the
one case that breaks the 200 rule, because the request itself is
malformed. Sending this:

```json
{ "cursor": "3",
  "changes": { "todos": {
    "created": [ { "id": "bad1", "text": "", "done": false, "created_at": 1 } ],
    "updated": [], "deleted": [] } } }
```

returns HTTP 400 with the exact path of the problem:

```json fragment
{ "error": "[ { \"code\": \"too_small\", \"path\": [\"changes\", \"todos\", \"created\", 0, \"text\"], ... } ]" }
```

The example server validates with the same Zod objects the client
uses (`syncSchemas` in `schema.ts`) — one schema, both ends of the
wire. Servers may instead accept the batch and reject individual rows
by id (`rejected` in the push result); rejected rows stay dirty on the
client and retry later.

## Where next

- [sync-wire.md](sync-wire.md): the spec — exact shapes, backend
  obligations as testable MUSTs, the conformance checklist.
- [reference/sync.md](reference/sync.md): wiring `synchronize()` into
  an app.
- [server-design.md](server-design.md): implementing a backend on the
  `SyncStore` seam, proven with `@remelondb/server/conformance`.
