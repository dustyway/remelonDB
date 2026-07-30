/**
 * The SharedWorker owner (docs/multi-tab.md): one instance per origin,
 * every tab connects over its own port. It spawns the existing worker.ts
 * as a NESTED dedicated worker (OPFS sync-access handles are
 * dedicated-worker-only) and routes each tab's RPC to it.
 *
 * Responsibilities here, and nothing more (write arbitration and change
 * broadcast are later slices):
 * - id namespacing: every tab numbers its requests from 1, so ids are
 *   rewritten to router-unique ids on the way in and mapped back on the
 *   way out.
 * - refcounted opens: the first open of a name really opens; later opens
 *   join as holders and get the CURRENT user_version via a synthesized
 *   pragma query. close only reaches SQLite when the last holder leaves;
 *   destroy always forwards.
 *
 * Typed structurally instead of via lib "WebWorker" so the workspace can
 * typecheck without conflicting global libs (same approach as worker.ts).
 */
import type { WorkerRequest, WorkerResponse } from './protocol'

interface PortLike {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  start?(): void
}

interface Route {
  readonly port: PortLike
  readonly originalId: number
  /** Reshape the worker's result before answering (synthesized requests). */
  readonly transform?: (result: unknown) => unknown
}

const scope = globalThis as unknown as {
  addEventListener(
    type: 'connect',
    listener: (event: { ports: readonly PortLike[] }) => void,
  ): void
}

let sqliteWorker: Worker | null = null
let nextRouteId = 1
const routes = new Map<number, Route>()
const holders = new Map<string, Set<PortLike>>()

const worker = (): Worker => {
  if (!sqliteWorker) {
    sqliteWorker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
    })
    sqliteWorker.addEventListener('message', (event) => {
      const response = (event as { data: unknown }).data as WorkerResponse
      const route = routes.get(response.id)
      if (!route) {
        return
      }
      routes.delete(response.id)
      if (response.ok && route.transform) {
        route.port.postMessage({
          id: route.originalId,
          ok: true,
          result: route.transform(response.result),
        } satisfies WorkerResponse)
      } else {
        route.port.postMessage({ ...response, id: route.originalId })
      }
    })
  }
  return sqliteWorker
}

const forward = (
  port: PortLike,
  request: WorkerRequest,
  transform?: (result: unknown) => unknown,
): void => {
  const routeId = nextRouteId++
  const base = { port, originalId: request.id }
  routes.set(routeId, transform ? { ...base, transform } : base)
  worker().postMessage({ ...request, id: routeId })
}

const answer = (port: PortLike, id: number, result: unknown): void => {
  port.postMessage({ id, ok: true, result } satisfies WorkerResponse)
}

const handle = (port: PortLike, request: WorkerRequest): void => {
  switch (request.op) {
    case 'open': {
      const existing = holders.get(request.name)
      if (existing && existing.size > 0) {
        existing.add(port)
        // joiner: the connection is live — report its current version
        forward(
          port,
          {
            id: request.id,
            op: 'query',
            name: request.name,
            sql: 'pragma user_version',
            args: [],
          },
          (rows) => ({
            userVersion: Number(
              (rows as readonly { user_version?: unknown }[])[0]?.user_version ?? 0,
            ),
          }),
        )
        return
      }
      holders.set(request.name, new Set([port]))
      forward(port, request)
      return
    }
    case 'close': {
      const holding = holders.get(request.name)
      holding?.delete(port)
      if (holding && holding.size > 0) {
        answer(port, request.id, null) // others still hold it open
        return
      }
      holders.delete(request.name)
      forward(port, request)
      return
    }
    case 'destroy': {
      holders.delete(request.name)
      forward(port, request)
      return
    }
    default:
      forward(port, request)
  }
}

scope.addEventListener('connect', (event) => {
  const port = event.ports[0]
  if (!port) {
    return
  }
  port.addEventListener('message', (messageEvent) => {
    handle(port, messageEvent.data as WorkerRequest)
  })
  port.start?.()
})
