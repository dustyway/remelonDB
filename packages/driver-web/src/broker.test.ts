/**
 * The broker under a stubbed SharedWorker connect event, in Node: the
 * discipline fixes from the thermonuclear review, each red without its
 * fix. The full protocol runs in the browser suite; these pin broker
 * bookkeeping that needs hostile or vanished peers to show.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakePort {
  postMessage: (m: unknown, t?: readonly unknown[]) => void;
  addEventListener: (t: 'message', l: (e: MessageEvent) => void) => void;
  start?: () => void;
  out: unknown[];
  send: (data: unknown, ports?: readonly FakePort[]) => void;
}

const makePort = (): FakePort => {
  const listeners: ((e: MessageEvent) => void)[] = [];
  const out: unknown[] = [];
  return {
    postMessage: (m) => {
      out.push(m);
    },
    addEventListener: (_t, l) => listeners.push(l),
    start: () => {},
    out,
    send: (data, ports) => {
      for (const l of [...listeners])
        l({ data, ports } as unknown as MessageEvent);
    },
  };
};

let connectHandlers: ((e: { ports: readonly FakePort[] }) => void)[] = [];

const loadBroker = async (): Promise<(port: FakePort) => void> => {
  connectHandlers = [];
  vi.resetModules();
  (globalThis as { addEventListener: unknown }).addEventListener = (
    type: string,
    l: (e: { ports: readonly FakePort[] }) => void,
  ) => {
    if (type === 'connect') connectHandlers.push(l);
  };
  await import('./shared-worker');
  return (port) => {
    for (const h of connectHandlers) h({ ports: [port] });
  };
};

const op = (m: unknown): unknown => (m as { op?: unknown }).op;

beforeEach(() => {
  vi.useFakeTimers();
});

describe('slot ownership', () => {
  it('a foreign releaseSlot does not free the slot', async () => {
    const connect = await loadBroker();
    const a = makePort();
    const b = makePort();
    connect(a);
    connect(b);

    a.send({ id: 1, op: 'acquireSlot', exclusive: true });
    expect(a.out).toEqual([{ id: 1, ok: true, result: { slot: 1 } }]);

    // b guesses the slot id and releases it, then asks for its own
    b.send({ id: 1, op: 'releaseSlot', slot: 1 });
    b.send({ id: 2, op: 'acquireSlot', exclusive: true });
    // the release is answered, the acquire is NOT granted: a still holds
    expect(b.out).toEqual([{ id: 1, ok: true, result: null }]);

    // the owner's release frees it and b gets its grant
    a.send({ id: 2, op: 'releaseSlot', slot: 1 });
    expect(b.out).toHaveLength(2);
  });
});

describe('sync lease bounds', () => {
  it('an Infinity lease cannot wedge sync ownership past the ceiling', async () => {
    const connect = await loadBroker();
    const a = makePort();
    const b = makePort();
    connect(a);
    connect(b);

    vi.setSystemTime(0);
    a.send({ id: 1, op: 'syncTurn', name: 'db', leaseMs: Infinity });
    expect(a.out).toEqual([{ id: 1, ok: true, result: { granted: true } }]);

    vi.setSystemTime(60_000);
    b.send({ id: 1, op: 'syncTurn', name: 'db', leaseMs: 10_000 });
    expect(b.out).toEqual([{ id: 1, ok: true, result: { granted: false } }]);

    vi.setSystemTime(300_001);
    b.send({ id: 2, op: 'syncTurn', name: 'db', leaseMs: 10_000 });
    expect(b.out).toHaveLength(2);
    expect(b.out[1]).toEqual({ id: 2, ok: true, result: { granted: true } });
  });
});

describe('storage discipline', () => {
  it('refuses to join a held database with the other storage kind', async () => {
    const connect = await loadBroker();
    const a = makePort();
    const b = makePort();
    connect(a);
    connect(b);

    a.send({ id: 1, op: 'open', name: 'db', storage: 'memory' });
    b.send({ id: 1, op: 'open', name: 'db', storage: 'opfs' });
    expect(b.out).toEqual([
      {
        id: 1,
        ok: true,
        result: {
          error: "database 'db' is open with storage 'memory', not 'opfs'",
        },
      },
    ]);
  });
});

describe('backlog integrity across an epoch reset', () => {
  it('carries onFailure through the flush: a failed cold open leaves no holder', async () => {
    const connect = await loadBroker();
    const tab = makePort();
    connect(tab);

    // cold open goes to the backlog (no compute yet); the broker asks the
    // tab to spawn, the tab bridges a compute port
    tab.send({ id: 1, op: 'open', name: 'db', storage: 'opfs' });
    const compute = makePort();
    tab.send({ control: 'adoptWorkerPort' }, [compute]);
    // the flushed open reaches the compute and FAILS
    const flushedOpen = compute.out.find((m) => op(m) === 'open') as {
      id: number;
    };
    compute.send({ id: flushedOpen.id, ok: false, error: 'no space' });

    // with the holder undone, a second open is a cold open again — not a
    // join against a database that never opened
    tab.send({ id: 2, op: 'open', name: 'db', storage: 'opfs' });
    const opens = compute.out.filter((m) => op(m) === 'open');
    expect(opens).toHaveLength(2);
  });

  it('replays stranded requests ahead of newer backlog entries', async () => {
    const connect = await loadBroker();
    const tab = makePort();
    connect(tab);

    tab.send({ id: 1, op: 'open', name: 'db', storage: 'opfs' });
    const c1 = makePort();
    tab.send({ control: 'adoptWorkerPort' }, [c1]);
    const openMsg = c1.out.find((m) => op(m) === 'open') as { id: number };
    c1.send({ id: openMsg.id, ok: true, result: { userVersion: 1 } });

    // a query goes in flight on c1, then c1 goes silent: the watchdog
    // pings, the deadline passes, the epoch resets with the query stranded
    tab.send({ id: 2, op: 'query', name: 'db', sql: 'select 1', args: [] });
    await vi.advanceTimersByTimeAsync(2_500); // watchdog fires, ping sent
    await vi.advanceTimersByTimeAsync(1_000); // ping deadline: epoch reset

    // during recruitment, a NEWER request arrives and joins the backlog
    tab.send({ id: 3, op: 'query', name: 'db', sql: 'select 2', args: [] });
    // the tab answers the spawn request with a fresh compute
    const c2 = makePort();
    tab.send({ control: 'adoptWorkerPort' }, [c2]);
    // the restore-open answers, releasing the backlog
    const restore = c2.out.find((m) => op(m) === 'open') as { id: number };
    c2.send({ id: restore.id, ok: true, result: { userVersion: 1 } });

    const sqls = c2.out
      .filter((m) => op(m) === 'query')
      .map((m) => (m as { sql: string }).sql);
    // the stranded select 1 replays before the younger select 2
    expect(sqls).toEqual(['select 1', 'select 2']);
  });
});

describe('hostile messages', () => {
  it('ignores a non-object message instead of throwing', async () => {
    const connect = await loadBroker();
    const a = makePort();
    connect(a);

    expect(() => {
      a.send(null);
      a.send('hello');
      a.send(42);
    }).not.toThrow();

    // the port still works
    a.send({ id: 1, op: 'acquireSlot', exclusive: true });
    expect(a.out).toEqual([{ id: 1, ok: true, result: { slot: 1 } }]);
  });
});

describe('destroy notification', () => {
  it('tells the other holders their database is gone', async () => {
    const connect = await loadBroker();
    const a = makePort();
    const b = makePort();
    connect(a);
    connect(b);

    a.send({ id: 1, op: 'open', name: 'db', storage: 'memory' });
    b.send({ id: 1, op: 'open', name: 'db', storage: 'memory' });
    a.send({ id: 2, op: 'destroy', name: 'db' });

    expect(b.out).toContainEqual({
      control: 'databaseDestroyed',
      name: 'db',
    });
    // the destroyer is not told about its own destroy
    expect(a.out).not.toContainEqual({
      control: 'databaseDestroyed',
      name: 'db',
    });
  });
});

describe('publishChanges shape', () => {
  const holdTwo = async (): Promise<[FakePort, FakePort]> => {
    const connect = await loadBroker();
    const a = makePort();
    const b = makePort();
    connect(a);
    connect(b);
    a.send({ id: 1, op: 'open', name: 'db', storage: 'memory' });
    b.send({ id: 1, op: 'open', name: 'db', storage: 'memory' });
    return [a, b];
  };

  it('refuses a malformed change set instead of relaying it', async () => {
    const [a, b] = await holdTwo();
    a.send({ id: 2, op: 'publishChanges', name: 'db', changes: 'oops' });
    a.send({
      id: 3,
      op: 'publishChanges',
      name: 'db',
      changes: { notes: [{ type: 'created', record: { id: 7 } }] },
    });
    a.send({
      id: 4,
      op: 'publishChanges',
      name: 'db',
      changes: { notes: [{ type: 'exploded', record: { id: 'n1' } }] },
    });

    expect(
      a.out.filter((m) => (m as { ok?: boolean }).ok === false),
    ).toHaveLength(3);
    expect(
      b.out.some(
        (m) => (m as { control?: string }).control === 'externalChanges',
      ),
    ).toBe(false);
  });

  it('still relays a well-formed change set', async () => {
    const [a, b] = await holdTwo();
    const changes = { notes: [{ type: 'created', record: { id: 'n1' } }] };
    a.send({ id: 2, op: 'publishChanges', name: 'db', changes });
    expect(b.out).toContainEqual({
      control: 'externalChanges',
      name: 'db',
      changes,
    });
  });
});
