# Sync wire protocol

Normative contract between `synchronize()` and a backend, as implemented
in `@remelondb/core` (`src/sync/`). Rationale and design history live in
[sync-design.md](sync-design.md). This document is what a server is
built and tested against; MUST/SHOULD/MAY are used in the RFC sense.

The contract is verified three ways, all in CI: a formal model of the
protocol design ([sync_model.qnt](sync_model.qnt), explained in
[formal-model.md](formal-model.md)), the server conformance suite
(`@remelondb/server/conformance` — the checklist in §7 as runnable
scenarios), and the [sync tour](sync-tour.md), whose request/response
pairs replay against the example server.

The protocol is transport-agnostic: `synchronize()` calls injected
`pullChanges`/`pushChanges` functions and sees only the JSON values
below. A canonical HTTP binding is suggested at the end, but any
transport that delivers these values conforms.

## 1. Data shapes

- **RecordId** — non-empty string. Client-generated; the protocol
  mandates no format (apps choose, e.g. UUIDs).
- **Cursor** — non-empty string, opaque to the client. The client
  stores it and echoes it back; it MUST NOT inspect, compare, or order
  cursors. Servers encode whatever they need (a revision number, a
  watermark, a composite) — it is theirs alone to interpret.
- **Record** — JSON object: the row's user columns plus `id`. Values
  are `string | number | boolean | null`. `_status` and `_changed` MUST
  NOT appear on the wire in either direction; unknown keys are dropped
  by the client's sanitizer, not errors.
- **ChangeSet** — `{ created: Record[], updated: Record[], deleted:
  RecordId[] }`. `deleted` carries ids only.
- **Changes** — `{ [tableName]: ChangeSet }`. Tables absent from the
  object mean "no changes there".

Strict `created`/`updated` classification is not required: the client
applies `updated` for a locally-missing record as a create (and vice
versa, logging an anomaly). Servers SHOULD classify when cheap and MAY
report all live rows as `updated`.

## 2. Pull

Request:

```jsonc
{
  "cursor": Cursor | null,        // null = first sync: send everything
  "schemaVersion": number,        // client's current schema version
  "migration": {                  // non-null after a local migration:
    "from": number,               //   last-synced schema version
    "tables": string[],           //   tables new since `from`
    "columns": [ { "table": string, "columns": string[] } ]
  } | null
}
```

Responses — exactly one of:

```jsonc
{ "changes": Changes, "cursor": Cursor }   // normal
{ "resyncRequired": true }                 // cursor expired/unknown
```

Semantics:

- **The snapshot rule (the invariant everything rests on).** A pull is
  served from one consistent snapshot `S`; the returned cursor
  identifies `S`. Every change committed after `S` — including changes
  concurrent with the pull that commit later — MUST be returned by some
  future pull from that cursor. Change visibility is commit-ordered
  with respect to cursors; write-time wall clocks cannot satisfy this
  (see sync-design.md, flaw 1).
- `cursor: null` MUST return the complete current state.
- With a non-null `migration`, the response MUST additionally include
  full current records for the listed tables and for all rows' listed
  columns' tables, regardless of the cursor — the client just gained
  schema it has never synced.
- `resyncRequired` is the only lawful answer for a cursor the server
  can no longer serve completely (pruned tombstones or change log).
  Answering such a cursor with partial data is a silent lost delete.
  On receiving it, the client re-pulls from `null` and applies with
  replacement semantics: reconcile against the full snapshot, destroy
  local synced records absent from it, keep local dirty records (they
  merge and push as usual).

## 3. Push

Request:

```jsonc
{ "changes": Changes, "cursor": Cursor }   // cursor: from the preceding pull
```

Responses — exactly one of:

```jsonc
{ "cursor": Cursor | null, "changes": Changes | null,
  "rejected": { [tableName]: RecordId[] } /* optional */ }   // accepted
{ "conflict": true }                                          // stale push
```

Semantics:

- The push MUST be applied atomically: all accepted records commit
  together or none do.
- **Conflict.** If any pushed record was modified on the server after
  the request's cursor, the server MUST reject the whole push with
  `conflict` and apply nothing. The client then pulls (merging
  per-column, local dirty columns winning), and pushes again — a
  bounded loop (default 5 rounds) before surfacing an error.
- **Rejected records (partial accept).** A server MAY refuse individual
  records (validation, authorization, uniqueness) by listing their ids
  in `rejected` while accepting the rest. Rejected records' effects
  MUST NOT be applied. The client keeps them dirty — they retry on the
  next push — and marks everything else synced. Rejection is per
  record, not per column.
