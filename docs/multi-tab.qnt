// -*- mode: quint -*-
// Formal model of the multi-tab coordination protocol (docs/multi-tab.md):
// the broker's write-slot arbitration plus change broadcast, and the
// ordering invariant that makes them compose.
//
// Scope: N tabs, one broker, one shared storage cell (a counter — the
// smallest state that exhibits lost updates). Modeled faithfully:
//   - per-tab FIFO inbox from the broker, carrying BOTH slot grants and
//     change broadcasts (one channel — the sequencing is the point)
//   - exclusive/shared slots, FIFO grant queue (a waiting writer blocks
//     later readers, so writers cannot starve)
//   - commit publishes to every other tab, then releases (program order:
//     the broker fans out the broadcast before it grants the next slot)
//   - a tab's write block: read the local cache, then write read+1
//
// Model simplifications: one storage cell, no compute-worker death or
// respawn, no refcounted open/close, tab count and write budget fixed.
//
// Check:    quint typecheck docs/multi-tab.qnt
// Simulate: quint run docs/multi-tab.qnt --invariant=allInvariants \
//             --max-samples=3000 --max-steps=40
//
// Flip STRICT_INBOX_FIFO to false to reproduce the lost update the
// implementation hit (slice 4): consuming a grant ahead of earlier
// queued broadcasts models "slot acquired inside the local queue" —
// the block then reads a cache missing a serialized-before commit,
// and commitReadsFresh fails with a two-tab counterexample.

module multi_tab {
  pure val TABS = Set("a", "b", "c")
  pure val MAX_WRITES = 3
  pure val STRICT_INBOX_FIFO = true

  // broker -> tab messages; one FIFO per tab, grants and broadcasts mixed
  type Msg = { kind: str, value: int } // kind: "grant" | "broadcast"

  // a tab's participation in one write block
  // "idle" -> "waiting" (slot requested) -> "reading" (granted; the
  // block's read happens on grant consumption) -> commit -> "idle"
  type Tab = { phase: str, seen: int, writesLeft: int }

  var storage: int
  var cache: str -> int
  var inbox: str -> List[Msg]
  var tabs: str -> Tab

  // broker state: exclusive holder (at most one), shared holders, FIFO queue
  var exclusiveHeld: bool
  var sharedHolders: Set[str]
  var waiters: List[{ tab: str, exclusive: bool }]

  // --- broker: grant from the head of the queue (called after any change)
  // exclusive: only into silence; shared: only when no exclusive holds.
  // Only the HEAD may be granted (strict FIFO — no starvation).

  def headGrantable(w: List[{ tab: str, exclusive: bool }]): bool =
    if (length(w) == 0) false
    else if (w[0].exclusive) (not(exclusiveHeld) and size(sharedHolders) == 0)
    else not(exclusiveHeld)

  action init = all {
    storage' = 0,
    cache' = TABS.mapBy(t => 0),
    inbox' = TABS.mapBy(t => List()),
    tabs' = TABS.mapBy(t => { phase: "idle", seen: 0, writesLeft: MAX_WRITES }),
    exclusiveHeld' = false,
    sharedHolders' = Set(),
    waiters' = List(),
  }

  // --- a tab asks for an exclusive slot (starts a write block)

  action requestSlot = {
    nondet t = oneOf(TABS)
    all {
      tabs.get(t).phase == "idle",
      tabs.get(t).writesLeft > 0,
      waiters' = waiters.append({ tab: t, exclusive: true }),
      tabs' = tabs.setBy(t, tb => { ...tb, phase: "waiting" }),
      storage' = storage, cache' = cache, inbox' = inbox,
      exclusiveHeld' = exclusiveHeld, sharedHolders' = sharedHolders,
    }
  }

  // --- broker pumps: grant the head waiter by queueing a grant message
  // into that tab's inbox (delivery is asynchronous, order preserved)

  action pump = all {
    headGrantable(waiters),
    exclusiveHeld' = if (waiters[0].exclusive) true else exclusiveHeld,
    sharedHolders' =
      if (waiters[0].exclusive) sharedHolders
      else sharedHolders.union(Set(waiters[0].tab)),
    inbox' = inbox.setBy(waiters[0].tab, q => q.append({ kind: "grant", value: 0 })),
    waiters' = waiters.slice(1, length(waiters)),
    storage' = storage, cache' = cache, tabs' = tabs,
  }

