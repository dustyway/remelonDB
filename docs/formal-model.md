# How the formal models and their verification work

An explanation of the Quint models in this repo: what they are, what
CI actually checks, what that does and does not guarantee. No formal
methods background assumed. There are two:

- [sync_model.qnt](sync_model.qnt) — the client/server sync protocol
  (the original model this page was written around; everything below
  uses it as the running example).
- [multi-tab.qnt](multi-tab.qnt) — the browser multi-tab coordination
  protocol from [multi-tab.md](multi-tab.md): write-slot arbitration
  plus change broadcast, and the FIFO ordering invariant that makes a
  write block always read what was serialized before it. Same
  conventions as the sync model, including the bug-reproduction flag:
  `STRICT_INBOX_FIFO = false` models the discarded acquire-inside-queue
  design and fails `commitReadsFresh` with a lost-update trace — that
  bug was first caught by a browser test during implementation; the
  model now reproduces it on demand and certifies the shipped fix
  across every interleaving it explores.

Both are typechecked in CI; simulation runs locally (see below).

## Why a model exists

Sync bugs live in interleavings. A client edits offline, another
pushes first, a push response gets lost, the server garbage-collects a
tombstone, and only *one specific ordering* of those events corrupts
state. Example-based tests check the orderings someone thought of; the
interesting bug is by definition in one nobody did.

The model attacks this differently: describe the protocol as a small
mathematical machine, state what "correct" means as properties that
must hold after *every* possible sequence of events, and let a tool
search orderings by the tens of thousands. The model found one real
design obligation (the GC-floor guard below) and provides a
reproducible demonstration of the race the protocol exists to prevent.

## What Quint is

