# Sync basics: what happens when

A plain-language guide to the sync protocol's behavior: what happens
when devices edit offline, who wins, and what to do when the default
answer is not the one your app wants. The precise contract lives in
[sync-design.md](sync-design.md) and [sync-wire.md](sync-wire.md);
nothing here adds to it, this is the same protocol explained by
scenario.

## The mental model

- The **server holds the master copy**. Every accepted change advances
  its history by one step.
- Each client remembers a **cursor**: an opaque token meaning "I have
  seen the server's history up to here". Clients never interpret it.
- A sync is always **pull, then push**: first fetch everything that
  happened since your cursor and merge it in, then send your own
  pending edits.
- Offline editing is unrestricted. Edits mark records dirty; dirty
  records are what push sends. Nothing blocks on connectivity.
- The **server never merges**. When both sides changed the same
  record, the client resolves it during pull, and pushes the result.

## Who wins when two devices edit the same record

The default resolution is per column:

- Devices edited **different columns** → both edits survive. The
  merged record has each device's column.
- Devices edited the **same column** → the device that *pushes later*
  wins that column.
- **Deletions**: a remote delete beats local edits (the record goes);
  a local delete beats remote edits (the tombstone is pushed next).

Note what is absent: wall-clock time. When each edit was *made* plays
no role — only the order in which devices reach the server. Device
clocks can be wrong, skewed, or lying, so the protocol never consults
them.

## How deletion syncs: tombstones

A deleted record can't simply be removed from the server's database.
Pull asks "what changed since my cursor" — and a hard-deleted row no
longer exists to be returned, so a device that was offline during the
deletion would never hear about it and keep its copy forever. You
can't sync an absence, so the absence becomes a thing.

Deletion is therefore a write like any other: the row stays, marked
dead, under a fresh revision. The next pull matches it and ships it in
the `deleted` list; each device drops its local copy on arrival.

Two rules keep this honest. A tombstone **never resurrects** — a stale
offline edit pushed against a deleted record changes nothing; the
editor learns of the deletion on its next pull instead. And deleting
the already-deleted changes nothing either, so retries and the same
delete arriving from two devices don't churn anyone's pulls.

The cost is that dead rows accumulate. One may be pruned only once no
device's cursor is old enough to still need it — the server's gc
floor. A device returning from below the floor is told to resync from
scratch rather than silently keep ghosts. The API side of all this
lives in [reference/sync.md](reference/sync.md).

## A worked example: the long-offline device

1. Monday: device A goes offline and renames a task to "Buy milk".
2. Tuesday: device B (online) renames the same task to "Buy oat milk"
   and syncs. The server now says "Buy oat milk".
3. Friday: device A comes back online and syncs.

