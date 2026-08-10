import 'reflect-metadata'
import type { AddressInfo } from 'node:net'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { z } from 'zod'
import { afterAll, describe, expect, it } from 'vitest'
import type { SyncPullArgs, SyncPushArgs } from '@remelondb/core'
import { createMemoryStore } from '@remelondb/server'
import { registerServerConformance } from '@remelondb/server/conformance'
import type { SyncHandlers } from '@remelondb/server/conformance'
import { RemelonSyncModule, syncEngineFromOptions } from './module'

// The full backend contract, exercised through real HTTP: NestJS app,
// fetch as the client, MemoryStore underneath. What the suite passes
// in-process must survive the transport unchanged.
const Task = z.object({ name: z.string().min(1), done: z.boolean() })
const Event = z.object({ note: z.string() })

const apps: INestApplication[] = []
afterAll(async () => {
  await Promise.all(apps.map((app) => app.close()))
})

const makeBase = async (): Promise<string> => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      RemelonSyncModule.forRoot<string>({
        store: createMemoryStore(),
        tables: { tasks: Task, events: Event },
        tableOptions: { events: { appendOnly: true } },
        scopeFrom: (request) =>
          (request as { headers: Record<string, string | undefined> }).headers['x-scope'] ?? null,
      }),
    ],
  }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  await app.listen(0)
  apps.push(app)
  const { port } = app.getHttpServer().address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

const call = async (
  base: string,
  path: string,
  scope: string | null,
  body: unknown,
): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(scope === null ? {} : { 'x-scope': scope }),
    },
    body: JSON.stringify(body),
  })

const overHttp = (base: string, scope: string): SyncHandlers => ({
  pull: async (args: SyncPullArgs) => {
    const response = await call(base, '/sync/pull', scope, args)
    expect(response.status).toBe(200)
    return response.json()
  },
  push: async (args: SyncPushArgs) => {
    const response = await call(base, '/sync/push', scope, args)
    expect(response.status).toBe(200)
    return response.json()
  },
})

let counter = 0
const newId = (): string => `row-${++counter}`

registerServerConformance({
  name: 'engine over HTTP (RemelonSyncModule + MemoryStore)',
  makeContext: async () => {
    const base = await makeBase()
    return { handlers: overHttp(base, 'scope-a'), secondUser: overHttp(base, 'scope-b') }
  },
  fixtures: {
    tasks: {
      validRow: () => ({ id: newId(), name: 'a task', done: false }),
      mutate: (row) => ({ ...row, name: `${String(row['name'])} (edited)` }),
      invalidRow: () => ({ id: newId(), name: '', done: false }),
    },
  },
  // the module builds its own engine: case 13 proves tableOptions
  // actually reaches it, over real HTTP
  appendOnly: {
    table: 'events',
    fixture: {
      validRow: () => ({ id: newId(), note: 'happened' }),
      mutate: (row) => ({ ...row, note: 'rewritten' }),
    },
  },
})

describe('http binding', () => {
  const pullArgs = { cursor: null, schemaVersion: 1, migration: null }

  it('answers 401 without an authenticated scope', async () => {
    const base = await makeBase()
    expect((await call(base, '/sync/pull', null, pullArgs)).status).toBe(401)
    expect((await call(base, '/sync/push', null, {})).status).toBe(401)
  })

  it('answers 400 for malformed requests', async () => {
    const base = await makeBase()
    expect((await call(base, '/sync/pull', 'scope-a', {})).status).toBe(400)
    expect((await call(base, '/sync/push', 'scope-a', { nonsense: true })).status).toBe(400)
    // an unusable id fails the wire row schema before it can reach the
    // engine's SyncProtocolError path: still a 400, one layer earlier
    const unusable = {
      cursor: '0',
      changes: { tasks: { created: [{ id: '', name: 'x', done: false }], updated: [], deleted: [] } },
    }
    expect((await call(base, '/sync/push', 'scope-a', unusable)).status).toBe(400)
  })
})

// #11: one configuration, two consumers — the Nest module and a
// directly constructed engine must behave identically, so tests and
// scripts stop re-declaring tables/validation/policies.
describe('shared engine configuration', () => {
  const shared = {
    store: createMemoryStore(),
    tables: { tasks: Task, events: Event },
    tableOptions: { events: { appendOnly: true } },
  }

  it('direct engine and module enforce the same validation and policies', async () => {
    const direct = syncEngineFromOptions<string>(shared).as('scope-a')

    const moduleRef = await Test.createTestingModule({
      imports: [
        RemelonSyncModule.forRoot<string>({
          ...shared,
          store: createMemoryStore(), // separate data, same rules
          scopeFrom: (request) =>
            (request as { headers: Record<string, string | undefined> })
              .headers['x-scope'] ?? null,
        }),
      ],
    }).compile()
    const app = moduleRef.createNestApplication({ logger: false })
    await app.listen(0)
    apps.push(app)
    const { port } = app.getHttpServer().address() as AddressInfo
    const viaHttp = overHttp(`http://127.0.0.1:${port}`, 'scope-a')

    for (const handlers of [direct, viaHttp]) {
      const start = await handlers.pull({
        cursor: null,
        schemaVersion: 1,
        migration: null,
      })
      if (!('cursor' in start)) throw new Error('unexpected resync')

      // zod validation from `tables` rejects by id in both paths
      const invalid = await handlers.push({
        changes: {
          tasks: {
            created: [{ id: 'bad', name: '', done: false }],
            updated: [],
            deleted: [],
          },
        },
        cursor: start.cursor,
      })
      expect(
        (invalid as { rejected?: Record<string, readonly string[]> }).rejected
          ?.tasks,
      ).toEqual(['bad'])

      // appendOnly from `tableOptions` blocks overwrites in both paths
      await handlers.push({
        changes: {
          events: { created: [{ id: 'e1', note: 'v1' }], updated: [], deleted: [] },
        },
        cursor: start.cursor,
      })
      const seeded = await handlers.pull({
        cursor: start.cursor,
        schemaVersion: 1,
        migration: null,
      })
      if (!('cursor' in seeded)) throw new Error('unexpected resync')
      const overwrite = await handlers.push({
        changes: {
          events: { created: [], updated: [{ id: 'e1', note: 'v2' }], deleted: [] },
        },
        cursor: seeded.cursor,
      })
      expect(
        (overwrite as { rejected?: Record<string, readonly string[]> }).rejected
          ?.events,
      ).toEqual(['e1'])
    }
  })
})