- **Cursor and interleaved changes are a package.** A non-null `cursor`
  MUST identify the push transaction's snapshot and MUST be accompanied
  by `changes`: everything committed between the request cursor and
  that snapshot, excluding the push's own records. Returning a cursor
  without those foreign changes reintroduces the lost-write race
  through the back door. The client applies `changes`, marks synced,
  adopts `cursor` — its own writes never echo.
- **Degraded mode is legal — and sometimes mandatory.** `cursor: null,
  changes: null` means "the server applied the push but cannot compute
  the interleave". The client keeps its old cursor; the next pull
  re-delivers the push echo, which apply absorbs by equality. Correct
  either way — the fast path is a per-backend upgrade, invisible to app
  code. A server MUST degrade whenever it cannot compute the interleave
  *completely* — in particular when the request cursor predates its
  tombstone/change-log retention floor: the window has lost deletions,
  a "complete as far as we know" interleave would silently resurrect a
  deleted record on the client, and the degraded path routes the client
  into the next pull's `resyncRequired` instead. (Found by the formal
  model — see sync_model.qnt, `fullPathOk`.)

## 4. Backend obligations, testable

A conforming backend:

1. Serves each pull from one consistent snapshot — never per-table
   queries at different instants.
2. Issues commit-ordered cursors: no change committed after a cursor's
   snapshot is ever invisible to pulls from it. (Known-good mechanisms:
   a revision sequence with a serialized commit path — e.g. a per-user
   advisory lock; a transaction-horizon watermark; a single-writer
   change log. `last_modified` wall clocks alone are non-conforming.)
3. Retains deletions long enough to serve every cursor it has not
   declared expired; answers expired cursors with `resyncRequired`,
   never with silently incomplete data.
4. Applies pushes atomically; answers `conflict` when any pushed record
   is stale; applies nothing on conflict.
5. Never returns a push cursor without the *complete* interleaved
   foreign changes (degraded `null`/`null` is the escape hatch, and is
   mandatory when the request cursor predates the retention floor).
6. Excludes rejected records' effects entirely; rejection lists name
   ids that exist in the request.
7. Scopes every response to the authenticated client's data.

## 5. What servers may rely on from the client

- The cursor comes back byte-identical to what the server issued.
- Apply is idempotent: re-delivering a change the client has already
  applied is absorbed (equality-gated), never an error.
- Records are pushed whole (all user columns); per-column merging is
  the client's job after a conflict, not the server's.
- The client never sends `_status`/`_changed`, and strips unknown
  columns it receives.
- After `rejected`, the named records stay dirty and will be retried
  verbatim or newer on a later push.

## 6. Canonical HTTP binding (non-normative)

`POST /sync/pull` and `POST /sync/push`, `application/json`, request
and response bodies exactly as above. All protocol outcomes — including
`resyncRequired` and `conflict` — are HTTP 200 with the body carrying
the variant: the client only sees what the adapter returns, so encoding
protocol state in transport status codes buys nothing and costs every
adapter a translation table. Transport-level failures (401, 400
malformed JSON, 5xx) are outside the protocol; adapters surface them as
thrown errors, which `synchronize()` reports as a failed sync with
local state untouched.

## 7. Conformance checklist

For a server test suite; each item is one scenario or property test.

1. Full pull (`cursor: null`) returns the complete state, scoped to the
   authenticated client.
2. Incremental pull returns exactly the rows changed after the cursor.
3. Deletions arrive as ids in `deleted`; deleted rows never appear as
   records.
4. A change committing *during* a pull (concurrent transaction) is
   returned by the next pull — never lost. (The commit-order property;
   needs an interleaving harness or property test.)
5. Push replay: identical push applied twice yields identical server
   state.
6. Stale push → `conflict`, nothing applied.
7. Rejected record: named in `rejected`, its effects absent, the rest
   of the push applied.
8. Push response cursor, when non-null, comes with the interleaved
   foreign changes and excludes the push's own records.
9. Expired cursor → `resyncRequired`; a full re-pull then converges to
   server state.
10. Nothing of another user's data ever crosses, in any response.

## Versioning

Future capabilities (sparse updates, per-column conflict hints,
per-table cursors — see sync-design.md open questions) enter behind
explicit capability flags in the pull request; absence of a flag always
means v1 behavior as specified here.
