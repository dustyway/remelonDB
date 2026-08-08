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
import { RemelonSyncModule } from './module'

// The full backend contract, exercised through real HTTP: NestJS app,
// fetch as the client, MemoryStore underneath. What the suite passes
// in-process must survive the transport unchanged.
const Task = z.object({ name: z.string().min(1), done: z.boolean() })

const apps: INestApplication[] = []
afterAll(async () => {
  await Promise.all(apps.map((app) => app.close()))
})

const makeBase = async (
  extra: Partial<Parameters<typeof RemelonSyncModule.forRoot<string>>[0]> = {},
): Promise<string> => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      RemelonSyncModule.forRoot<string>({
        store: createMemoryStore(),
        tables: { tasks: Task },
        scopeFrom: (request) =>
          (request as { headers: Record<string, string | undefined> }).headers['x-scope'] ?? null,
        ...extra,
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
})

describe('per-table options', () => {
  it('passes appendOnly through to the engine behind /sync/push', async () => {
    const base = await makeBase({ tableOptions: { tasks: { appendOnly: true } } })
    const row = { id: 'append-1', name: 'a task', done: false }

    const pull = await call(base, '/sync/pull', 'scope-a', {
      cursor: null,
      schemaVersion: 1,
      migration: null,
    })
    expect(pull.status).toBe(200)
    const { cursor } = (await pull.json()) as { cursor: string }

    const first = await call(base, '/sync/push', 'scope-a', {
      cursor,
      changes: { tasks: { created: [row], updated: [], deleted: [] } },
    })
    expect(first.status).toBe(200)
    expect(((await first.json()) as { rejected?: unknown }).rejected).toBeUndefined()

    const repull = await call(base, '/sync/pull', 'scope-a', {
      cursor,
      schemaVersion: 1,
      migration: null,
    })
    const { cursor: fresh } = (await repull.json()) as { cursor: string }

    const second = await call(base, '/sync/push', 'scope-a', {
      cursor: fresh,
      changes: {
        tasks: { created: [], updated: [{ ...row, name: 'rewritten' }], deleted: [] },
      },
    })
    expect(second.status).toBe(200)
    const body = (await second.json()) as { rejected?: { tasks?: string[] } }
    expect(body.rejected?.tasks).toEqual(['append-1'])
  })
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
