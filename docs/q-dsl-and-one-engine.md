# Why the Q DSL is great, and why one database engine is the right architectural choice

## A query is data, not code

The core idea of WatermelonDB's `Q` DSL is that `Q.where('likes', Q.gt(10))` doesn't execute anything; it builds a plain, serializable description of intent (a `QueryDescription` tree). That one design decision pays off four ways:

1. **Engine independence**: the same query can be compiled to any backend (SQL on device, SQLite-WASM on web, `better-sqlite3` in Node tests). The engine underneath becomes an implementation detail that can be swapped as the React Native ecosystem shifts — the failure mode that killed upstream WatermelonDB's native layer.
2. **Serializability**: a query can cross process boundaries (JSI, web workers) untouched and be compiled on the other side.
3. **Introspectability**: the library can inspect a query (which tables does it touch? can it be re-checked in memory without hitting the database?) to power reactive observation.
4. **Safety by construction**: every value flows through one sanitizing encoder, eliminating SQL injection (the `Q.unsafeSql*` escape hatches are named accordingly).

The result is a stable, typed, engine-neutral query API for applications.

## One engine: SQLite everywhere

**Query semantics are the product.** What a query *means* is defined by hundreds of small engine rules: `LIKE` is case-insensitive, `NULL > 3` matches nothing, binary collation orders `Z` before `a`. No two engines agree on all of them.

Run SQLite on device but a JS/IndexedDB engine on web, and the same code with the same data returns different rows on different platforms: silent wrong answers that no error ever surfaces, and that sync then faithfully propagates. Avoiding that means hand-replicating SQLite's rules in a second engine and re-proving equivalence for every operator, optimization, and bug fix, forever. That permanent tax is what upstream paid for its LokiJS web adapter, the half of the project even its maintainer didn't trust.

With one engine:

- the Q-to-SQL compiler is written **once** (a single pure function);
- semantics are **inherited** from twenty years of battle-tested SQLite rather than reinvented;
- performance lives in C (indexes, query planner, `COUNT`) rather than in JS scans and joins;
- a single Node-based conformance suite genuinely proves the behavior every user sees on every platform.

The DSL provides the portability; the single engine provides the truth. Each makes the other's promise real.

## No in-memory exception

Upstream WatermelonDB keeps a tiny in-memory matcher so observers of *simple* queries can be updated without re-querying the database — a second engine that must replicate SQLite semantics exactly (null handling, storage-class ordering, ASCII-only LIKE folding) and be conformance-tested against it. remelonDB has no such shortcut: observers re-query SQLite on relevant change, so "one engine" holds without exception and the matcher/SQL agreement obligation does not exist. The distinctive semantics that agreement suite pinned live on as plain SQL cases in the driver conformance corpus.
