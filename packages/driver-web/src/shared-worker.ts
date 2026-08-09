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
  /** The as-sent request, so an epoch reset can replay instead of fail. */
  readonly request: WorkerRequest
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
/** False while a fresh compute is re-opening held databases. */
let computeReady = false
/** Held databases to restore on the next adopt (set by resetEpoch). */
let namesToRestore: string[] = []
let lastResponseAt = 0
let watchdogTimer: ReturnType<typeof setTimeout> | null = null

/**
 * New connections probe the compute channel, but a lone surviving tab
 * gets no new connection: without this, its requests to a dead compute
 * would hang forever. Any send with no response for a while triggers
 * the same probe (which epoch-resets, respawns and replays on silence).
 */
const scheduleWatchdog = (): void => {
  if (watchdogTimer !== null) {
    return
  }
  watchdogTimer = setTimeout(() => {
    watchdogTimer = null
    if (!computePort || routes.size === 0) {
      return
    }
    if (Date.now() - lastResponseAt >= 2000) {
      probeCompute()
    }
    scheduleWatchdog()
  }, 2500)
}
let spawnRequested = false
let hostedWorker: { terminate(): void } | null = null

/**
 * Firefox exposes the Worker constructor in SharedWorkerGlobalScope
 * (Chromium and WebKit do not — the reason for the tab-hosted design).
 * Where it exists, host the compute worker HERE: it then survives every
 * tab navigation, so its OPFS handles never orphan (remelonDB#4 — on
 * Firefox a dead page-worker's handles are never released within the
 * session, so the tab-hosted design breaks on any full page load).
 */
declare const Worker:
  | (new (
      url: URL,
      options?: { type: string },
    ) => PortLike & {
      terminate(): void
      addEventListener(type: 'error', listener: () => void): void
    })
  | undefined

const spawnComputeHere = (): boolean => {
  if (typeof Worker !== 'function') {
    return false
  }
  try {
    // the literal `new Worker(new URL(...))` shape is load-bearing:
    // bundlers statically rewrite exactly this pattern to the built
    // chunk URL — an aliased constructor ships the raw specifier and
    // 404s in production
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
    })
    worker.addEventListener('error', () => {
      // the hosted worker failed to load or crashed on startup: fall
      // back to tab-hosted compute instead of hanging every request
      if (hostedWorker === worker) {
        hostedWorker = null
        computePort = null
        spawnRequested = false
        worker.terminate()
        const asker = backlog[0]?.port
        if (asker) {
          spawnRequested = true
          asker.postMessage({ control: 'spawnWorker' })
        }
      }
    })
    hostedWorker = worker
    adoptComputePort(worker)
    return true
  } catch {
    hostedWorker = null
    return false
  }
}
let nextRouteId = 1
const routes = new Map<number, Route>()
const holders = new Map<string, Set<PortLike>>()
const syncLeases = new Map<string, { port: PortLike; expiresAt: number }>()
const backlog: Array<{
  port: PortLike
  request: WorkerRequest
  transform?: (result: unknown) => unknown
}> = []

/**
 * The compute channel is gone. Instead of failing everything pending
 * (remelonDB#3: a fresh tab used to see "worker went away" because an
 * unrelated tab closed), requeue the pending requests and respawn —
 * self-hosted where possible, else via the first pending tab. Only when
 * no respawn path exists does the failure surface.
 */