What happens on Friday: A cannot just push — its cursor is from
Monday, and the server rejects pushes based on stale history
(`conflict: true`; what that exchange looks like on the wire is
[sync-tour.md §5](sync-tour.md#5-push-with-a-stale-cursor)). A must
pull first, so A *sees* B's "Buy oat milk"
before anything is overwritten. A then merges: the name column is
locally changed on A, so A's value goes on top. A pushes, and both
devices converge on **"Buy milk"** — the edit that was made *first*
wins, because it was pushed *last*.

Two guarantees hold even in this awkward case: nothing was lost
*silently* (A was forced to download B's version before overwriting
it), and both devices end up identical. Whether "Buy milk" is the
answer your app wants is a policy question, and the default policy is
simply: last pusher wins, per column.

## When the default is wrong: stale edits

For some data, a week-old edit arriving late should lose — or be
dropped entirely. The protocol leaves this to the app, and the hook
for it is `conflictResolver`, which runs on the client during merge
and has the final word on the merged record:

```ts
conflictResolver?: (table, local, remote, resolved) => RawRecord
```

`resolved` is the default merge (remote base, local changed columns on
top); return it unchanged to keep the default. Two useful policies:

**Newest edit wins, by app-recorded time.** Give the table an
`edited_at` column that your app sets on every user edit. Clocks are
back in play, but now it is *your* choice for *this* table, and only
relative order between two edits of one record matters:

```ts
conflictResolver: (table, local, remote, resolved) => {
  if (table !== 'tasks') return resolved
  if ((remote['edited_at'] as number) > (local['edited_at'] as number)) {
    // remote edit is newer — discard the stale local edit entirely
    return { ...resolved, ...remote, _status: 'synced', _changed: '' }
  }
  return resolved
}
```

Returning the remote values with `_status: 'synced'` and an empty
`_changed` is what *drops* the local edit: the record is written as
clean, so the push that follows sends nothing for it. Without that,
the record stays dirty and the local values still push.

**Freshness cutoff.** Same shape, different condition: if
`Date.now() - local['edited_at']` exceeds what your app considers
relevant (the edit sat offline too long), return the remote version
as above and the stale edit evaporates.

Things that look like alternatives but are not:

- **Rejecting stale records server-side** (`rejected` in the push
  response) keeps them dirty on the client, so they retry on every
  sync forever. `rejected` is for invalid data a user can fix, not
  for staleness policy.
- **Trusting device clocks protocol-wide** is exactly what the design
  refuses to do; `conflictResolver` scopes the trust to tables where
  the app accepts the risk.

If a table's history genuinely matters (edits must never overwrite
each other), model it as append-only rows — one record per event —
instead of mutable columns. Merging then never conflicts at all.

The retry loop, mid-flight edit safety, and the resync rebuild are
specified in [reference/sync.md](reference/sync.md); wire validation
with shared schemas is the [Zod adapter](zod-adapter.md)'s job.

## When the server says no: handling rejections

A sync run can end four ways, and a status indicator that collapses
them into "synced or failed" will lie to the user in exactly one case:

| Outcome | What happened | What to show |
| --- | --- | --- |
| Throw from `synchronize()` | Transport failure: nothing definitive happened | sync failed / offline |
| Conflict | Another device won a race; handled internally by the retry loop | nothing, it resolved itself |
| Result with `rejected > 0` | The push **completed** but the server refused specific records | attention required |
| Clean result | Everything pushed and pulled | synced |

The third row is the one applications get wrong. A push response
naming rejections is a *successful* sync at the protocol level, so a
controller that maps every non-throwing run to "synced" reports a
clean sync while a record silently fails to leave the device. The
result carries what honesty needs:

```ts
const result = await synchronize(options)

if (result.rejected > 0) {
  return {
    status: 'attention-required',
    rejected: result.rejected,               // how many
    rejectedRecords: result.rejectedRecords, // which ones, per table
  }
}
return { status: 'synced' }
```

Rejected records stay dirty and are retried on every later push. That
design is correct for *transient* refusals: a row that fails
validation until a related record arrives will eventually go through.
A *deterministic* refusal (a unique-constraint duplicate, a
permanently invalid value) retries forever and will never resolve
itself; the retry loop is not the fix, the user is. Two consequences:

- **Validate permanent constraints before accepting input.** A
  uniqueness rule the server enforces deserves an availability check
  in the form that collects the value; the rejection lane is the
  safety net behind that check, not a substitute for it.
- **Surface the record, not just the count.** `rejectedRecords` names
  the refused ids per table; point the user at the thing that needs
  changing. Today the app maps table-plus-context to a message it
  chooses; structured, machine-readable rejection reasons on the wire
  are a planned extension.

## Where to go deeper

- [sync-design.md](sync-design.md) — the rationale and the contract.
- [sync-wire.md](sync-wire.md) — exact JSON shapes and server MUSTs.
- [sync-tour.md](sync-tour.md) — the protocol as eight real requests.
- [reference/sync.md](reference/sync.md) — wiring `synchronize()` into
  an app.
