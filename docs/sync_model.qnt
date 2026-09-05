// -*- mode: quint -*-
// Formal model of the remelonDB sync protocol (docs/sync-wire.md;
// rationale in docs/sync-design.md). Beyond the degraded baseline it
// models what this protocol adds: the push response carries a cursor
// plus the interleaved foreign changes (both or neither), and servers
// may reject individual records.
//
// Scope: N clients of one user, one server, per-row LWW:
//   - monotonic server revision, one per push transaction (the model's
//     stand-in for any commit-ordered cursor mechanism; the wire cursor
//     is this revision, opaque to clients)
//   - pull = atomic snapshot of changes since cursor; local dirty wins
//   - push = atomic; aborts (conflict) if any pushed row is stale;
//     idempotent upserts; servers may reject a subset of records
//     (rejected rows stay dirty client-side)
//   - PUSH_MODE selects the push-response contract (sync-wire.md §3):
//       "full"     — response carries cursor + interleaved foreign
//                    changes; client applies them and adopts the cursor
//                    (the fast path; safe, and this model is the proof)
//       "degraded" — cursor: null / changes: null; client keeps its
//                    cursor, next pull absorbs the echo (safe)
//       "naive"    — cursor adopted WITHOUT the interleaved changes:
//                    the back-door lost-write race. perRowAgreement
//                    finds a violating trace in seconds — the reason
//                    sync-wire.md makes cursor+changes a package
//   - lost push responses (server applied, client never heard)
//   - storage refusals: the apply stage itself may refuse content rows
//     (unique/FK constraints surfaced by upsert); they join the
//     response's rejected list and the rest of the batch commits
//   - tombstone GC with a floor; replacement sync (resyncRequired)
//
// Simplifications: one synced user, fixed row ids, a push batch shares
// one revision (the wire contract: pushes are atomic).
//
// One client here is one row-set and one cursor, so the multi-tab shape
// is out of frame: several browser contexts sharing a single database
// and cursor, running sync concurrently, is not a configuration this
// model can reach or refute. That arbitration lives in the broker, and
// docs/multi-tab.qnt is where it is modelled — write-slot ownership,
// port death and the sync lease. A sync-side hazard that needs two
// contexts on one cursor belongs there, or in a remodel of this one
// that splits a client's row-set from its sync runners.
//
// Check:    quint typecheck docs/sync_model.qnt
// Simulate: quint run docs/sync_model.qnt --invariant=allInvariants \
//             --max-samples=25000 --max-steps=60
// Verify:   quint verify docs/sync_model.qnt --invariant=allInvariants \
//             --max-steps=5   (exhaustive to depth 5; needs a JVM)
module sync_model {
  pure val CLIENTS = Set("a", "b")
  pure val IDS = Set("r1", "r2")
  pure val VALS = Set(1, 2)
  pure val MAX_REV = 6
  pure val PUSH_MODE = "full" // "full" | "degraded" | "naive"
  // When true, the server may apply less than it reports as accepted —
  // the "silent drop" fault (a write to a tombstoned id, or a rewrite of
  // an append-only row, discarded but answered clean). Flipping this on
  // must break convergence: that is what makes "refusals are never
  // silent" a load-bearing rule rather than a stylistic one, the same
  // way PUSH_MODE = "naive" makes the interleave rule load-bearing.
  pure val SILENT_DROP = false
  // When true, a refused id's same-push deletion still applies — the
  // engine bug the deleted-supersedes rule fixed: content and a
  // deletion for one id travelled as separate statements, so a refusal
  // of the content half (validation, append-only, a storage
  // constraint) left the deletion live while the response named the id
  // rejected. The model's client keeps one statement per id, so the
  // leak attaches directly to refused deletions; the observable fault
  // is identical — an id named in `rejected` has an effect applied
  // anyway. Flipping this on must break rejectedNoEffect: the
  // deleted-supersedes rule (sync-wire.md §1) is load-bearing.
  pure val DELETE_LEAK = false
  pure val NO_VAL = 0

  pure val DIRTY_STATUSES = Set("created", "updated", "deleted")

  type SRow = { present: bool, del: bool, value: int, rev: int }
  type CRow = { value: int, status: str }