  // --- tab consumes an inbox message.
  // STRICT_INBOX_FIFO models the shipped design: messages consumed in
  // order, so a grant is seen only after every broadcast queued before
  // it. The false variant may consume a grant with broadcasts still
  // ahead of it — the "slot acquired inside the local queue" bug, where
  // pending applies sit parked behind the waiting block.

  def grantIndex(q: List[Msg]): int =
    q.indices().fold(-1, (best, i) =>
      if (best >= 0) best
      else if (q[i].kind == "grant") i
      else best)

  action consumeBroadcast = {
    nondet t = oneOf(TABS)
    val q = inbox.get(t)
    all {
      length(q) > 0,
      q[0].kind == "broadcast",
      cache' = cache.set(t, q[0].value),
      inbox' = inbox.set(t, q.slice(1, length(q))),
      storage' = storage, tabs' = tabs, waiters' = waiters,
      exclusiveHeld' = exclusiveHeld, sharedHolders' = sharedHolders,
    }
  }

  action consumeGrant = {
    nondet t = oneOf(TABS)
    val q = inbox.get(t)
    val gi = grantIndex(q)
    all {
      gi >= 0,
      // shipped design: only the head may be consumed; bug variant: a
      // grant may jump over broadcasts still queued before it
      if (STRICT_INBOX_FIFO) gi == 0 else true,
      tabs.get(t).phase == "waiting",
      // the block runs: its READ happens here, from the local cache
      tabs' = tabs.setBy(t, tb => { ...tb, phase: "reading", seen: cache.get(t) }),
      inbox' = inbox.set(t, q.indices().fold(List(), (acc, i) =>
        if (i == gi) acc else acc.append(q[i]))),
      storage' = storage, cache' = cache, waiters' = waiters,
      exclusiveHeld' = exclusiveHeld, sharedHolders' = sharedHolders,
    }
  }

  // --- the block commits: write seen+1 to storage and own cache,
  // publish to every other tab (append to their inboxes), release the
  // slot. One atomic action — faithful to program order: publish is
  // posted before release, so the broker fans out before the next grant.

  action commitAndRelease = {
    nondet t = oneOf(TABS)
    all {
      tabs.get(t).phase == "reading",
      storage' = tabs.get(t).seen + 1,
      cache' = cache.set(t, tabs.get(t).seen + 1),
      inbox' = TABS.mapBy(other =>
        if (other == t) inbox.get(other)
        else inbox.get(other).append({ kind: "broadcast", value: tabs.get(t).seen + 1 })),
      tabs' = tabs.setBy(t, tb => {
        phase: "idle", seen: 0, writesLeft: tb.writesLeft - 1,
      }),
      exclusiveHeld' = false,
      sharedHolders' = sharedHolders,
      waiters' = waiters,
    }
  }

  action step = any {
    requestSlot,
    pump,
    consumeBroadcast,
    consumeGrant,
    commitAndRelease,
  }

  // ----- invariants

  // The whole point: a committing block read the LATEST storage — its
  // increment loses nothing. (In the bug variant a block can commit
  // seen < storage, overwriting another tab's serialized-before write.)
  val commitReadsFresh =
    TABS.forall(t =>
      tabs.get(t).phase == "reading" implies tabs.get(t).seen == storage)

  // mutual exclusion: an exclusive hold means silence everywhere else
  val mutualExclusion =
    exclusiveHeld implies size(sharedHolders) == 0

  // at most one tab is ever inside a write block
  val oneWriterRunning =
    size(TABS.filter(t => tabs.get(t).phase == "reading")) <= 1

  // storage only ever counts completed increments
  val storageIsCommitCount =
    storage == TABS.fold(0, (sum, t) => sum + (MAX_WRITES - tabs.get(t).writesLeft))
      or TABS.exists(t => tabs.get(t).phase == "reading")

  val allInvariants = all {
    commitReadsFresh,
    mutualExclusion,
    oneWriterRunning,
  }
}
