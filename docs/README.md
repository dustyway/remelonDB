# Documentation index

New here? Start with the **[tutorial](tutorial.md)**: it builds a
flashcard app's data layer end to end (schema, models, queries, live
observation, a migration, and sync).

Two kinds of documents live here. **Design decisions** record *why* the
project is shaped the way it is; they are written once and amended, not
rewritten. **Reference guides** describe *what exists and how to use it*;
they track the code and are updated with it.

## Design decisions

| Doc | Decision |
| --- | --- |
| [q-dsl-and-one-engine.md](q-dsl-and-one-engine.md) | Queries are serializable data; SQLite is the single query engine on every platform. The in-memory matcher is the one bounded exception and must be conformance-tested against SQLite. |
| [architecture-layers.md](architecture-layers.md) | The portability seam is a ~7-method `SqliteDriver` (dumb SQL executor), not an ORM-flavored adapter. Async at the seam. Record caching owned by JS only. Tombstones/local storage are core features, not driver methods. RN driver is a C++ TurboModule. |
| [sync-design.md](sync-design.md) | Generic reimplementation of WatermelonDB's sync protocol with two contract-level fixes: an opaque commit-ordered cursor (kills the lost-write race) and push-responds-like-a-pull (kills the push echo). |
| [sync-wire.md](sync-wire.md) | The normative wire contract: exact JSON shapes, backend obligations as testable MUSTs, client guarantees, canonical HTTP binding, and a conformance checklist for server implementations. |
| [sync_model.qnt](sync_model.qnt) | Formal Quint model of the protocol, run in CI (25k traces). Proves the push fast path safe with the interleave attached and the GC-floor degrade obligation it discovered; flipping PUSH_MODE to "naive" reproduces the lost-write race. |
| [server-design.md](server-design.md) | Implemented (packages/server): the wire protocol once, above a SyncStore seam (the server-side sibling of SqliteDriver). Obligations split engine/store; adapters prove themselves via packages/server-conformance. |
| [upstream-study.md](upstream-study.md) | Condensed factual findings from reading upstream WatermelonDB: what to keep, what's broken, with file/line receipts. Basis for the other docs. |
| [schema-inferred-types.md](schema-inferred-types.md) | Implemented: record types, collection types, and Q column checking all derive from the schema literal (Drizzle-style single source of truth). Surface change only; the query AST and runtime stay. |
| [zod-adapter.md](zod-adapter.md) | Implemented (packages/zod): @remelondb/zod — derive client tables from shared Zod schemas (zodTable) and validate both sync directions with wire schemas built from the same objects. No core changes; validation lands at the trust boundaries. |

## Reference guides

| Doc | Covers |
| --- | --- |
| [reference/database.md](reference/database.md) | `Database.open`, the writer queue, CRUD, the batch contract, both observation strategies, change buses, local storage. |
| [reference/models.md](reference/models.md) | The Model layer: declare-field accessors (no decorators), update builders, identity, relations, per-record observation. |
| [reference/queries.md](reference/queries.md) | The Q DSL: every operator with its SQL and semantics, joins, LIKE escaping, unsafe escape hatches, compilation, the in-memory matcher and its gate. |
| [reference/sync.md](reference/sync.md) | Using `synchronize`: wire shapes, conflict semantics, resync, migration pulls, testing a backend. |
| [reference/schema.md](reference/schema.md) | `appSchema`/`table()`/column builders, inferred record types, standard columns, reserved names, DDL output, migrations and the no-silent-reset contract. |
| [reference/records.md](reference/records.md) | `RawRecord`, the `sanitizedRaw` trust boundary and its coercion rules, sync fields (`_status`/`_changed`), ids. |
| [reference/driver.md](reference/driver.md) | The `SqliteDriver` contract: method obligations, value conventions, batch atomicity, why the seam is async, how to implement and conformance-test a new driver. |

## Conventions used across the codebase

- **Booleans are stored as 0/1** in SQLite and are real `true`/`false` on the
  JS side; the conversion happens at the driver seam (write) and in
  `sanitizedRaw` (read).
- **Identifiers** (table/column names) must match `^[a-zA-Z_][a-zA-Z0-9_]*$`
  and are validated at construction; **values** always cross the seam as `?`
  placeholders. Nothing user-controlled is ever interpolated into SQL text.
- **Deleted records** (`_status = 'deleted'`) are tombstones kept for sync.
  Both query paths hide them by default (`filterDeleted` flag on
  `encodeQuery` and `encodeMatcher`).
- APIs prefixed **`unsafe`** bypass a guarantee the rest of the system
  maintains (usually: SQL injection safety or engine-portability). They exist
  as escape hatches, not conveniences.
