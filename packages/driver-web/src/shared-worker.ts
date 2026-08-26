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
 *   epoch. Pending requests are requeued and holders are kept, since
 *   they are the state a fresh compute must restore, and a
 *   replacement host is recruited one candidate at a time, the tab
 *   that just messaged us first, then the most recently connected.
 *   A candidate silent past its own deadline is passed over, since
 *   postMessage to a dead port neither throws nor arrives and
 *   silence is the only liveness signal there is. Requests fail only
 *   once every candidate is quiet.
 *
 * Typed structurally instead of via lib "WebWorker" so the workspace
 * can typecheck without conflicting global libs (same as worker.ts).
 */
import type {
  BrokerControlMessage,
  ClientControlMessage,
  WorkerRequest,
  WorkerResponse,
} from './protocol';

const PING_DEADLINE_MS = 1000;

interface PortLike {
  postMessage(message: unknown, transfer?: readonly unknown[]): void;
  addEventListener(
    type: 'message',
    listener: (event: { data: unknown; ports?: readonly PortLike[] }) => void,
  ): void;
  start?(): void;
}

interface Route {
  readonly port: PortLike;
  readonly originalId: number;
  /** The as-sent request, so an epoch reset can replay instead of fail. */
  readonly request: WorkerRequest;
  /** Reshape the worker's result before answering (synthesized requests). */
  readonly transform?: (result: unknown) => unknown;
  /** Undo broker state recorded before the worker accepted the request. */
  readonly onFailure?: () => void;
}

const scope = globalThis as unknown as {
  addEventListener(
    type: 'connect',
    listener: (event: { ports: readonly PortLike[] }) => void,
  ): void;
};

let computePort: PortLike | null = null;
/** False while a fresh compute is re-opening held databases. */
let computeReady = false;
/** Held databases to restore on the next adopt (set by resetEpoch). */
let namesToRestore: string[] = [];
let lastResponseAt = 0;
let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * New connections probe the compute channel, but a lone surviving tab
 * gets no new connection: without this, its requests to a dead compute
 * would hang forever. Any send with no response for a while triggers
 * the same probe (which epoch-resets, respawns and replays on silence).
 */
const scheduleWatchdog = (): void => {
  if (watchdogTimer !== null) {
    return;
  }
  watchdogTimer = setTimeout(() => {
    watchdogTimer = null;
    if (!computePort || routes.size === 0) {
      return;
    }
    if (Date.now() - lastResponseAt >= 2000) {
      probeCompute();
    }
    scheduleWatchdog();
  }, 2500);
};
let hostedWorker: { terminate(): void } | null = null;
let brokerHostingFailed = false;

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
      terminate(): void;
      addEventListener(type: 'error', listener: () => void): void;
    })
  | undefined;

const spawnComputeHere = (): boolean => {
  if (typeof Worker !== 'function' || brokerHostingFailed) {
    return false;
  }
  try {
    // the literal `new Worker(new URL(...))` shape is load-bearing:
    // bundlers statically rewrite exactly this pattern to the built
    // chunk URL — an aliased constructor ships the raw specifier and
    // 404s in production
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.addEventListener('error', () => {
      // the hosted worker failed to load or crashed on startup: fall
      // back to tab-hosted compute instead of hanging every request
      if (hostedWorker === worker) {
        brokerHostingFailed = true;
        hostedWorker = null;
        computePort = null;
        worker.terminate();
        // every spawn goes through one recruiter, so this path gets the
        // same candidate ordering and retry-on-silence as the others
        restartRecruitment();
      }
    });
    hostedWorker = worker;
    adoptComputePort(worker);
    return true;
  } catch {
    brokerHostingFailed = true;
    hostedWorker = null;
    return false;
  }
};
let nextRouteId = 1;
const routes = new Map<number, Route>();
const holders = new Map<string, Set<PortLike>>();
const syncLeases = new Map<string, { port: PortLike; expiresAt: number }>();
const backlog: Array<{
  port: PortLike;
  request: WorkerRequest;
  transform?: (result: unknown) => unknown;
  onFailure?: () => void;
}> = [];

/**
 * Ports in the order they connected, newest last. A port cannot be
 * tested for liveness, since posting to a page that has navigated
 * away neither throws nor arrives (remelonDB#38), so recency is the
 * best evidence available, and the port that just sent us a message
 * is better evidence still.
 */
const connectedPorts: PortLike[] = [];
const SPAWN_CANDIDATES = 8;
/** How long a tab gets to answer a spawnWorker control before the next
 * candidate is asked. Spawning is a `new Worker` call; a live page does
 * it in milliseconds. */
