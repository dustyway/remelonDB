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
// Model simplifications: one storage cell, no refcounted open/close,
// tab count and write budget fixed. A compute worker is one host tab
// and a quiet/answering bit; its queries and backlog are not modeled.
//
// Check:    quint typecheck docs/multi-tab.qnt
// Simulate: quint run docs/multi-tab.qnt --invariant=allInvariants \
//             --max-samples=8000 --max-steps=50
//
// Flip STRICT_INBOX_FIFO to false to reproduce the lost update the
// implementation hit (slice 4): consuming a grant ahead of earlier
// queued broadcasts models "slot acquired inside the local queue" —
// the block then reads a cache missing a serialized-before commit,
// and commitReadsFresh fails with a two-tab counterexample.
//
// The adversarial review behind the 0.3.0 hardening pass found four
// more failures this model could not express, so the transitions now
// exist, each behind a flag whose false setting reproduces the shipped
// bug (`quint run` with the named invariant finds each in seconds):
//   - OWNER_CHECKED_RELEASE = false: any tab may release the exclusive
//     slot (the broker never checked ownership) — oneWriterRunning fails
//     with a two-tab counterexample, and commitReadsFresh with it.
//   - DEATH_SWEEP = false: a tab dying inside a write block strands the
//     slot forever (no port-death detection) — deadHolderSwept fails, the
//     model's rendering of "every later read, write and close hangs".
//     tick is urgent under DEATH_SWEEP: time may not pass the sweep
//     deadline while a dead tab still holds the slot, so the invariant
//     states a bound the detector has to meet rather than an eventuality.
//   - RECONFIRM_LEASE = false: a sync run whose lease expired keeps its
//     destructive mark step (the tombstone race) — markHoldsLease fails
//     once a second tab legitimately acquires the expired lease.
//   - RESET_NEEDS_HOST_DEATH = false: an epoch reset fires on compute
//     silence rather than on the death of the tab hosting it —
//     resetOnHostDeath fails, which is the state the two epoch-reset P1s
//     (a memory database restored as opfs, a stranded query replayed
//     ahead of its restore-open) both start from.
// The fixed design (all flags true) holds every invariant.

module multi_tab {
  pure val TABS = Set("a", "b", "c")
  pure val MAX_WRITES = 3
  pure val STRICT_INBOX_FIFO = true
  pure val OWNER_CHECKED_RELEASE = true
  pure val DEATH_SWEEP = true
  pure val RECONFIRM_LEASE = true
  pure val RESET_NEEDS_HOST_DEATH = true
  pure val NO_TAB = ""
  pure val LEASE_MS = 3
  pure val SWEEP_MS = 2

  // broker -> tab messages; one FIFO per tab, grants and broadcasts mixed
  type Msg = { kind: str, value: int } // kind: "grant" | "broadcast"

  // a tab's participation in one write block
  // "idle" -> "waiting" (slot requested) -> "reading" (granted; the
  // block's read happens on grant consumption) -> commit -> "idle";
  // "dead" is terminal (the tab navigated away or crashed)
  type Tab = { phase: str, seen: int, writesLeft: int }

  var storage: int
  var cache: str -> int
  var inbox: str -> List[Msg]
  var tabs: str -> Tab

  // broker state: exclusive holder (at most one, by name — ownership
  // and death both need to know who), shared holders, FIFO queue
  var exclusiveHolder: str
  var sharedHolders: Set[str]
  var waiters: List[{ tab: str, exclusive: bool }]

  // the sync lease: one tab may run synchronize at a time, for a bounded
  // term; a run's destructive final step re-confirms the lease
  var now: int
  var leaseHolder: str
  var leaseExpiry: int
  // "idle" | "running" per tab; the mark step itself is atomic
  var syncPhase: str -> str
  // when the current exclusive holder died (-1: alive or no holder)
  var holderDeadAt: int

  // the compute worker runs inside one tab and dies with it; it also
  // falls silent while busy, which is not the same thing
  var computeHost: str
  var computeQuiet: bool
  // witness: an epoch reset fired while the host tab was still alive
  var badReset: bool
  // witness: a mark ran without the lease (the tombstone race happened)
  var badMark: bool

