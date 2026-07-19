# Simplification (design)

Status: proposed, not started. This page records what gets cut, what
replaces it, and how removed code stays revivable with proof instead of
archaeology.

## Goal

Roughly halve the codebase while keeping the features the project is
actually for: schema-inferred types with the Zod front end, reactive
queries on one engine, and the formally specified sync protocol on
every platform. Measured today (non-blank lines, tests included):

| Area | Lines |
| --- | --- |
| core: query + observation | ~1,350 |
| core: database | ~960 |
| core: schema | ~650 |
| core: sync | ~660 |
| core: model | ~230 |
| drivers (TS) | ~1,870 |
| driver-rn (C++, excl. vendored SQLite) | ~420 |
| zod + server | ~750 |
| conformance suites | ~1,190 |

## Principles

1. **Cut along seams.** A piece behind a small stable interface with a
   conformance suite can be removed and restored cheaply. A piece woven
   through the codebase cannot; removing it is a decision, not parking.
2. **Conformance suites are the revival insurance.** Restoring parked
   code means: check out the tagged version, reattach, run the named
   suite. Green means revived; anything else is a normal bug hunt with
   a known-good reference. The suites therefore stay, even though they
   are a fifth of the line count.
3. **Parked means gone from main.** No attic directory of unbuilt code.
   Each removal is tagged and recorded in a ledger; main only contains
   what runs.

## The cuts

### 1. Make the default RN driver an expo-sqlite wrapper; the C++ module becomes optional

Done as a split rather than a park: `@remelondb/driver-rn` is a
~100-line TS wrapper over `expo-sqlite` behind the same `SqliteDriver`
interface, and the C++ TurboModule moves unchanged to
`@remelondb/driver-rn-cpp` as an opt-in sibling (pinned SQLite, no expo
dependency, development build required). Same class name in both, so
switching is one import change. Separate packages because React Native
autolinking is per-package: native code anywhere in the default package
would force native builds on every consumer and break Expo Go.

Gains: apps run in **Expo Go** by default (expo-sqlite ships inside
it); the C++ toolchain leaves the default path. Costs: the C++ code
stays in the repo, compile-verified by the existing android CI job and
maintained to stay green rather than actively developed — so this cut
reduces default-path complexity and coupling, not line count. The 50%
target rests on the remaining cuts.

No ledger entry: nothing leaves the repo.

### 2. Remove the in-memory matcher and the simple observer

One observation strategy remains: re-fetch on relevant change, emit
when membership, order, or visible content differs. Removes the
matcher, its gate (`canEncodeMatcher`), the matcher-vs-SQLite corpus,
and the simple/reloading split in `Query`.

Gains: "SQLite is the only query engine" becomes true without
exception; the class of matcher/SQL disagreement bugs disappears; flat
queries gain content re-emission by construction. Costs: a re-query
per relevant change instead of an in-memory membership check. At the
data sizes this library targets that is not a measured problem; if it
becomes one, the matcher is parked, not lost.

Park insurance: good. The matcher is self-contained and its corpus
comes back with it.

### 3. Narrow Q to a conjunctive core

Keep: `where` with the comparison set (`eq` sugar, `gt/gte/lt/lte`,
`oneOf`, `notEq`, `like`), `sortBy`, `take`, `skip`. Remove: `Q.on`
joins, nested `Q.and`/`Q.or` trees, and the association graph they
need. Multiple clauses continue to mean AND. The raw-SQL escape hatch
remains for the tail (explicit, unobserved, clearly named unsafe).

Q itself stays. Queries as data is what provides observer table
tracking, central tombstone filtering, derived count queries, typed
column names, and enforced parameterization; deleting it would move
those duties into every caller.

Costs: querying across tables gets manual (denormalize, two queries,
or the escape hatch). Before this cut, audit the reference
application's queries; if joins are common there, this cut is dropped.

Park insurance: moderate. The removed pieces are compiler-internal,
but the surviving query corpus pins the remaining surface, and the
tagged compiler still carries its own tests.

### 4. Fold packaging: eight packages to five

`driver-conformance` becomes a dev-only subpath of core;
`server-conformance` of server. Publishing, README, and API-reference
surface shrink accordingly. Trivially reversible.

## Not cut

- **Sync**: client, engine, wire spec, Quint model, conformance. This
  is the reason the project exists.
- **Schema-inferred types and the Zod adapter**: the API the reference
  application is built on.
- **The web driver**, including multi-tab takeover (small, shipped,
  tested).

## Not parked: the Model layer

Removing models (classes, `ModelFor`, accessors, associations) is the
one cut that would be a real API decision. It touches `Collection`,
`Database.open`, the docs, and every consumer, so a revival after
months of drift approximates a rewrite. If plain records are wanted,
that gets its own design doc and a migration plan for consumers; it
does not go through the parking process.

## The ledger

Each removal adds a row to `docs/parked.md` before the deleting commit
merges:

| Piece | Tag | Path at tag | Why parked | Revival proof |
| --- | --- | --- | --- | --- |
| (example) C++ RN driver | `parked/driver-rn-cpp` | `packages/driver-rn/{cpp,src}` | maintenance cost; Expo Go | `driver-conformance` suite on Android + iOS |

Revival contract: check out the tag, restore the paths, reattach to
current main, run the named suite. The suite passing is the definition
of revived.

## Sequencing

One cut per arc, in the order above, tests green after each. Cut 1
lands only after the expo-sqlite wrapper passes driver conformance on
both platforms and the example app's runtime proof is repeated on it.
The result ships as a minor release with the parked ledger linked from
the release notes.

## Open questions

- Benchmark expo-sqlite vs. the C++ module before or after the swap,
  and what result would justify reviving the C++ driver.
- The reference application's join usage (decides cut 3).
- Whether `driver-node`'s integration tests, which exercise core
  behavior rather than the driver, should move into core when the
  packaging folds.
