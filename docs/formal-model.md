# How the formal model and its verification work

An explanation of [sync_model.qnt](sync_model.qnt): what it is, what
CI actually checks, what that does and does not guarantee. No formal
methods background assumed.

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
- **Id reuse**: a client may create a record under an id the server
  already knows — live, tombstoned, or garbage-collected — covering
  the delete-then-recreate corner next to where the GC-floor bug was
  found.
- **Tombstone GC**: the server forgets old deletions and raises a
  floor; clients whose cursor falls below it must resync.
- **The push-response contract as a switch** (`PUSH_MODE`), which is
  where the interesting results live.

## What "correct" means: the invariants

Three properties, checked after every step of every explored trace:

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

## What CI runs

Two commands on every push
([ci.yml](../.github/workflows/ci.yml)):

```sh
quint typecheck docs/sync_model.qnt
quint run docs/sync_model.qnt --invariant=allInvariants \
  --max-samples=25000 --max-steps=60
```

`quint run` is **random simulation**: 25,000 traces of up to 60 steps
each, invariants checked at every step. Green means no violation was
found in that search.

## Honest limits

- **Simulation is not proof.** Random search can miss a violation
  that needs a longer or rarer trace. The naive-mode canary — a known
  bug the search finds in seconds — is evidence the search is
  effective at this model's scale, not a guarantee of exhaustiveness.
  (Quint supports bounded model checking via `quint verify` for
  stronger claims; the CI budget currently buys simulation.)
- **The model is not the implementation.** It verifies the *protocol
  design* — the contract in sync-wire.md. That the TypeScript engine
  implements the contract is a separate obligation, carried by the
  sync integration tests and the server conformance suite. The wire
  spec is the bridge between the two; a bug can still live in code
  the model never sees.
- **The simplifications are real.** One synced user, a fixed set of
  row ids, and a push batch sharing one revision (which is the wire
  contract, not a shortcut). They are listed in the model's header
  comment so nobody mistakes silence for coverage.

## Try it yourself

```sh
npx @informalsystems/quint run docs/sync_model.qnt \
  --invariant=allInvariants --max-samples=25000 --max-steps=60
```

Then open the file, change `PUSH_MODE` to `"naive"`, run the same
command, and read the counterexample trace it prints: a
step-by-step reenactment of the lost-write race, ending in the state
the invariant forbids. Changing the protocol? Model the change here
first — an invariant violation at this stage costs minutes instead of
a corrupted database in the field.
