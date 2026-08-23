import type {
  SyncPullArgs,
  SyncPullResult,
  SyncPushArgs,
  SyncPushResult,
} from '../sync/types';

/**
 * The client half of the wire contract (the server half is
 * `@remelondb/server`). Protocol outcomes — `conflict`, `resyncRequired`,
 * per-record rejections — arrive as HTTP 200 and pass through to
 * `synchronize` as data. Everything else — non-2xx, network failure,
 * malformed body, wire-invalid shape — is a SyncTransportError: the sync
 * run fails and local dirty state stays. Request authentication is the
 * platform's job and lives in the `post` an app supplies.
 */
export class SyncTransportError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SyncTransportError';
  }
}

export type SyncPath = 'pull' | 'push';

/** A platform's authenticated POST; resolves to the raw JSON body. */
export type SyncPost = (
  path: SyncPath,
  body: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;

/** Classify one fetch: network failure, non-2xx, or unparseable body. */
export async function readSyncResponse(
  path: SyncPath,
  send: () => Promise<Response>,
): Promise<unknown> {
  let response: Response;
  try {
    response = await send();
  } catch (error) {
    throw new SyncTransportError(
      `sync ${path}: network failure (${String(error)})`,
    );
  }
  if (!response.ok) {
    throw new SyncTransportError(
      `sync ${path}: HTTP ${response.status}`,
      response.status,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new SyncTransportError(`sync ${path}: malformed response body`);
  }
}

export interface SyncTransportOptions {
  readonly post: SyncPost;
  /** Validate an untrusted pull body; throw to reject it. `syncSchemas`
   * from `@remelondb/core/zod` fits: `(raw) => wire.pullResult.parse(raw)`. */
  readonly validatePullResult: (raw: unknown) => SyncPullResult;
  /** Validate an untrusted push body; throw to reject it. */
  readonly validatePushResult: (raw: unknown) => SyncPushResult;
}

/**
 * `pullChanges`/`pushChanges` for `synchronize()`: post, validate, and
 * keep the protocol/transport split. A validator throw becomes a
 * SyncTransportError, never data.
 */
export function createSyncTransport(options: SyncTransportOptions) {
  const validated = <T>(
    path: SyncPath,
    raw: unknown,
    validate: (raw: unknown) => T,
  ): T => {
    try {
      return validate(raw);
    } catch (error) {
      throw new SyncTransportError(
        `sync ${path}: invalid wire shape (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  };
  return {
    async pullChanges(
      args: SyncPullArgs,
      signal?: AbortSignal,
    ): Promise<SyncPullResult> {
      const raw = await options.post('pull', args, signal);
      return validated('pull', raw, options.validatePullResult);
    },
    async pushChanges(
      args: SyncPushArgs,
      signal?: AbortSignal,
    ): Promise<SyncPushResult> {
      const raw = await options.post('push', args, signal);
      return validated('push', raw, options.validatePushResult);
    },
  };
}
