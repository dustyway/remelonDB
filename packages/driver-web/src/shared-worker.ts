/**
 * The SharedWorker broker (docs/multi-tab.md): one instance per origin,
 * every tab connects over its own port. Chromium and WebKit expose no
 * `Worker` constructor in SharedWorkerGlobalScope, so the broker cannot
 * spawn SQLite itself — it asks a connected tab to spawn worker.ts and
 * hand back a MessagePort (the tab bridges one MessageChannel between
 * us and the spawned worker). The broker then talks to SQLite directly.
 *
 * The broker owns coordination state, nothing else:
 * - id namespacing: every tab numbers its requests from 1, so ids are
 *   rewritten to broker-unique ids inbound and mapped back outbound.
 * - refcounted opens: the first open of a name really opens; later
 *   opens join as holders and get the CURRENT user_version via a
 *   synthesized pragma query. close reaches SQLite only when the last
 *   holder leaves; destroy always forwards.
 * - compute liveness: the host tab dying kills the compute worker but
 *   never the broker. Each new tab connection probes the compute
 *   channel with a ping; no answer within the deadline resets the
 *   epoch (pending requests fail loudly, holders clear) and the next
 *   request triggers a respawn via whichever tab sent it.
 *
 * Typed structurally instead of via lib "WebWorker" so the workspace
 * can typecheck without conflicting global libs (same as worker.ts).
 */
import type { WorkerRequest, WorkerResponse } from './protocol'

const PING_DEADLINE_MS = 1000

interface PortLike {
  postMessage(message: unknown, transfer?: readonly unknown[]): void
  addEventListener(
    type: 'message',
    listener: (event: { data: unknown; ports?: readonly PortLike[] }) => void,
  ): void
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

let computePort: PortLike | null = null
let spawnRequested = false
let nextRouteId = 1
const routes = new Map<number, Route>()
const holders = new Map<string, Set<PortLike>>()
const backlog: Array<{
  port: PortLike
  request: WorkerRequest
  transform?: (result: unknown) => unknown
}> = []

/** The compute channel is gone: fail everything pending, start over. */
const resetEpoch = (reason: string): void => {
  computePort = null
  spawnRequested = false
  for (const route of routes.values()) {
    route.port.postMessage({
      id: route.originalId,
      ok: false,
      error: `WebSqliteDriver: ${reason}`,
    } satisfies WorkerResponse)
  }
  routes.clear()
  holders.clear()
}

const adoptComputePort = (port: PortLike): void => {
  computePort = port
  spawnRequested = false
  port.addEventListener('message', (event) => {
    const response = event.data as WorkerResponse
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
  port.start?.()
  const queued = backlog.splice(0)
  for (const item of queued) {
    // replay the SEND, not the routing decision — holder bookkeeping
    // already happened when the request was first handled
    send(item.port, item.request, item.transform)
  }
}

/** Post to the compute channel (requires computePort to be live). */
const send = (
  port: PortLike,
  request: WorkerRequest,
  transform?: (result: unknown) => unknown,
): void => {
  const routeId = nextRouteId++
  const base = { port, originalId: request.id }
  routes.set(routeId, transform ? { ...base, transform } : base)
  computePort!.postMessage({ ...request, id: routeId })
}

const forward = (
  port: PortLike,
  request: WorkerRequest,
  transform?: (result: unknown) => unknown,
): void => {
  if (!computePort) {
    const entry = { port, request }
    backlog.push(transform ? { ...entry, transform } : entry)
    if (!spawnRequested) {
      spawnRequested = true
      port.postMessage({ control: 'spawnWorker' })
    }
    return
  }
  send(port, request, transform)
}

const answer = (port: PortLike, id: number, result: unknown): void => {
  port.postMessage({ id, ok: true, result } satisfies WorkerResponse)
}

/**
 * Write-block arbitration (docs/multi-tab.md): a plain token queue. An
 * exclusive slot (a db.write block) is granted only when nothing is
 * held; shared slots (db.read windows) coexist with each other. Strict
 * FIFO — a waiting writer blocks later readers, so writers can't starve.
 */
interface SlotWaiter {
  readonly port: PortLike
  readonly requestId: number
  readonly exclusive: boolean
}

let nextSlot = 1
const heldSlots = new Map<number, { exclusive: boolean }>()
const slotQueue: SlotWaiter[] = []

const heldExclusive = (): boolean =>
  [...heldSlots.values()].some((slot) => slot.exclusive)

const grantSlots = (): void => {
  while (slotQueue.length > 0) {
    const head = slotQueue[0]!
    const canGrant = head.exclusive
      ? heldSlots.size === 0
      : !heldExclusive()
    if (!canGrant) {
      return
    }
    slotQueue.shift()
    const slot = nextSlot++
    heldSlots.set(slot, { exclusive: head.exclusive })
    answer(head.port, head.requestId, { slot })
    if (head.exclusive) {
      return // exclusive holder: nothing else runs until release
    }
  }
}

const handle = (port: PortLike, request: WorkerRequest): void => {
  switch (request.op) {
    case 'acquireSlot': {
      slotQueue.push({ port, requestId: request.id, exclusive: request.exclusive })
      grantSlots()
      return
    }
    case 'releaseSlot': {
      heldSlots.delete(request.slot)
      answer(port, request.id, null)
      grantSlots()
      return
    }
    case 'open': {
      const existing = holders.get(request.name)
      if (existing && existing.size > 0 && computePort) {
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
      const set = holders.get(request.name) ?? new Set<PortLike>()
      set.add(port)
      holders.set(request.name, set)
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

/** Probe the compute channel; reset the epoch when it stopped answering. */
const probeCompute = (): void => {
  const target = computePort
  if (!target) {
    return
  }
  const routeId = nextRouteId++
  let answered = false
  routes.set(routeId, {
    // a self-addressed route: mark answered, deliver to nobody
    port: {
      postMessage: () => {
        answered = true
      },
      addEventListener: () => {},
    },
    originalId: -1,
  })
  target.postMessage({ id: routeId, op: 'ping' } satisfies WorkerRequest)
  setTimeout(() => {
    routes.delete(routeId)
    if (!answered && computePort === target) {
      resetEpoch('the database worker went away (its host tab closed?) — retry')
    }
  }, PING_DEADLINE_MS)
}

scope.addEventListener('connect', (event) => {
  const port = event.ports[0]
  if (!port) {
    return
  }
  port.addEventListener('message', (messageEvent) => {
    const data = messageEvent.data as { control?: string } | null
    if (data?.control === 'adoptWorkerPort') {
      const transferred = messageEvent.ports?.[0]
      if (transferred) {
        adoptComputePort(transferred)
      }
      return
    }
    handle(port, messageEvent.data as WorkerRequest)
  })
  port.start?.()
  probeCompute()
})
