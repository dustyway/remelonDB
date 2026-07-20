# Simplification (design)

Status: done — all three cuts have landed. This page records what gets cut
and what replaces it.

## Goal

Shrink the codebase and its default-path complexity while keeping the
features the project is actually for: schema-inferred types with the
Zod front end, reactive queries on one engine, and the formally
specified sync protocol on every platform. Measured before the cuts
(non-blank lines, tests included):

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
   conformance suite can be removed cleanly. A piece woven through the
   codebase cannot; removing it is an API decision, not a deletion.
2. **Removed means gone.** Main only contains what runs — no attic
   directory of unbuilt code, no revival machinery. Git history is the
   archive.
3. **Conformance suites stay.** They pin the behavior of the surviving
   surface, even though they are a fifth of the line count.

## The cuts

### 1. Make the default RN driver an expo-sqlite wrapper; the C++ module becomes optional

Done as a split rather than a removal: `@remelondb/driver-rn` is a
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
reduces default-path complexity and coupling, not line count.

### 2. Remove the in-memory matcher and the simple observer

Done. One observation strategy remains: re-fetch on relevant change,
emit when membership, order, or visible content differs. Removed the
matcher, its gate (`canEncodeMatcher`), the matcher-vs-SQLite corpus
(its distinctive engine-semantics cases moved into the SQL query
corpus), and the simple/reloading split in `Query`.

Gains: "SQLite is the only query engine" becomes true without
exception; the class of matcher/SQL disagreement bugs disappears; flat
queries gain content re-emission by construction. Costs: a re-query
per relevant change instead of an in-memory membership check. At the
data sizes this library targets that is not a measured problem; if it
becomes one, the matcher and its corpus are in git history.

### 3. Fold packaging: nine packages to seven

Done. `driver-conformance` is the `@remelondb/core/conformance`
subpath; `server-conformance` is `@remelondb/server/conformance`. Both
are dev-facing: `vitest` is an optional peer dependency, needed only
when the subpath is imported. Publishing, README, and API-reference
surface shrink accordingly. Trivially reversible.

## Not cut

- **Sync**: client, engine, wire spec, Quint model, conformance. This
  is the reason the project exists.
- **Schema-inferred types and the Zod adapter**: the API the reference
  application is built on.
- **The web driver**, including multi-tab takeover (small, shipped,
  tested).
- **The full Q surface**, including `Q.on` joins, nested
  `Q.and`/`Q.or`, and the association graph. Queries as data is what
  provides observer table tracking, central tombstone filtering,
  derived count queries, typed column names, and enforced
  parameterization — and cross-table queries stay declarative and
  observable. Narrowing Q to a conjunctive core would push that work
  into every caller for a modest line-count gain.
- **The Model layer** (classes, `ModelFor`, accessors, associations).
  Removing it would be a real API decision: it touches `Collection`,
  `Database.open`, the docs, and every consumer. If plain records are
  wanted, that gets its own design doc and a migration plan for
  consumers.

## Sequencing

One cut per arc, in the order above, tests green after each. The
result ships as a minor release.

## Open questions

- Benchmark expo-sqlite vs. the C++ module, and what result would
  justify making the C++ package the recommended default again.
- Whether `driver-node`'s integration tests, which exercise core
  behavior rather than the driver, should move into core when the
  packaging folds.
