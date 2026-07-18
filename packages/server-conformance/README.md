# @remelondb/server-conformance

The executable backend contract for
[remelonDB](https://github.com/dustyway/remelonDB)'s sync protocol: the
[wire spec](../../docs/sync-wire.md)'s conformance checklist as a
runnable vitest suite, plus an in-memory reference server that passes
it.

Handlers are plain async functions, so the same ten scenarios run
against an in-process app, an HTTP endpoint behind a small fetch
wrapper, or the reference server. If your backend passes, remelonDB's
`synchronize()` works against it — including the subtle obligations
(commit-ordered cursors, the cursor+interleave package rule, per-record
rejection, `resyncRequired`).

## Usage

```ts
// in a vitest file
import { registerServerConformance } from '@remelondb/server-conformance'

registerServerConformance({
  name: 'my backend',
  makeContext: async () => ({
    handlers: myUserHandlers,      // { pull(args), push(args) }
    secondUser: otherUserHandlers, // optional: enables the scoping scenario
    concurrently: myInterleaver,   // optional: enables the commit-during-pull scenario
  }),
  fixtures: {
    tasks: {
      validRow: () => ({ id: newId(), name: 'a', done: false }),
      mutate: (row) => ({ ...row, name: 'changed' }),
      invalidRow: () => ({ id: newId(), name: '', done: false }), // optional
    },
  },
})
```

`makeContext` runs per scenario and must return a clean, authenticated
context. Scenarios whose optional inputs are missing are *reported as
skipped*, never silently dropped — a green run tells you exactly what
was covered.

## The reference server

```ts
import { createReferenceServer } from '@remelondb/server-conformance'

const server = createReferenceServer({
  validate: { tasks: (row) => row.name !== '' },
})
const alice = server.as('alice') // { pull, push }
server.gc(10) // prune tombstones, raise the resync floor
```

An in-memory implementation of every backend obligation — revision
cursor, tombstones with a GC floor, whole-push conflict, per-record
rejection, the push fast path with mandatory degrade below the floor.
Useful as a test double for client code and as the executable
illustration of the spec; not a persistence layer.

## License

[MIT](https://github.com/dustyway/remelonDB/blob/main/LICENSE)