  // --- broker: grant from the head of the queue (called after any change)
  // exclusive: only into silence; shared: only when no exclusive holds.
  // Only the HEAD may be granted (strict FIFO — no starvation).

  def headGrantable(w: List[{ tab: str, exclusive: bool }]): bool =
    if (length(w) == 0) false
    else if (w[0].exclusive)
      (exclusiveHolder == NO_TAB and size(sharedHolders) == 0)
    else exclusiveHolder == NO_TAB

  action init = all {
    storage' = 0,
    cache' = TABS.mapBy(t => 0),
    inbox' = TABS.mapBy(t => List()),
    tabs' = TABS.mapBy(t => { phase: "idle", seen: 0, writesLeft: MAX_WRITES }),
    exclusiveHolder' = NO_TAB,
    sharedHolders' = Set(),
    waiters' = List(),
    now' = 0,
    leaseHolder' = NO_TAB,
    leaseExpiry' = 0,
    syncPhase' = TABS.mapBy(t => "idle"),
    holderDeadAt' = -1,
    badMark' = false,
    computeHost' = NO_TAB,
    computeQuiet' = false,
    badReset' = false,
  }

  // every action leaves the frames it does not touch unchanged. The
  // three frames are disjoint; an action names the ones it skips.
  action frameSlots = all {
    storage' = storage, cache' = cache, inbox' = inbox, tabs' = tabs,
    exclusiveHolder' = exclusiveHolder, sharedHolders' = sharedHolders,
    waiters' = waiters, holderDeadAt' = holderDeadAt,
  }
  action frameSync = all {
    now' = now, leaseHolder' = leaseHolder, leaseExpiry' = leaseExpiry,
    syncPhase' = syncPhase, badMark' = badMark,
  }
  action frameCompute = all {
    computeHost' = computeHost, computeQuiet' = computeQuiet,
    badReset' = badReset,
  }
  action unchangedSync = all { frameSync, frameCompute }
  action unchangedSlots = all { frameSlots, frameCompute }
  action unchangedButCompute = all { frameSlots, frameSync }

  // --- a tab asks for an exclusive slot (starts a write block)

  action requestSlot = {
    nondet t = oneOf(TABS)
    all {
      tabs.get(t).phase == "idle",
      tabs.get(t).writesLeft > 0,
      waiters' = waiters.append({ tab: t, exclusive: true }),
      tabs' = tabs.setBy(t, tb => { ...tb, phase: "waiting" }),
      storage' = storage, cache' = cache, inbox' = inbox,
      exclusiveHolder' = exclusiveHolder, sharedHolders' = sharedHolders,
      holderDeadAt' = holderDeadAt,
      unchangedSync,
    }
  }

  // --- broker pumps: grant the head waiter by queueing a grant message
  // into that tab's inbox (delivery is asynchronous, order preserved)

