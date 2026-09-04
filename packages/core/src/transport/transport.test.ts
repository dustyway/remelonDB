import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { syncSchemas } from '../zod/index';
import {
  createHttpPost,
  createSyncTransport,
  readSyncResponse,
  SyncTransportError,
} from './index';

const TaskRow = z.object({ name: z.string(), position: z.number() });
const wire = syncSchemas({ tasks: TaskRow });

const transport = (post: Parameters<typeof createSyncTransport>[0]['post']) =>
  createSyncTransport({
    post,
    validatePullResult: (raw) => wire.pullResult.parse(raw),
    validatePushResult: (raw) => wire.pushResult.parse(raw),
  });

const emptyChanges = { tasks: { created: [], updated: [], deleted: [] } };
const pullArgs = { cursor: null, schemaVersion: 1, migration: null };
const pushArgs = { cursor: '7', changes: emptyChanges };

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const fetchPost = (impl: () => Promise<Response>) => (path: 'pull' | 'push') =>
  readSyncResponse(path, impl);

afterEach(() => vi.restoreAllMocks());

describe('sync transport', () => {
  it('returns a parsed pull package', async () => {
    const { pullChanges } = transport(
      fetchPost(async () =>
        jsonResponse(200, { cursor: '1', changes: emptyChanges }),
      ),
    );
    await expect(pullChanges(pullArgs)).resolves.toMatchObject({
      cursor: '1',
    });
  });

  it('returns a parsed push acknowledgement including rejections', async () => {
    const { pushChanges } = transport(
      fetchPost(async () =>
        jsonResponse(200, {
          cursor: null,
          changes: null,
          rejected: { tasks: ['r1'] },
        }),
      ),
    );
    await expect(pushChanges(pushArgs)).resolves.toMatchObject({
      rejected: { tasks: ['r1'] },
    });
  });

  it('passes conflict and resyncRequired through as data', async () => {
    const conflict = transport(
      fetchPost(async () => jsonResponse(200, { conflict: true })),
    );
    await expect(conflict.pushChanges(pushArgs)).resolves.toEqual({
      conflict: true,
    });
    const resync = transport(
      fetchPost(async () => jsonResponse(200, { resyncRequired: true })),
    );
    await expect(resync.pullChanges(pullArgs)).resolves.toEqual({
      resyncRequired: true,
    });
  });

  it('non-2xx is a transport error carrying the status', async () => {
    const { pullChanges } = transport(
      fetchPost(async () => jsonResponse(401, { message: 'no session' })),
    );
    const error = await pullChanges(pullArgs).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyncTransportError);
    expect((error as SyncTransportError).status).toBe(401);
  });

  it('a network failure is a transport error without a status', async () => {
    const { pushChanges } = transport(
      fetchPost(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const error = await pushChanges(pushArgs).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyncTransportError);
    expect((error as SyncTransportError).status).toBeUndefined();
  });

  it('a malformed body is a transport error', async () => {
    const { pullChanges } = transport(
      fetchPost(async () => new Response('<html>', { status: 200 })),
    );
    await expect(pullChanges(pullArgs)).rejects.toBeInstanceOf(
      SyncTransportError,
    );
  });

  it('a wire-shape violation is a transport error, not data', async () => {
    const { pullChanges } = transport(
      fetchPost(async () => jsonResponse(200, { cursor: 5 })),
    );
    await expect(pullChanges(pullArgs)).rejects.toBeInstanceOf(
      SyncTransportError,
    );
  });

  it('a validator throw is wrapped, whatever it throws', async () => {
    const { pullChanges } = createSyncTransport({
      post: async () => ({}),
      validatePullResult: () => {
        // A non-Error throw is the point of this test.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'nope';
      },
      validatePushResult: (raw) => wire.pushResult.parse(raw),
    });
    const error = await pullChanges(pullArgs).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyncTransportError);
    expect((error as Error).message).toContain('invalid wire shape');
  });

  it('forwards args and the abort signal to post', async () => {
    const post = vi.fn(async () => ({ cursor: null, changes: null }));
    const { pushChanges } = createSyncTransport({
      post,
      validatePullResult: (raw) => wire.pullResult.parse(raw),
      validatePushResult: (raw) => wire.pushResult.parse(raw),
    });
    const controller = new AbortController();
    await pushChanges(pushArgs, controller.signal);
    expect(post).toHaveBeenCalledWith('push', pushArgs, controller.signal);
  });
});

describe('createHttpPost', () => {
  afterEach(() => vi.unstubAllGlobals());

  const stubFetch = (impl: () => Promise<Response>) => {
    const spy = vi.fn(impl);
    vi.stubGlobal('fetch', spy);
    return spy;
  };

  it('posts JSON to baseUrl/sync/{path} and forwards the signal', async () => {
    const spy = stubFetch(async () => jsonResponse(200, { ok: true }));
    const post = createHttpPost({ baseUrl: 'https://api.test' });
    const controller = new AbortController();
    await post('pull', { cursor: null }, controller.signal);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/sync/pull');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ cursor: null });
    expect(init.signal).toBe(controller.signal);
  });

  it('calls headers() per request and merges over content-type', async () => {
    const spy = stubFetch(async () => jsonResponse(200, {}));
    let cookie = 'session=a';
    const post = createHttpPost({
      baseUrl: '',
      headers: () => ({ cookie }),
    });
    await post('push', {});
    cookie = 'session=b';
    await post('push', {});
    const headersOf = (n: number) =>
      (spy.mock.calls[n] as unknown as [string, RequestInit])[1].headers;
    expect(headersOf(0)).toMatchObject({
      'content-type': 'application/json',
      cookie: 'session=a',
    });
    expect(headersOf(1)).toMatchObject({ cookie: 'session=b' });
  });

  it('passes credentials through and classifies failures', async () => {
    const spy = stubFetch(async () => jsonResponse(503, {}));
    const post = createHttpPost({ baseUrl: '', credentials: 'include' });
    const error = await post('pull', {}).catch((e: unknown) => e);
    expect(
      (spy.mock.calls[0] as unknown as [string, RequestInit])[1].credentials,
    ).toBe('include');
    expect(error).toBeInstanceOf(SyncTransportError);
    expect((error as SyncTransportError).status).toBe(503);
  });
});
