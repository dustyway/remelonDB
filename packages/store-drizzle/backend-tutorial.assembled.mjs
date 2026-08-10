// AUTO-ASSEMBLED from docs/backend-tutorial.md — do not edit
import { z } from 'file:///home/ps/Code/remelon/node_modules/.pnpm/zod@4.4.3/node_modules/zod/index.js'
import { syncSchemas } from 'file:///home/ps/Code/remelon/packages/core/dist/zod/index.mjs'
import { drizzle } from 'drizzle-orm/node-postgres'
import { bigint, boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { Pool } from 'pg'
import { createDrizzleStore } from 'file:///home/ps/Code/remelon/packages/store-drizzle/dist/index.mjs'
import { createSyncEngine } from 'file:///home/ps/Code/remelon/packages/server/dist/index.mjs'

const Task = z.object({ name: z.string().min(1), done: z.boolean() })
const wire = syncSchemas({ tasks: Task })

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

const engine = createSyncEngine({
  store,
  tables: {
    tasks: { validate: (row) => wire.rows.tasks.safeParse(row).success },
  },
})
const ada = engine.as('ada')
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
await ada.push({
  cursor: secondDevice.cursor,
  changes: { tasks: { created: [], updated: [], deleted: ['task-1'] } },
})

const afterDelete = await ada.pull({
  cursor: secondDevice.cursor,
  schemaVersion: 1,
  migration: null,
})
const grace = await engine.as('grace').pull({ cursor: null, schemaVersion: 1, migration: null })

// --- assertions (appended by scripts/check-backend-tutorial.mjs) ---
const assert = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg) }
assert(first.cursor === '0', 'empty pull cursor: ' + first.cursor)
assert(!('conflict' in pushed), 'push conflicted')
assert(pushed.cursor === '1', 'push cursor: ' + pushed.cursor)
const seen = secondDevice.changes.tasks.updated.map((row) => row.id)
assert(seen.length === 1 && seen[0] === 'task-1', 'second device saw: ' + seen)
assert(afterDelete.changes.tasks.deleted.includes('task-1'), 'tombstone not delivered')
const raw = await pool.query("select deleted_at, rev from tasks where id = 'task-1'")
assert(raw.rows[0].deleted_at !== null, 'row not tombstoned in postgres')
assert(Number(raw.rows[0].rev) > 1, 'tombstone rev not bumped')
const graceRows = [
  ...(grace.changes.tasks?.created ?? []),
  ...(grace.changes.tasks?.updated ?? []),
  ...(grace.changes.tasks?.deleted ?? []),
]
assert(graceRows.length === 0, 'scope leaked: ' + graceRows.length)
await pool.end()
globalThis.__backendTutorialPassed = { blocks: 7 }