const SPAWN_DEADLINE_MS = 1200;

interface Recruitment {
  readonly asked: Set<PortLike>;
  timer: ReturnType<typeof setTimeout> | null;
}

let recruitment: Recruitment | null = null;

const rememberPort = (port: PortLike): void => {
  const index = connectedPorts.indexOf(port);
  if (index !== -1) {
    connectedPorts.splice(index, 1);
  }
  connectedPorts.push(port);
  if (connectedPorts.length > SPAWN_CANDIDATES) {
    connectedPorts.shift();
  }
};

const stopRecruitment = (): void => {
  if (recruitment?.timer) {
    clearTimeout(recruitment.timer);
  }
  recruitment = null;
};

const failBacklog = (reason: string): void => {
  for (const item of backlog.splice(0)) {
    item.onFailure?.();
    item.port.postMessage({
      id: item.request.id,
      ok: false,
      error: `WebSqliteDriver: ${reason}`,
    } satisfies WorkerResponse);
  }
};

/**
 * Recruit a tab to host the compute worker. The broker cannot spawn one
 * itself on Chromium or WebKit, and it cannot tell whether the tab it
 * asks still exists, so it asks one candidate at a time and moves on
 * when nobody adopts within the deadline. `preferred` is the port whose
 * request triggered this: it just sent a message, so it is alive.
 */
const requestSpawn = (preferred?: PortLike): void => {
  let active = recruitment;
  if (active) {
    if (active.timer) {
      clearTimeout(active.timer);
      active.timer = null;
    }
  } else {
    active = { asked: new Set(), timer: null };
    recruitment = active;
  }
  if (computePort) {
    stopRecruitment();
    return;
  }
  if (spawnComputeHere()) {
    return;
  }
  const candidates = [
    ...(preferred ? [preferred] : []),
    ...[...connectedPorts].reverse(),
  ];
  const asker = candidates.find((port) => !active.asked.has(port));
  if (!asker) {
    stopRecruitment();
    failBacklog(
      'no tab is available to host the database worker — every candidate ' +
        'went away without answering; reload the page',
    );
    return;
  }
  active.asked.add(asker);
  asker.postMessage({
    control: 'spawnWorker',
  } satisfies BrokerControlMessage);
  // A dead page swallows that control silently. Nothing else would ever
  // notice, so this timer is what keeps the broker from waiting on a
  // worker nobody is building.
  active.timer = setTimeout(() => {
    if (recruitment === active && !computePort) {
      active.timer = null;
      requestSpawn();
    }
  }, SPAWN_DEADLINE_MS);
};

const restartRecruitment = (preferred?: PortLike): void => {
  stopRecruitment();
  requestSpawn(preferred);
};

/**
 * The compute channel is gone. Instead of failing everything pending
 * (remelonDB#3: a fresh tab used to see "worker went away" because an
 * unrelated tab closed), requeue the pending requests and respawn —
 * self-hosted where possible, else via the first pending tab. Only when
 * no respawn path exists does the failure surface.
 */
const resetEpoch = (): void => {
  hostedWorker?.terminate();
  hostedWorker = null;
  computePort = null;
  computeReady = false;
  stopRecruitment();
  // ping probes are self-addressed bookkeeping, not user work: they
  // must never be replayed, and above all never chosen as the spawn
  // asker — their fake port swallows the spawnWorker control and the
  // whole respawn dies silently
  const pending = [...routes.values()].filter(
    (route) => route.request.op !== 'ping',
  );
  routes.clear();
  // holders are NOT cleared: they are exactly the state a fresh compute
  // must restore, so surviving tabs keep working (their queries would
  // otherwise hit a blank worker as "database is not open"). Names
  // whose own open is among the replayed requests are excluded — the
  // replay opens those itself.
  const replayedOpens = new Set(
    pending
      .concat(backlog.map((item) => ({ request: item.request })) as never[])
      .filter(
        (route) => (route as { request: WorkerRequest }).request.op === 'open',
      )
      .map(
        (route) =>
          ((route as { request: WorkerRequest }).request as { name: string })
            .name,
      ),
  );
  namesToRestore = [...holders.keys()].filter(
    (name) => !replayedOpens.has(name),
  );
  if (pending.length > 0) {
    for (const route of pending) {
      const entry = route.transform
        ? {
            port: route.port,
            request: route.request,
            transform: route.transform,
          }
        : { port: route.port, request: route.request };
      backlog.push(
        route.onFailure ? { ...entry, onFailure: route.onFailure } : entry,
      );
    }
    // Candidates are tried newest-connected first and retried on
    // silence: after a page load the oldest pending route belongs to
    // the page that just died, and asking it wedges the broker
    // (remelonDB#38).
    restartRecruitment();
  }
};

