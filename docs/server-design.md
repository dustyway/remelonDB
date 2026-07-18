# Server engine: the protocol above a storage seam

Status: implemented (packages/server). The server-side repetition of
the client's core move: a small storage interface (`SyncStore`, the
sibling of `SqliteDriver`), with every protocol semantic — cursor
encoding, conflict, per-record rejection, the interleave fast path and
its degrade rule — implemented once in the engine above it. A store
knows rows, revisions, and scopes; it knows nothing about cursors,
conflicts, or the wire.

## Division of obligations

The wire spec (sync-wire.md) binds the whole server; the seam splits
its obligations:

| Obligation | Owner |
| --- | --- |
| Consistent snapshot per operation | store (`transaction`) |
| Commit-ordered revisions | store: revisions assigned so that pushes for one scope commit in revision order (`transaction(scope, 'push', …)` MUST serialize per scope — the advisory-lock obligation) |
| Cursor encoding, opacity, floor checks | engine (revision-based reference mechanism) |
| Conflict detection and ordering vs rejection | engine (ownership rejections first — foreign revisions are incomparable to a scope's cursor — then whole-push conflict) |
| Per-record validation | engine, via per-table `validate` + optional `crossValidate` (referential checks) |
| Upsert discipline (never touch creation stamps, never resurrect tombstones), tombstoning, retention | store |
| Interleave computation, the both-or-neither package rule, mandatory degrade below the floor | engine |

`MemoryStore` ships as the executable illustration and test double;
adapters for real databases implement the same eight methods and
inherit the engine's conformance (the suite runs against
engine-over-memory in CI; run it against engine-over-your-store to
prove an adapter).

## What the seam is not

Not an ORM adapter: `changedSince` returns wire-ready rows (the store
owns column mapping), and the engine never constructs queries. Not a
transport: the engine produces `SyncHandlers` (`pull`/`push` as plain
async functions) that a route handler, an RPC layer, or a test calls
directly. Scope is a type parameter — a user id, a tenant key, whatever
partitions the data — the engine only threads it through.
