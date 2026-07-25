# The backend tutorial: syncing into Postgres

The [tutorial](tutorial.md) ends with a client syncing against the
in-memory reference store. This walkthrough builds the real thing: the
same sync engine over Postgres, ready to mount in a server. Everything
here runs as written — CI executes these blocks against a real
Postgres — and one docker command gives you the same locally.

The layers, bottom to top: a Postgres **store**
(`@remelondb/store-drizzle`), the protocol **engine**
(`@remelondb/server`), and a **transport** for your framework —
[reference/backend.md](reference/backend.md) is the reference companion
to this walkthrough.

```sh
pnpm add @remelondb/server @remelondb/store-drizzle drizzle-orm pg zod
docker run -d -p 5433:5432 -e POSTGRES_PASSWORD=pg postgres:18-alpine
```

## The shared schema

One Zod object per table, declared once where both client and server can
import it. The client derives its device schema from it (`zodTable`);
the server derives its validators:

```js
import { z } from 'zod'
import { syncSchemas } from '@remelondb/core/zod'

const Task = z.object({ name: z.string().min(1), done: z.boolean() })
const wire = syncSchemas({ tasks: Task })
```

## The table

A synced table is the Zod object's keys as columns — names matching, so
no mapping code — plus four machinery columns: a client-minted `text` id
(never a server default), a `bigint` revision, a nullable `deleted_at`
tombstone marker, and an owner column carrying the sync scope. Two
bookkeeping objects ride along in the same migration. The connection
string comes from the environment in production; the fallback matches
the docker command above, and the drops make the walkthrough rerunnable:

```js
import { drizzle } from 'drizzle-orm/node-postgres'
import { bigint, boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { Pool } from 'pg'

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://postgres:pg@localhost:5433/postgres',
})
await pool.query(`
  drop table if exists tasks;
  drop table if exists remelon_sync_meta;
  drop sequence if exists remelon_rev;
  create sequence remelon_rev;
  create table remelon_sync_meta (key text primary key, value bigint not null);
  create table tasks (
    id text primary key,
    rev bigint not null,
    deleted_at timestamptz,
    owner text not null,
    name text not null,
    done boolean not null
  );
  create index tasks_owner_rev_idx on tasks (owner, rev);
`)
const db = drizzle(pool)

const tasks = pgTable('tasks', {
  id: text('id').primaryKey(),
  rev: bigint('rev', { mode: 'number' }).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  owner: text('owner').notNull(),
  name: text('name').notNull(),
  done: boolean('done').notNull(),
})
```

## The store

Point the store at the machinery columns and every storage method is
generated:

```js
import { createDrizzleStore } from '@remelondb/store-drizzle'

const store = createDrizzleStore({
  db,
  tables: {
    tasks: {
      table: tasks,
      id: tasks.id,
      rev: tasks.rev,
      deletedAt: tasks.deletedAt,
      scope: tasks.owner,
    },
  },
})
```

## The engine

The engine owns every protocol semantic; the store only knows rows and
revisions. Per-record validation uses the wire schema derived from the
same `Task` object:

```js
import { createSyncEngine } from '@remelondb/server'

const engine = createSyncEngine({
  store,
  tables: {
    tasks: { validate: (row) => wire.rows.tasks.safeParse(row).success },
  },
})
const ada = engine.as('ada')
```

`engine.as(scope)` binds the handlers to one authenticated principal —
in a server, the user id your auth layer extracts per request.

## A sync round trip

What a device does: pull (empty, cursor `"0"`), push a record, and a
second device's fresh pull sees it — out of Postgres this time:

```js
const first = await ada.pull({ cursor: null, schemaVersion: 1, migration: null })

const pushed = await ada.push({
  cursor: first.cursor,
  changes: {
    tasks: {
      created: [{ id: 'task-1', name: 'water the plants', done: false }],
      updated: [],
      deleted: [],
    },
  },
})

const secondDevice = await ada.pull({ cursor: null, schemaVersion: 1, migration: null })
```

## Deletion travels as a tombstone

A delete is a write, not a removal — the row stays, marked dead under a
fresh revision, so any device can still learn about it
([sync-basics](sync-basics.md) has the why):

```js
await ada.push({
  cursor: secondDevice.cursor,
  changes: { tasks: { created: [], updated: [], deleted: ['task-1'] } },
})

const afterDelete = await ada.pull({
  cursor: secondDevice.cursor,
  schemaVersion: 1,
  migration: null,
})
```

`afterDelete.changes.tasks.deleted` names `task-1`; in the table the row
now has `deleted_at` set and a bumped `rev`.

## Scopes never leak

Another principal pulling the same server sees nothing:

```js
const grace = await engine.as('grace').pull({ cursor: null, schemaVersion: 1, migration: null })
```

## Mounting it in a server

With NestJS, `@remelondb/nestjs` turns the pieces above into
`POST /sync/pull` and `POST /sync/push` — hand it the store and the same
Zod objects, and put your session lookup in `scopeFrom`:

```js fragment
RemelonSyncModule.forRootAsync({
  imports: [DbModule],
  inject: [DRIZZLE],
  useFactory: (db) => ({
    store: createDrizzleStore({ db, tables: { /* as above */ } }),
    tables: { tasks: Task },
    scopeFrom: async (request) => {
      const session = await auth.api.getSession({ headers: request.headers })
      return session?.user.id ?? null
    },
  }),
})
```

Without NestJS the handlers bind to any HTTP server in a few lines — the
[example server](../examples/todo-sync/backend/server.ts) is the whole
thing. Either way the wire behavior is fixed by
[sync-wire.md](sync-wire.md): protocol outcomes are HTTP 200, malformed
requests 400, unauthenticated ones 401.

## Where next

- [reference/backend.md](reference/backend.md) — the reference version
  of everything here, plus retention (`gc`, `scrub`) and derived scopes.
- `registerServerConformance` from `@remelondb/server/conformance` —
  run the wire spec's checklist against your mounted endpoints.
- [sync-tour.md](sync-tour.md) — the wire protocol itself, one request
  at a time.