const adoptComputePort = (port: PortLike): void => {
  computePort = port;
  stopRecruitment();
  port.addEventListener('message', (event) => {
    const response = event.data as WorkerResponse;
    const route = routes.get(response.id);
    if (!route) {
      return;
    }
    lastResponseAt = Date.now();
    routes.delete(response.id);
    if (!response.ok) {
      route.onFailure?.();
    }
    if (response.ok && route.transform) {
      route.port.postMessage({
        id: route.originalId,
        ok: true,
        result: route.transform(response.result),
      } satisfies WorkerResponse);
    } else {
      route.port.postMessage({ ...response, id: route.originalId });
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
      hostedWorker.terminate();
      hostedWorker = null;
      computePort = null;
      stopRecruitment();
    }
  });
  port.start?.();
  const heldNames = namesToRestore;
  namesToRestore = [];
  if (heldNames.length === 0) {
    computeReady = true;
    flushBacklog();
    return;
  }
  // restore held databases before anything else runs against the fresh
  // compute; the backlog flushes when the last re-open answers
  let reopensPending = heldNames.length;
  for (const name of heldNames) {
    const routeId = nextRouteId++;
    const request = { id: -1, op: 'open', name, storage: 'opfs' } as const;
    routes.set(routeId, {
      request,
      originalId: -1,
      port: {
        postMessage: () => {
          reopensPending -= 1;
          if (reopensPending === 0) {
            computeReady = true;
            flushBacklog();
          }
        },
        addEventListener: () => {},
      },
    });
    port.postMessage({ ...request, id: routeId } satisfies WorkerRequest);
  }
};

const flushBacklog = (): void => {
  const queued = backlog.splice(0);
  for (const item of queued) {
    // replay the SEND, not the routing decision — holder bookkeeping
    // already happened when the request was first handled
    send(item.port, item.request, item.transform);
  }
};

/** Post to the compute channel (requires computePort to be live). */
const send = (
  port: PortLike,
  request: WorkerRequest,
  transform?: (result: unknown) => unknown,
  onFailure?: () => void,
): void => {
  const routeId = nextRouteId++;
  const base = { port, originalId: request.id, request };
  const route = transform ? { ...base, transform } : base;
  routes.set(routeId, onFailure ? { ...route, onFailure } : route);
  computePort!.postMessage({ ...request, id: routeId });
  scheduleWatchdog();
};

const forward = (
  port: PortLike,
  request: WorkerRequest,
  transform?: (result: unknown) => unknown,
  onFailure?: () => void,
): void => {
  if (!computePort || !computeReady) {
    const entry = { port, request };
    const queued = transform ? { ...entry, transform } : entry;
    backlog.push(onFailure ? { ...queued, onFailure } : queued);
    // spawn only when there is no compute at all — during the re-open
    // gate a live compute exists and must not get a twin
    if (!computePort && recruitment === null) {
      requestSpawn(port);
    }
    return;
  }
  send(port, request, transform, onFailure);
};

const answer = (port: PortLike, id: number, result: unknown): void => {
  port.postMessage({ id, ok: true, result } satisfies WorkerResponse);
};

/**
 * Write-block arbitration (docs/multi-tab.md): a plain token queue. An
 * exclusive slot (a db.write block) is granted only when nothing is
 * held; shared slots (db.read windows) coexist with each other. Strict
 * FIFO — a waiting writer blocks later readers, so writers can't starve.
 */
interface SlotWaiter {
  readonly port: PortLike;
  readonly requestId: number;
  readonly exclusive: boolean;
}

let nextSlot = 1;
const heldSlots = new Map<number, { exclusive: boolean }>();
const slotQueue: SlotWaiter[] = [];

const heldExclusive = (): boolean =>
  [...heldSlots.values()].some((slot) => slot.exclusive);

const grantSlots = (): void => {
  while (slotQueue.length > 0) {
    const head = slotQueue[0]!;
    const canGrant = head.exclusive ? heldSlots.size === 0 : !heldExclusive();
    if (!canGrant) {
      return;
    }
    slotQueue.shift();
    const slot = nextSlot++;
    heldSlots.set(slot, { exclusive: head.exclusive });
    answer(head.port, head.requestId, { slot });
    if (head.exclusive) {
      return; // exclusive holder: nothing else runs until release
    }
  }
};

