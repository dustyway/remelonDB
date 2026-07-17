# Records reference

A **RawRecord** is the plain-object representation of a row on the JS side.
It is a dumb data bag — no class, no methods — and it is *valid by
construction*, because everything that becomes a record passes through one
trust boundary: `sanitizedRaw`.

```ts
interface RawRecord {
  id: string
  _status: 'synced' | 'created' | 'updated' | 'deleted'
  _changed: string           // comma-separated dirty column names
  [column: string]: SqlValue // every schema column, type-correct
}
```

## The trust boundary: `sanitizedRaw(dirty, table)`

The second argument is a `TableSchema` — the object `table()` returns.

Input is an untrusted `DirtyRaw` — an adapter row, a sync payload, user
data. Output is a RawRecord where:

| Field | Rule |
| --- | --- |
| `id` | kept if a non-empty string; otherwise a generated 16-char `[a-z0-9]` id (`randomId()`, upstream-compatible format) |
| `_status` | kept if a valid status; otherwise `'created'` |
| `_changed` | kept if a string; otherwise `''` |
| schema columns | present **always**, coerced per the table below |
| anything else | **dropped** — unknown keys never survive sanitization |

Coercion per declared column type — invalid or missing values become the
type's default (`nullValue`), which is `null` for optional columns:

| Type | Valid input | Invalid/missing becomes |
| --- | --- | --- |
| `string` | `string` | `''` (or `null` if optional) |
| `number` | finite `number` | `0` (or `null`) — `NaN`/`Infinity` are invalid |
| `boolean` | `boolean`, or `1`/`0` (converted to `true`/`false`) | `false` (or `null`) |

Note the deliberate asymmetries: numbers are **not** parsed from strings,
booleans are **not** derived from truthiness — only the exact storage
representations `1`/`0` convert. Coercion here means "replace garbage with a
safe default", never "guess what was meant".

`nullValue(column)` is exported and intentionally identical to the DDL
backfill defaults used by `addColumns` migrations — a migrated column and a
sanitized field always agree.

## The boolean convention

Booleans are real `true`/`false` on the JS side and `0`/`1` in SQLite:

- **write**: drivers convert boolean bind args to `0`/`1` (better-sqlite3
  would reject raw booleans anyway; the convention is seam-wide).
- **read**: rows come back with `0`/`1`; `sanitizedRaw` restores booleans
  for `boolean`-typed columns.
- **compare**: the query compiler binds booleans as-is (driver converts);
  the in-memory matcher normalizes both sides to `0`/`1`.

The round-trip identity — `sanitizedRaw(read(write(raw))) === raw` — is
pinned by `rawRecordConformance.test.ts`.

## Single-column writes

`setRawSanitized(raw, value, columnSchema)` sanitizes one value into an
existing raw — the primitive the future Model layer's `update` path builds
on. Same coercion table as above.

## Sync fields (`_status`, `_changed`)

The dirty-tracking design (inherited from upstream, kept in the
[sync design](../sync-design.md)):

- A freshly created record is `_status: 'created'`, `_changed: ''` — the
  whole record is new, so no per-column tracking is needed.
- Updating a synced record sets `_status: 'updated'` and appends each
  modified column name to `_changed` — this powers per-column conflict
  resolution during sync (local wins for columns in `_changed`, server wins
  elsewhere).
- Deleting locally sets `_status: 'deleted'` but keeps the row as a
  **tombstone** so sync can push the deletion; queries hide tombstones by
  default (`filterDeleted`). Permanent destruction happens after a
  successful push (or for records that were never synced).
- `_status`/`_changed` never cross the sync wire in either direction — they
  are local bookkeeping (a protocol rule; see sync-design.md).

These transitions are maintained by `Collection.prepareUpdate`
(`markAsChanged`) and the tombstone/destroy operations
([database.md](database.md)); the sync engine consumes and resets them
([sync.md](sync.md)).

## Ids

`randomId()` generates 16 lowercase alphanumeric characters via
`crypto.getRandomValues` (Math.random fallback for exotic environments) —
format-compatible with upstream WatermelonDB ids. Caller-provided ids are
accepted as-is by `sanitizedRaw` (any non-empty string); id *format* is not
validated because ids only ever travel as bound parameters, never as SQL
text.