  var sRows: str -> SRow
  var sRev: int
  var gcFloor: int
  var cRows: str -> (str -> CRow)
  var cursor: str -> int
  // ghost state for rejectedNoEffect: the last push's rejected list
  // and the server rows as they stood before that push. Every other
  // action clears the list, so the invariant bites exactly on the
  // post-push state. Needed because rejected ids stay dirty client-
  // side and dirty rows are exempt from the agreement invariants — a
  // half-applied rejection is invisible without it.
  var lastRejected: Set[str]
  var lastBefore: str -> SRow

  def dirty(c: str): Set[str] =
    IDS.filter(id => DIRTY_STATUSES.contains(cRows.get(c).get(id).status))

  action init = all {
    sRows' = IDS.mapBy(id => { present: false, del: false, value: NO_VAL, rev: 0 }),
    sRev' = 0,
    gcFloor' = 0,
    cRows' = CLIENTS.mapBy(c => IDS.mapBy(id => { value: NO_VAL, status: "none" })),
    cursor' = CLIENTS.mapBy(c => 0),
    lastRejected' = Set(),
    lastBefore' = IDS.mapBy(id => { present: false, del: false, value: NO_VAL, rev: 0 }),
  }

  // ----- local offline writes: _status bookkeeping, the db is the queue

  action localCreate = {
    nondet c = oneOf(CLIENTS)
    nondet id = oneOf(IDS)
    nondet v = oneOf(VALS)
    all {
      cRows.get(c).get(id).status == "none",
      cRows' = cRows.setBy(c, m => m.set(id, { value: v, status: "created" })),
      cursor' = cursor,
      sRows' = sRows, sRev' = sRev, gcFloor' = gcFloor,
      lastRejected' = Set(), lastBefore' = lastBefore,
    }
  }