  action pump = all {
    headGrantable(waiters),
    exclusiveHolder' =
      if (waiters[0].exclusive) waiters[0].tab else exclusiveHolder,
    sharedHolders' =
      if (waiters[0].exclusive) sharedHolders
      else sharedHolders.union(Set(waiters[0].tab)),
    inbox' = inbox.setBy(waiters[0].tab, q => q.append({ kind: "grant", value: 0 })),
    waiters' = waiters.slice(1, length(waiters)),
    storage' = storage, cache' = cache, tabs' = tabs,
    holderDeadAt' = holderDeadAt,
    unchangedSync,
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
      exclusiveHolder' = exclusiveHolder, sharedHolders' = sharedHolders,
      holderDeadAt' = holderDeadAt,
      unchangedSync,
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
      exclusiveHolder' = exclusiveHolder, sharedHolders' = sharedHolders,
      holderDeadAt' = holderDeadAt,
      unchangedSync,
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
      exclusiveHolder' = NO_TAB,
      sharedHolders' = sharedHolders,
      waiters' = waiters,
      holderDeadAt' = -1,
      unchangedSync,
    }
  }

  // --- a tab tries to release the exclusive slot it does not own.
  // The broker's slot ids are guessable; with the ownership check the
  // request is a no-op, without it two write blocks run at once.

  action foreignRelease = {
    nondet t = oneOf(TABS)
    all {
      exclusiveHolder != NO_TAB,
      exclusiveHolder != t,
      tabs.get(t).phase != "dead",
      exclusiveHolder' = if (OWNER_CHECKED_RELEASE) exclusiveHolder else NO_TAB,
      holderDeadAt' = if (OWNER_CHECKED_RELEASE) holderDeadAt else -1,
      storage' = storage, cache' = cache, inbox' = inbox, tabs' = tabs,
      sharedHolders' = sharedHolders, waiters' = waiters,
      unchangedSync,
    }
  }

  // --- a tab dies at any moment: navigation, crash, tab close. Its
  // state stays exactly as it was — that is the point.

  action tabDies = {
    nondet t = oneOf(TABS)
    all {
      tabs.get(t).phase != "dead",
      tabs' = tabs.setBy(t, tb => { ...tb, phase: "dead" }),
      holderDeadAt' = if (exclusiveHolder == t) now else holderDeadAt,
      storage' = storage, cache' = cache, inbox' = inbox,
      exclusiveHolder' = exclusiveHolder, sharedHolders' = sharedHolders,
      waiters' = waiters,
      unchangedSync,
    }
  }

  // --- the failure detector: heartbeats lapse and the broker sweeps a
  // dead tab's state — its slot, its queued requests, its lease. This
  // is the transition whose absence let a dead tab strand the broker.

  action sweepDead = {
    nondet t = oneOf(TABS)
    all {
      DEATH_SWEEP,
      tabs.get(t).phase == "dead",
      or {
        exclusiveHolder == t,
        sharedHolders.contains(t),
        waiters.indices().fold(false, (found, i) =>
          found or waiters[i].tab == t),
        leaseHolder == t,
      },
      exclusiveHolder' = if (exclusiveHolder == t) NO_TAB else exclusiveHolder,
      holderDeadAt' = if (exclusiveHolder == t) -1 else holderDeadAt,
      sharedHolders' = sharedHolders.exclude(Set(t)),
      waiters' = waiters.indices().fold(List(), (acc, i) =>
        if (waiters[i].tab == t) acc else acc.append(waiters[i])),
      leaseHolder' = if (leaseHolder == t) NO_TAB else leaseHolder,
      leaseExpiry' = leaseExpiry,
      storage' = storage, cache' = cache, inbox' = inbox, tabs' = tabs,
      now' = now, syncPhase' = syncPhase, badMark' = badMark,
      frameCompute,
    }
  }

  // --- the sync lease: time passes, a tab acquires (free, expired, or
  // its own), runs, and finishes with the destructive mark step. The
  // reviewed race: the run outlives the lease, a second tab acquires
  // legitimately, and the first run's mark destroys newer state.

  action tick = all {
    // the watchdog is urgent: with the detector on, time cannot pass the
    // sweep deadline while a dead tab still holds the exclusive slot
    not(DEATH_SWEEP and holderDeadAt != -1 and now + 1 > holderDeadAt + SWEEP_MS),
    now' = now + 1,
    leaseHolder' = leaseHolder, leaseExpiry' = leaseExpiry,
    syncPhase' = syncPhase, badMark' = badMark,
    unchangedSlots,
  }

  action acquireLease = {
    nondet t = oneOf(TABS)
    all {
      tabs.get(t).phase != "dead",
      syncPhase.get(t) == "idle",
      or {
        leaseHolder == NO_TAB,
        leaseHolder == t,
        leaseExpiry <= now,
      },
      leaseHolder' = t,
      leaseExpiry' = now + LEASE_MS,
      syncPhase' = syncPhase.set(t, "running"),
      now' = now, badMark' = badMark,
      unchangedSlots,
    }
  }

  // the run ends with the destructive mark-as-synced write. The fix
  // re-confirms the lease first; a run that lost it may only abort.
  action mark = {
    nondet t = oneOf(TABS)
    all {
      tabs.get(t).phase != "dead",
      syncPhase.get(t) == "running",
      if (RECONFIRM_LEASE) leaseHolder == t else true,
      badMark' = (badMark or leaseHolder != t),
      syncPhase' = syncPhase.set(t, "idle"),
      leaseHolder' = if (leaseHolder == t) NO_TAB else leaseHolder,
      leaseExpiry' = leaseExpiry,
      now' = now,
      unchangedSlots,
    }
  }

  action abortRun = {
    nondet t = oneOf(TABS)
    all {
      RECONFIRM_LEASE,
      syncPhase.get(t) == "running",
      leaseHolder != t,
      syncPhase' = syncPhase.set(t, "idle"),
      now' = now, leaseHolder' = leaseHolder, leaseExpiry' = leaseExpiry,
      badMark' = badMark,
      unchangedSlots,
    }
  }

  // --- the compute worker: adopted by a tab, silent under load, and
  // re-hosted by an epoch reset. Silence is not death; resetting on it
  // is what stranded queries and rewrote a memory database as opfs.

  action adoptCompute = {
    nondet t = oneOf(TABS)
    all {
      computeHost == NO_TAB,
      tabs.get(t).phase != "dead",
      computeHost' = t,
      computeQuiet' = false,
      badReset' = badReset,
      unchangedButCompute,
    }
  }

  action computeGoesQuiet = all {
    computeHost != NO_TAB,
    not(computeQuiet),
    computeQuiet' = true,
    computeHost' = computeHost, badReset' = badReset,
    unchangedButCompute,
  }

  action computeAnswers = all {
    computeQuiet,
    computeHost != NO_TAB,
    tabs.get(computeHost).phase != "dead",
    computeQuiet' = false,
    computeHost' = computeHost, badReset' = badReset,
    unchangedButCompute,
  }

  action resetEpoch = all {
    computeHost != NO_TAB,
    computeQuiet,
    // the fix: silence alone is not grounds for a reset
    if (RESET_NEEDS_HOST_DEATH) tabs.get(computeHost).phase == "dead" else true,
    badReset' = (badReset or tabs.get(computeHost).phase != "dead"),
    computeHost' = NO_TAB,
    computeQuiet' = false,
    unchangedButCompute,
  }

  action step = any {
    requestSlot,
    pump,
    consumeBroadcast,
    consumeGrant,
    commitAndRelease,
    foreignRelease,
    tabDies,
    sweepDead,
    tick,
    acquireLease,
    mark,
    abortRun,
    adoptCompute,
    computeGoesQuiet,
    computeAnswers,
    resetEpoch,
  }

  // ----- invariants

  // The whole point: a committing block read the LATEST storage — its
  // increment loses nothing. (In the bug variant a block can commit
  // seen < storage, overwriting another tab's serialized-before write.)
  val commitReadsFresh =
    TABS.forall(t =>
      tabs.get(t).phase == "reading" implies tabs.get(t).seen == storage)

  // mutual exclusion: an exclusive hold means silence everywhere else
  // vacuous as the model stands: requestSlot only ever asks for exclusive
  // slots, so sharedHolders stays empty. Kept because pump implements the
  // shared branch; oneWriterRunning is what actually catches a double grant.
  val mutualExclusion =
    exclusiveHolder != NO_TAB implies size(sharedHolders) == 0

  // at most one tab is ever inside a write block
  val oneWriterRunning =
    size(TABS.filter(t => tabs.get(t).phase == "reading")) <= 1

  // storage only ever counts completed increments
  val storageIsCommitCount =
    storage == TABS.fold(0, (sum, t) => sum + (MAX_WRITES - tabs.get(t).writesLeft))
      or TABS.exists(t => tabs.get(t).phase == "reading")

  // a dead tab's grip on the exclusive slot never outlives the detection
  // window (fails with DEATH_SWEEP = false: the modeled deadlock)
  val deadHolderSwept =
    holderDeadAt != -1 implies now <= holderDeadAt + SWEEP_MS

  // no mark-as-synced ever ran without the lease (fails with
  // RECONFIRM_LEASE = false: the modeled tombstone race)
  val markHoldsLease = not(badMark)

  // no epoch reset ever fired under a live host (fails with
  // RESET_NEEDS_HOST_DEATH = false: the two epoch-reset P1s)
  val resetOnHostDeath = not(badReset)

  val allInvariants = all {
    commitReadsFresh,
    mutualExclusion,
    oneWriterRunning,
    deadHolderSwept,
    markHoldsLease,
    resetOnHostDeath,
  }
}