const handle = (port: PortLike, request: WorkerRequest): void => {
  switch (request.op) {
    case 'acquireSlot': {
      slotQueue.push({
        port,
        requestId: request.id,
        exclusive: request.exclusive,
      });
      grantSlots();
      return;
    }
    case 'releaseSlot': {
      heldSlots.delete(request.slot);
      answer(port, request.id, null);
      grantSlots();
      return;
    }
    case 'syncTurn': {
      const now = Date.now();
      const lease = syncLeases.get(request.name);
      const granted = !lease || lease.port === port || lease.expiresAt <= now;
      if (granted) {
        syncLeases.set(request.name, {
          port,
          expiresAt: now + request.leaseMs,
        });
      }
      answer(port, request.id, { granted });
      return;
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
          } satisfies BrokerControlMessage);
        }
      }
      answer(port, request.id, null);
      return;
    }
    case 'open': {
      const existing = holders.get(request.name);
      const alreadyHeld = existing?.has(port) ?? false;
      const undoHolder = () => {
        const holding = holders.get(request.name);
        holding?.delete(port);
        if (holding?.size === 0) {
          holders.delete(request.name);
        }
      };
      if (existing && existing.size > 0) {
        existing.add(port);
        // joiner — even when the compute is not up yet: the first
        // open is already queued ahead of this pragma, so replay order
        // serves it correctly. Gating on a live compute made two
        // near-simultaneous cold opens both real, and the second died
        // on the server's "already open" guard (remelonDB#3).
        // joiner: report the connection's current version
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
              (rows as readonly { user_version?: unknown }[])[0]
                ?.user_version ?? 0,
            ),
          }),
          alreadyHeld ? undefined : undoHolder,
        );
        return;
      }
      const set = holders.get(request.name) ?? new Set<PortLike>();
      set.add(port);
      holders.set(request.name, set);
      forward(port, request, undefined, undoHolder);
      return;
    }
    case 'close': {
      const holding = holders.get(request.name);
      holding?.delete(port);
      if (holding && holding.size > 0) {
        answer(port, request.id, null); // others still hold it open
        return;
      }
      holders.delete(request.name);
      forward(port, request);
      return;
    }
    case 'destroy': {
      holders.delete(request.name);
      forward(port, request);
      return;
    }
    default:
      forward(port, request);
  }
};

/** Probe the compute channel; reset the epoch when it stopped answering. */
const probeCompute = (): void => {
  const target = computePort;
  if (!target) {
    return;
  }
  const routeId = nextRouteId++;
  const ping = { id: routeId, op: 'ping' } satisfies WorkerRequest;
  let answered = false;
  routes.set(routeId, {
    // a self-addressed route: mark answered, deliver to nobody (and if
    // an epoch reset replays it, a ping is a harmless no-op)
    request: ping,
    port: {
      postMessage: () => {
        answered = true;
      },
      addEventListener: () => {},
    },
    originalId: -1,
  });
  target.postMessage(ping);
  setTimeout(() => {
    routes.delete(routeId);
    if (!answered && computePort === target) {
      resetEpoch();
    }
  }, PING_DEADLINE_MS);
};

scope.addEventListener('connect', (event) => {
  const port = event.ports[0];
  if (!port) {
    return;
  }
  port.addEventListener('message', (messageEvent) => {
    const data = messageEvent.data as WorkerRequest | ClientControlMessage;
    // A control is never a request: anything carrying the field leaves
    // here, and the handoff branch is entered by name rather than by
    // the field's presence, so a control added later is ignored instead
    // of being read as an adoption or forwarded to the worker.
    if ('control' in data) {
      if (data.control !== 'adoptWorkerPort') {
        return;
      }
      const transferred = messageEvent.ports?.[0];
      if (transferred) {
        // A tab asked earlier can answer after another tab already
        // won the race (a suspended page waking up, say). Taking the
        // late worker would strand the live one and leave two computes
        // holding the SAH pool, so the loser is told to bin its worker.
        if (computePort) {
          port.postMessage({
            control: 'discardWorker',
          } satisfies BrokerControlMessage);
          return;
        }
        adoptComputePort(transferred);
      }
      return;
    }
    rememberPort(port);
    handle(port, data);
  });
  port.start?.();
  rememberPort(port);
  probeCompute();
  // A page that connects while an earlier spawn request is outstanding
  // is the best host available: it is provably alive, and the tab that
  // was asked may have gone away without answering (remelonDB#38).
  if (!computePort && backlog.length > 0) {
    requestSpawn(port);
  }
});