const resetEpoch = (reason: string): void => {
  hostedWorker?.terminate()
  hostedWorker = null
  computePort = null
  computeReady = false
  spawnRequested = false
  const pending = [...routes.values()]
  routes.clear()
  // holders are NOT cleared: they are exactly the state a fresh compute
  // must restore, so surviving tabs keep working (their queries would
  // otherwise hit a blank worker as "database is not open"). Names
  // whose own open is among the replayed requests are excluded — the
  // replay opens those itself.
  const replayedOpens = new Set(
    pending
      .concat(backlog.map((item) => ({ request: item.request })) as never[])
      .filter((route) => (route as { request: WorkerRequest }).request.op === 'open')
      .map((route) => ((route as { request: WorkerRequest }).request as { name: string }).name),
  )
  namesToRestore = [...holders.keys()].filter((name) => !replayedOpens.has(name))
  if (pending.length > 0) {
    for (const route of pending) {
      backlog.push(
        route.transform
          ? { port: route.port, request: route.request, transform: route.transform }
          : { port: route.port, request: route.request },
      )
    }
    spawnRequested = true
    if (!spawnComputeHere()) {
      const asker = pending[0]!.port
      let asked = false
      try {
        asker.postMessage({ control: 'spawnWorker' })
        asked = true
      } catch {
        asked = false
      }
      if (!asked) {
        spawnRequested = false
        for (const item of backlog.splice(0)) {
          item.port.postMessage({
            id: item.request.id,
            ok: false,
            error: `WebSqliteDriver: ${reason}`,
          } satisfies WorkerResponse)
        }
      }
    }
  }
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
    lastResponseAt = Date.now()
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
    // A self-hosted compute worker holds the SAH pool for the broker's
    // lifetime, which outlives every tab. Release it when nothing is
    // open and nothing is pending; the next open spawns a fresh one.
    if (
      hostedWorker &&
      holders.size === 0 &&
      routes.size === 0 &&
      backlog.length === 0
    ) {
      hostedWorker.terminate()
      hostedWorker = null
      computePort = null
      spawnRequested = false
    }
  })
  port.start?.()
  const heldNames = namesToRestore
  namesToRestore = []
  if (heldNames.length === 0) {
    computeReady = true
    flushBacklog()
    return
  }
  // restore held databases before anything else runs against the fresh
  // compute; the backlog flushes when the last re-open answers
  let reopensPending = heldNames.length
  for (const name of heldNames) {
    const routeId = nextRouteId++
    const request = { id: -1, op: 'open', name, storage: 'opfs' } as const
    routes.set(routeId, {
      request,
      originalId: -1,
      port: {
        postMessage: () => {
          reopensPending -= 1
          if (reopensPending === 0) {
            computeReady = true
            flushBacklog()
          }
        },
        addEventListener: () => {},
      },
    })
    port.postMessage({ ...request, id: routeId } satisfies WorkerRequest)
  }
}

const flushBacklog = (): void => {
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
  const base = { port, originalId: request.id, request }
  routes.set(routeId, transform ? { ...base, transform } : base)
  computePort!.postMessage({ ...request, id: routeId })
  scheduleWatchdog()
}

const forward = (
  port: PortLike,
  request: WorkerRequest,
  transform?: (result: unknown) => unknown,
): void => {
  if (!computePort || !computeReady) {
    const entry = { port, request }
    backlog.push(transform ? { ...entry, transform } : entry)
    // spawn only when there is no compute at all — during the re-open
    // gate a live compute exists and must not get a twin
    if (!computePort && !spawnRequested) {
      spawnRequested = true
      if (!spawnComputeHere()) {
        port.postMessage({ control: 'spawnWorker' })
      }
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
    case 'syncTurn': {
      const now = Date.now()
      const lease = syncLeases.get(request.name)
      const granted = !lease || lease.port === port || lease.expiresAt <= now
      if (granted) {
        syncLeases.set(request.name, {
          port,
          expiresAt: now + request.leaseMs,
        })
      }
      answer(port, request.id, { granted })
      return
    }
    case 'publishChanges': {
      // fan out to every OTHER tab holding this database; the sender's
      // own cache is already up to date (its commit did that)
      for (const holder of holders.get(request.name) ?? []) {
        if (holder !== port) {
          holder.postMessage({
            control: 'externalChanges',
            name: request.name,
            changes: request.changes,
          })
        }
      }
      answer(port, request.id, null)
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
  const ping = { id: routeId, op: 'ping' } satisfies WorkerRequest
  let answered = false
  routes.set(routeId, {
    // a self-addressed route: mark answered, deliver to nobody (and if
    // an epoch reset replays it, a ping is a harmless no-op)
    request: ping,
    port: {
      postMessage: () => {
        answered = true
      },
      addEventListener: () => {},
    },
    originalId: -1,
  })
  target.postMessage(ping)
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