[Quint](https://quint-lang.org/) is a specification language from
Informal Systems (same lineage as TLA+). A specification has three
parts:

- **State variables** — the world: server rows, each client's rows,
  each client's cursor, the GC floor.
- **Actions** — everything that can happen as atomic steps: a local
  edit, a pull, a push, a lost push response, a GC run, a resync. Each
  action says when it is allowed and how it changes state.
- **Invariants** — properties that must hold in every reachable
  state, no matter which actions fired in which order.

The tool then plays adversary: starting from the initial state it
picks any allowed action, applies it, checks the invariants, and
repeats. Any sequence that breaks an invariant is printed as a
step-by-step counterexample trace.

## The model's world is deliberately tiny

Two clients, two row ids, two possible values, revisions capped at 6.
That is not a weakness; it is the method. Protocol bugs are almost
always expressible with two of everything ("small scope hypothesis"),
and a small world means the search covers a meaningful fraction of it.
The model also simplifies honestly and says so in its header: one
synced user, a push batch shares one revision.

What it does include is the hostile stuff:

- **Lost push responses** (`pushLost`): the server applied what it
  accepted — possibly rejecting part of the push — and the client
  never heard back, so it retries everything. Idempotent upserts make
  this safe; the model checks that they do.
- **Per-record rejection, up to the whole push**: a server may reject
  any subset of a push, including all of it. A fully-rejected push
  commits nothing and must not mint a revision; rejected rows stay
  dirty client-side.
- **Storage refusals during apply**: beyond the engine's pre-apply
  rejections, the apply stage itself may refuse rows (a unique or
  foreign-key constraint surfaced by the upsert — wire checklist
  item 14). The split is structural: storage only ever sees content
  rows, never deletions, and both stages merge into one `rejected`
  list the client cannot tell apart.
- **Id reuse**: a client may create a record under an id the server
  already knows — live, tombstoned, or garbage-collected — covering
  the delete-then-recreate corner next to where the GC-floor bug was
  found.
- **Tombstone GC**: the server forgets old deletions and raises a
  floor; clients whose cursor falls below it must resync.
- **The push-response contract as a switch** (`PUSH_MODE`), which is
  where the interesting results live.
- **Whether refusals are visible** (`SILENT_DROP`), a fault switch: a
  server that applies less than it reports as accepted.
- **Whether a rejected id can leak an effect** (`DELETE_LEAK`), the
  opposite fault switch: a server that applies *more* than it reports —
  a refused id's same-push deletion lands anyway. This is the engine
  bug the deleted-supersedes rule fixed (wire spec §1).

## What "correct" means: the invariants

Four properties, checked after every step of every explored trace:

- `cursorBound` — a client's cursor never runs ahead of the server's
  revision. A sanity floor.
- `perRowAgreement` — the heart. In words: *if your cursor claims you
  have seen history up to revision N, then for any row whose last
  server change is ≤ N and which you hold no local edit on, you must
  agree with the server.* A client that claims to be caught up but
  silently disagrees is exactly what "a lost write" means.
- `fullAgreement` — a client that is fully caught up (cursor at the
  server's revision) with nothing left to push mirrors the server
  exactly, row for row.
- `rejectedNoEffect` — the rejected list is a guarantee: an id a push
  named in `rejected` holds exactly the server state it held before
  that push, never half of its effect. Checked through two ghost
  variables remembering the last push's rejected list and the pre-push
  server rows.

## What the checking found

**The lost-write race, reproducible.** The wire spec requires that a
push response carries the new cursor *and* the interleaved foreign
changes together, or neither ([sync-wire.md](sync-wire.md) §3).
`PUSH_MODE = "naive"` models the tempting shortcut: adopt the cursor,
skip the changes. Flip the constant and run the checker; it produces a
`perRowAgreement` violation within seconds — a concrete trace where a
client permanently skips another device's committed write. That trace
is the *reason* the spec makes cursor-plus-changes a package, kept in
executable form.

**Refusals must be visible, and that is checkable.** A server can
decline a row for many reasons (validation, a tombstoned id, an
append-only table). What it may not do is decline *quietly*: apply less
than it reports as accepted. `SILENT_DROP = true` models that fault —
the response names fewer rejections than the server actually dropped —
and the invariants fall within a second. The trace is the phantom
record: the client flips the row to synced, the server never stored it,
the cursor advances past the revision, and no later pull mentions the
row again, so the divergence is permanent. This is the class three
shipped bugs belonged to (releases 0.1.3 and 0.1.5); the model now
holds the reason they were bugs, not just the fixes.

**Storage refusals and the rejection guarantee — checked, not argued.**
Wire checklist item 14 lets storage itself refuse rows mid-apply
(unique/FK constraints), with the rest of the batch committing. Whether
that interacts with the invariants had been argued but never checked;
the model now draws storage refusals as a separate nondeterministic
stage (content rows only, merged into the same `rejected` list) and all
invariants hold across 25,000 traces. The checking also exposed a blind
spot: the three original invariants exempt dirty rows, and rejected
rows stay dirty, so *no existing property could see a half-applied
rejection*. With `DELETE_LEAK = true` — the engine bug the
deleted-supersedes rule fixed (§1), where a refused id's same-push
deletion applied anyway — the original three invariants stay green
while the new `rejectedNoEffect` falls in milliseconds. The invariant
is the model-level statement of "a rejected id leaves no effect", and
the flag keeps the bug reproducible the way `PUSH_MODE = "naive"`
keeps the lost-write race.

**The GC-floor obligation — discovered by the model.** The fast path
(server answers a push with cursor + interleave) is only lawful when
the server can compute the *complete* interleave. A client whose
cursor is below the GC floor has lost deletions from its window: the
tombstones are gone, so the interleave cannot mention them, and
adopting the cursor would resurrect a deleted record. The model run
surfaced this; the fix is the guard in `fullPathOk` — below the floor,
the server must degrade the response (cursor null) instead. This
obligation is now a MUST in the wire spec. It is the concrete payoff
of the modeling effort: a bug found before any implementation had it.

## How it is checked

CI runs one command on every push ([ci.yml](../.github/workflows/ci.yml)),
guarding that the model stays well-typed:

```sh
quint typecheck docs/sync_model.qnt
```

Running the invariants is an offline practice, done when the model
changes — both commands live in the model's header:

```sh
quint run docs/sync_model.qnt --invariant=allInvariants \
  --max-samples=25000 --max-steps=60
```

`quint run` is **random simulation**: 25,000 traces of up to 60 steps
each, invariants checked at every step — deep but sampled.

Alongside it, `quint verify` does **bounded model checking** (Apalache
over an SMT solver): it covers *every* possible trace up to a given
depth, exhaustively. Its cost grows steeply with depth (minutes to
hours). Both stay offline rather than in CI: simulation reaches deep
interleavings by luck, bounded checking rules out shallow ones by
construction. The
bounds are only meaningful because known bugs are caught at them: the
naive-mode canary (a 4-step trace) fails `verify` at depth 5 in about
30 seconds.

## Honest limits

- **The checking is bounded.** Exhaustive coverage stops at the
  deepest completed `verify` bound; beyond it, random simulation can
  miss a violation that needs a longer or rarer trace. The canaries —
  known bugs the checks find fast — are evidence the search is
  effective at this model's scale, not a guarantee of unbounded
  correctness.
- **The model is not the implementation.** It verifies the *protocol
  design* — the contract in [sync-wire.md](sync-wire.md). That the
  code implements the contract is carried by the spec's other
  executable verifications: the server conformance suite
  (`@remelondb/server/conformance` — one scenario per item of the wire
  spec's checklist), the client sync integration tests in driver-node,
  and the [sync tour](sync-tour.md), whose captured request/response
  pairs CI replays against the example server. The wire spec is the
  bridge between all of them; a bug can still live in code the model
  never sees.
- **The simplifications are real.** One synced user, a fixed set of
  row ids, and a push batch sharing one revision (which is the wire
  contract, not a shortcut). They are listed in the model's header
  comment so nobody mistakes silence for coverage.

## Try it yourself

```sh
npx @informalsystems/quint@0.32.0 run docs/sync_model.qnt \
  --invariant=allInvariants --max-samples=25000 --max-steps=60
```

Then open the file, change `PUSH_MODE` to `"naive"`, run the same
command, and read the counterexample trace it prints: a
step-by-step reenactment of the lost-write race, ending in the state
the invariant forbids. `SILENT_DROP = true` does the same for the
phantom-record fault, and `DELETE_LEAK = true` for the half-applied
rejection (a deletion landing for an id the response named rejected). Changing the protocol? Model the change here
first — an invariant violation at this stage costs minutes instead of
a corrupted database in the field.
