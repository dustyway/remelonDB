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

## Where to go deeper

- [sync-design.md](sync-design.md) — the rationale and the contract.
- [sync-wire.md](sync-wire.md) — exact JSON shapes and server MUSTs.
- [sync-tour.md](sync-tour.md) — the protocol as eight real requests.
- [reference/sync.md](reference/sync.md) — wiring `synchronize()` into
  an app.