  action localUpdate = {
    nondet c = oneOf(CLIENTS)
    nondet id = oneOf(IDS)
    nondet v = oneOf(VALS)
    all {
      Set("synced", "created", "updated").contains(cRows.get(c).get(id).status),
      cRows' = cRows.setBy(c, m => m.setBy(id, r => {
        value: v,
        status: if (r.status == "created") "created" else "updated",
      })),
      cursor' = cursor,
      sRows' = sRows, sRev' = sRev, gcFloor' = gcFloor,
      lastRejected' = Set(), lastBefore' = lastBefore,
    }
  }

  action localDelete = {
    nondet c = oneOf(CLIENTS)
    nondet id = oneOf(IDS)
    all {
      Set("synced", "updated").contains(cRows.get(c).get(id).status),
      cRows' = cRows.setBy(c, m => m.setBy(id, r => { value: r.value, status: "deleted" })),
      cursor' = cursor,
      sRows' = sRows, sRev' = sRev, gcFloor' = gcFloor,
      lastRejected' = Set(), lastBefore' = lastBefore,
    }
  }

  // ----- pull: one atomic snapshot; local dirty wins; cursor -> sRev

  def pullRow(c: str, id: str): CRow = {
    val s = sRows.get(id)
    val l = cRows.get(c).get(id)
    if (s.present and s.rev > cursor.get(c) and Set("none", "synced").contains(l.status))
      if (s.del) { value: NO_VAL, status: "none" }
      else { value: s.value, status: "synced" }
    else l
  }

  action pull = {
    nondet c = oneOf(CLIENTS)
    all {
      cursor.get(c) >= gcFloor, // else the server answers resyncRequired
      cRows' = cRows.set(c, IDS.mapBy(id => pullRow(c, id))),
      cursor' = cursor.set(c, sRev),
      sRows' = sRows, sRev' = sRev, gcFloor' = gcFloor,
      lastRejected' = Set(), lastBefore' = lastBefore,
    }
  }

  // ----- push: conflict MUST — abort whole if any pushed row is stale.
  // Servers may reject a subset (validation/authorization); rejected
  // rows' effects are absent server-side and they stay dirty locally.

  def pushGuard(c: str): bool = and {
    dirty(c) != Set(),
    sRev < MAX_REV,
    dirty(c).forall(id =>
      not(sRows.get(id).present and sRows.get(id).rev > cursor.get(c))),
  }

  // `leaked` is only ever non-empty under DELETE_LEAK: refused ids
  // whose deletion applies anyway (they all hold status "deleted", so
  // they take the tombstone branch).
  def serverAfterPush(c: str, accepted: Set[str], leaked: Set[str]): str -> SRow =
    IDS.mapBy(id =>
      if (accepted.contains(id) or leaked.contains(id))
        if (cRows.get(c).get(id).status == "deleted")
          { present: true, del: true, value: sRows.get(id).value, rev: sRev + 1 }
        else
          { present: true, del: false, value: cRows.get(c).get(id).value, rev: sRev + 1 }
      else sRows.get(id))

  // The full fast path is only lawful when the server can compute the
  // COMPLETE interleave: a cursor below the GC floor has lost deletions
  // from its window, so the server must degrade (sync-wire.md §3; this
  // guard is the model-discovered obligation — remove it and the fast
  // path silently resurrects a GC'd deletion).
  def fullPathOk(c: str): bool =
    PUSH_MODE == "full" and cursor.get(c) >= gcFloor

  // The client after a push response: accepted rows flip to synced
  // (tombstones drop out); on the full fast path the response's
  // interleaved foreign changes apply exactly like a pull. pushGuard
  // already ensures no dirty row sits in the interleave window, so the
  // window only touches rows in clean states.
  def clientAfterPush(c: str, accepted: Set[str]): str -> CRow =
    IDS.mapBy(id => {
      val l = cRows.get(c).get(id)
      val s = sRows.get(id)
      if (accepted.contains(id))
        if (l.status == "deleted") { value: NO_VAL, status: "none" }
        else { value: l.value, status: "synced" }
      else if (and {
        fullPathOk(c),
        s.present,
        s.rev > cursor.get(c),
        Set("none", "synced").contains(l.status),
      })
        if (s.del) { value: NO_VAL, status: "none" }
        else { value: s.value, status: "synced" }
      else l
    })

  // response received; rejections come from two stages. The engine
  // rejects before apply (validation, ownership, tombstoned ids,
  // cross-validation) and may name any statement; storage refuses
  // DURING apply (a unique/FK constraint surfaced by the upsert) and
  // only ever sees content rows — deletions are tombstone writes, not
  // upserts. Both stages land in the response's `rejected` list,
  // indistinguishable to the client, and the rest of the batch
  // commits. A fully-rejected push commits nothing, so it MUST NOT
  // mint a revision — its fast-path response identifies the current
  // snapshot instead.
  //
  // `named` is what the response reports as rejected, `dropped` is what
  // the server additionally failed to apply without saying so. They are
  // equal unless SILENT_DROP is on: applying and reporting are one
  // decision, and that identity is the property under test.
  action pushAccepted = {
    nondet c = oneOf(CLIENTS)
    nondet reported = oneOf(dirty(c).powerset())
    nondet storageRefused = oneOf(
      dirty(c)
        .filter(id => cRows.get(c).get(id).status != "deleted")
        .exclude(reported)
        .powerset())
    nondet dropped = oneOf(
      dirty(c).exclude(reported).exclude(storageRefused).powerset())
    val named = reported.union(storageRefused)
    val unapplied = if (SILENT_DROP) named.union(dropped) else named
    val leaked =
      if (DELETE_LEAK)
        named.filter(id => cRows.get(c).get(id).status == "deleted")
      else Set()
    val committed = dirty(c).exclude(unapplied).union(leaked)
    all {
      pushGuard(c),
      sRows' = serverAfterPush(c, dirty(c).exclude(unapplied), leaked),
      sRev' = if (committed == Set()) sRev else sRev + 1,
      // the client trusts the response: everything not *named*
      // rejected flips to synced, silently dropped rows included
      cRows' = cRows.set(c, clientAfterPush(c, dirty(c).exclude(named))),
      cursor' = {
        val snapshot = if (committed == Set()) sRev else sRev + 1
        if (PUSH_MODE == "naive") cursor.set(c, snapshot)
        else if (fullPathOk(c)) cursor.set(c, snapshot)
        else cursor // degraded response: cursor null, keep the old one
      },
      gcFloor' = gcFloor,
      lastRejected' = named,
      lastBefore' = sRows,
    }
  }

  // response lost: server applied what it accepted, client unchanged ->
  // retry (idempotent upserts absorb the replay). A fully-rejected lost
  // push changes nothing on either side, so it is excluded as a stutter.
  action pushLost = {
    nondet c = oneOf(CLIENTS)
    nondet rejected = oneOf(dirty(c).powerset())
    all {
      pushGuard(c),
      rejected != dirty(c),
      sRows' = serverAfterPush(c, dirty(c).exclude(rejected), Set()),
      sRev' = sRev + 1,
      cRows' = cRows,
      cursor' = cursor,
      gcFloor' = gcFloor,
      // no response reached the client, but internally refused ids
      // must equally leave no trace — same property, response or not
      lastRejected' = rejected,
      lastBefore' = sRows,
    }
  }

  // ----- tombstone GC: forget old tombstones, raise the resync floor

  action gc = {
    nondet g = oneOf(1.to(MAX_REV))
    all {
      g <= sRev,
      g > gcFloor,
      sRows' = IDS.mapBy(id => {
        val s = sRows.get(id)
        if (s.present and s.del and s.rev <= g)
          { present: false, del: false, value: NO_VAL, rev: s.rev }
        else s
      }),
      gcFloor' = g,
      sRev' = sRev, cRows' = cRows, cursor' = cursor,
      lastRejected' = Set(), lastBefore' = lastBefore,
    }
  }

  // ----- replacement sync (first sync and resyncRequired); dirty survives

  action resync = {
    nondet c = oneOf(CLIENTS)
    all {
      cRows' = cRows.set(c, IDS.mapBy(id => {
        val s = sRows.get(id)
        val l = cRows.get(c).get(id)
        if (DIRTY_STATUSES.contains(l.status)) l
        else if (s.present and not(s.del)) { value: s.value, status: "synced" }
        else { value: NO_VAL, status: "none" }
      })),
      cursor' = cursor.set(c, sRev),
      sRows' = sRows, sRev' = sRev, gcFloor' = gcFloor,
      lastRejected' = Set(), lastBefore' = lastBefore,
    }
  }

  action step = any {
    localCreate, localUpdate, localDelete,
    pull, pushAccepted, pushLost, gc, resync,
  }

  // ----- invariants

  val cursorBound = CLIENTS.forall(c => cursor.get(c) <= sRev)

  // The heart of it: if a client's cursor covers a row's rev and it holds
  // no local edit, it must agree with the server. PUSH_MODE = "naive"
  // violates this (adopting the push cursor without the interleaved
  // changes skips a foreign write forever — the lost-write race).
  val perRowAgreement =
    CLIENTS.forall(c => IDS.forall(id => {
      val s = sRows.get(id)
      val l = cRows.get(c).get(id)
      (s.present and cursor.get(c) >= s.rev) implies (
        if (s.del) l.status != "synced"
        else or {
          DIRTY_STATUSES.contains(l.status),
          l.status == "synced" and l.value == s.value,
        }
      )
    }))

  // A fully-caught-up, fully-pushed client mirrors the server exactly.
  val fullAgreement =
    CLIENTS.forall(c =>
      (cursor.get(c) == sRev and dirty(c) == Set()) implies
        IDS.forall(id =>
          (sRows.get(id).present and not(sRows.get(id).del))
            iff (cRows.get(c).get(id).status == "synced")))

  // The rejected list is a guarantee, not a mood: an id a push named
  // in `rejected` holds exactly the server state it held before that
  // push — no half of its effect applies (sync-wire.md §1 terminal-
  // statement rule, §3 rejected records). SILENT_DROP's mirror image:
  // that fault applies less than the response claims; this catches
  // applying more. DELETE_LEAK = true violates it within seconds.
  val rejectedNoEffect =
    lastRejected.forall(id => sRows.get(id) == lastBefore.get(id))

  val allInvariants = and {
    cursorBound, perRowAgreement, fullAgreement, rejectedNoEffect,
  }
}
