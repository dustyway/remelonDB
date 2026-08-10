import type {
  BatchStatement,
  ExternalChangeSet,
  Row,
  SqlArgs,
  SqliteDriver,
} from '@remelondb/core'
import type {
  Endpoint,
  StorageKind,
  WorkerRequest,
  WorkerResponse,
} from './protocol'

// structural declarations — no DOM lib needed for typechecking
declare const Worker: new (
  url: URL,
  options: { type: 'module' },
) => {
  postMessage(message: unknown, transfer?: readonly unknown[]): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  terminate(): void
}

declare const navigator:
  | {
      locks?: {
        request(
          name: string,
          options: { ifAvailable?: boolean; steal?: boolean },
          callback: (lock: object | null) => unknown,
        ): Promise<unknown>
      }
      storage?: { getDirectory?: () => Promise<unknown> }
    }
  | undefined

/**
 * Thrown when OPFS storage is unavailable in the current browser context —
 * Firefox private browsing / "never remember history", or blocked site data.
 * OPFS is denied there even over https, so persistent offline mode cannot
 * start. Callers can catch this (or check `code === 'OPFS_UNAVAILABLE'`) to
 * degrade gracefully — surface a clear message, or reopen with
 * `storage: 'memory'` — instead of failing opaquely.
 * @category Driver
 */
export class OpfsUnavailableError extends Error {
  readonly code = 'OPFS_UNAVAILABLE' as const
  constructor(options?: { cause?: unknown }) {
    super(
      'OPFS storage is unavailable in this browser context (private ' +
        'browsing / "never remember history", or blocked site data). ' +
        'Persistent offline mode needs OPFS: allow site data for this site, ' +
        "use a normal window, or open with storage: 'memory' for a " +
        'non-persistent session.',
    )
    this.name = 'OpfsUnavailableError'
    if (options?.cause !== undefined) {
      ;(this as { cause?: unknown }).cause = options.cause
    }
  }
}

/**
 * Fail fast when OPFS is blocked, before any worker/broker is spawned.
 * `getDirectory()` throws on the main thread too in a denied context, so a
 * cheap probe here avoids a doomed startup — and, in shared mode, the broker
 * respawn loop that a storage-denied compute worker would otherwise trigger
 * (it looks "gone" rather than "refused"). A no-op where OPFS can't be
 * probed (no `navigator.storage`, e.g. Node): the worker path still reports.
 */
export async function probeOpfs(
  storage: { getDirectory?: () => Promise<unknown> } | undefined,
): Promise<void> {
  const getDirectory = storage?.getDirectory
  if (!getDirectory) {
    return
  }
  try {
    await getDirectory.call(storage)
  } catch (error) {
    throw new OpfsUnavailableError({ cause: error })
  }
}

// Omit must distribute over the request union
type RequestPayload = WorkerRequest extends infer R
  ? R extends WorkerRequest
    ? Omit<R, 'id'>
    : never
  : never

/** @category Driver */
export interface WebSqliteDriverOptions {
  /**
   * 'opfs' (default): persistent, via the OPFS SyncAccessHandle pool.
   * Unavailable OPFS is a loud error, never a silent downgrade.
   * 'memory': explicit non-persistent storage (tests, previews).
   */
  readonly storage?: StorageKind
  /**
   * The SAH pool allows one owner per origin, so a database can be open
   * in one tab at a time. Default: opening a database another tab holds
   * fails with a clear error. With `takeover: true`, this driver takes
   * the database instead — the other tab's driver shuts down and its
   * `onTakenOver` callback fires (in-flight statements there are
   * abandoned; committed data is safe on disk).
   */
  readonly takeover?: boolean
  /** Called when another tab takes this database over (see `takeover`). */
  readonly onTakenOver?: () => void
  /**
   * Opt in to the SharedWorker owner (docs/multi-tab.md): all tabs route
   * through one worker, so same-name opens SHARE a live connection —
   * no lock, no takeover; commits broadcast into every tab's cache,
   * write blocks arbitrate across tabs, and sync runs on one tab at a
   * time via a lease. Where `SharedWorker` is unavailable (Chrome for
   * Android), falls back to the default single-owner behavior.
   */
  readonly shared?: boolean
  /**
   * Shared mode: how long a granted sync lease lasts before another tab
   * may take it over. Renewal happens implicitly on each sync tick, so
   * this only matters after the holder goes away. Default 10s.
   */
  readonly syncLeaseMs?: number
  /**
   * Shared mode: deadline for the broker to answer the open request,
   * after which open() rejects instead of hanging. The default (15s)
   * clears the slowest honest startup — a first visit fetching the
   * sqlite-wasm binary over a slow network — with margin; a genuine
   * hang then reports in seconds instead of never.
   */
  readonly openTimeoutMs?: number
  /** Override the transport — used by tests to run in-process. */
  readonly createEndpoint?: () => Endpoint
}

/**
 * SqliteDriver for browsers: SQLite-WASM running in a dedicated Worker
 * (OPFS sync-access handles are worker-only), reached via postMessage RPC.
 * See docs/reference/driver.md for why the seam is async.
 * @category Driver
 */
export class WebSqliteDriver implements SqliteDriver {
  private endpoint: Endpoint | null = null
  private name: string | null = null
  private nextId = 1
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  private releaseTabLock: (() => void) | null = null
  private takenOver = false
  /**
   * @internal The compute worker this tab spawned for the broker, when it
   * was the one asked to host it. It lives and dies with the tab — except
   * in tests, which terminate it explicitly so the SAH pool's handles are
   * released before the next test file needs them.
   */
  hostedComputeWorker: { terminate(): void } | null = null
  private externalChangesHandler: ((changes: ExternalChangeSet) => void) | null = null

  constructor(private readonly options: WebSqliteDriverOptions = {}) {}

  /** True when this driver routes through the SharedWorker owner. */
  private get sharedMode(): boolean {
    return this.options.shared === true && typeof SharedWorker !== 'undefined'
  }

  private createEndpoint(): Endpoint {
    if (this.options.createEndpoint) {
      return this.options.createEndpoint()
    }
    if (this.sharedMode) {
      const shared = new SharedWorker(
        new URL('./shared-worker.ts', import.meta.url),
        { type: 'module' },
      )
      // A broker script that fails to load or parse dies silently; without
      // this handler every request would hang instead of failing.
      shared.onerror = () => {
        this.failAllPending(
          new Error(
            'WebSqliteDriver: the shared worker failed to start (its script ' +
              'did not load or crashed on startup). With Vite, add ' +
              "'@remelondb/driver-web' to optimizeDeps.exclude — see the " +
              'driver README, Bundlers section.',
          ),
        )
      }
      shared.port.start()
      return {
        postMessage: (message) => shared.port.postMessage(message),
        addMessageListener: (listener) =>
          shared.port.addEventListener('message', (event) => {
            const data = (event as MessageEvent).data as
              | { control?: string }
              | null
            if (data?.control === 'externalChanges') {
              const payload = data as unknown as {
                name: string
                changes: ExternalChangeSet
              }
              if (payload.name === this.name) {
                this.externalChangesHandler?.(payload.changes)
              }
              return
            }
            if (data?.control === 'spawnWorker') {
              // The broker cannot spawn workers (no Worker constructor in
              // SharedWorkerGlobalScope on Chromium/WebKit) — this tab
              // hosts the compute worker and bridges a channel to the
              // broker. The worker lives and dies with this tab.
              const compute = new Worker(
                new URL('./worker.ts', import.meta.url),
                { type: 'module' },
              )
              this.hostedComputeWorker = compute
              const channel = new MessageChannel()
              compute.postMessage({ __remelondbAdoptPort: true }, [
                channel.port2,
              ])
              shared.port.postMessage({ control: 'adoptWorkerPort' }, [
                channel.port1,
              ])
              return
            }
            listener(data)
          }),
        // closing OUR port must not kill the shared broker — other tabs
        // may be using it; the browser reclaims it with the last tab.
        terminate: () => shared.port.close(),
      }
    }
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
    })
    return {
      postMessage: (message) => worker.postMessage(message),
      addMessageListener: (listener) =>
        worker.addEventListener('message', (event) => listener(event.data)),
      terminate: () => worker.terminate(),
    }
  }

  /**
   * Cross-tab coordination via the Web Locks API (origin-scoped, so tabs
   * see each other). The lock is held for the connection's lifetime.
   * Returns false when locks are unavailable (Node tests, non-secure
   * contexts) — coordination is then skipped and behavior is unchanged.
   */
  private async acquireTabLock(name: string): Promise<boolean> {
    const locks = typeof navigator === 'undefined' ? undefined : navigator?.locks
    if (!locks) {
      return false
    }
    const acquired = await new Promise<boolean>((resolve, reject) => {
      void locks
        .request(
          `remelondb:${name}`,
          this.options.takeover === true
            ? { steal: true }
            : { ifAvailable: true },
          (lock) => {
            if (lock === null) {
              resolve(false)
              return null
            }
            resolve(true)
            // hold the lock until close/destroy resolves this promise
            return new Promise<void>((release) => {
              this.releaseTabLock = release
            })
          },
        )
        // a later steal by another tab rejects the request promise —
        // that is how the losing side learns it was taken over
        .catch((error: unknown) => {
          if (this.releaseTabLock !== null) {
            this.releaseTabLock = null
            this.handleTakenOver()
          } else {
            reject(error instanceof Error ? error : new Error(String(error)))
          }
        })
    })
    if (!acquired) {
      throw new Error(
        `WebSqliteDriver: '${name}' is open in another tab or window — ` +
          `close it there, or open with { takeover: true }`,
      )
    }
    return true
  }

  private handleTakenOver(): void {
    this.takenOver = true
    this.name = null
    this.endpoint?.terminate?.()
    this.endpoint = null
    const error = new Error(
      'WebSqliteDriver: the database was taken over by another tab',
    )
    for (const request of this.pending.values()) {
      request.reject(error)
    }
    this.pending.clear()
    this.options.onTakenOver?.()
  }

  private releaseLock(): void {
    this.releaseTabLock?.()
    this.releaseTabLock = null
  }

  private notOpenError(): Error {
    return new Error(
      this.takenOver
        ? 'WebSqliteDriver: the database was taken over by another tab'
        : 'WebSqliteDriver: database is not open',
    )
  }

  private request<T>(payload: RequestPayload): Promise<T> {
    const endpoint = this.endpoint
    if (!endpoint) {
      throw this.notOpenError()
    }
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      })
      endpoint.postMessage({ id, ...payload })
    })
  }

  private handleResponse(message: unknown): void {
    const response = message as WorkerResponse
    const pending = this.pending.get(response.id)
    if (!pending) {
      return
    }
    this.pending.delete(response.id)
    if (response.ok) {
      pending.resolve(response.result)
    } else {
      pending.reject(new Error(response.error))
    }
  }

  /** Reject every in-flight request — the transport itself is dead. */
  private failAllPending(error: Error): void {
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const entry of entries) {
      entry.reject(error)
    }
  }

  async open(name: string): Promise<{ userVersion: number }> {
    if (this.name !== null) {
      throw new Error('WebSqliteDriver: database is already open')
    }
    const storage = this.options.storage ?? 'opfs'
    // Refuse fast when OPFS is blocked (private mode / blocked site data)
    // rather than spawning a worker that can only fail — and, in shared
    // mode, respawn-loop. Callers catch OpfsUnavailableError to degrade.
    if (storage === 'opfs') {
      await probeOpfs(navigator?.storage)
    }
    // Shared mode has a single owner by construction — the Web Lock
    // contention this coordinates simply cannot happen there.
    const coordinated =
      storage === 'opfs' && !this.sharedMode
        ? await this.acquireTabLock(name)
        : false
    this.takenOver = false
    if (!this.endpoint) {
      this.endpoint = this.createEndpoint()
      this.endpoint.addMessageListener((message) => this.handleResponse(message))
    }
    // After a takeover the losing tab's worker needs a moment to die and
    // release the pool's file locks — retry briefly instead of failing.
    let attempts = coordinated ? 20 : 1
    for (;;) {
      try {
        const openRequest = this.request<{ userVersion: number }>({
          op: 'open',
          name,
          storage,
        })
        // A dead broker answers nothing; the deadline turns a hang into
        // an actionable error.
        const deadlineMs = this.options.openTimeoutMs ?? 15_000
        const result = this.sharedMode
          ? await Promise.race([
              openRequest,
              new Promise<never>((_, timeoutReject) =>
                setTimeout(
                  () =>
                    timeoutReject(
                      new Error(
                        'WebSqliteDriver: the shared worker did not answer ' +
                          `the open request within ${deadlineMs}ms. Its ` +
                          'script may have failed to load — with Vite, add ' +
                          "'@remelondb/driver-web' to optimizeDeps.exclude; " +
                          'see the driver README, Bundlers section.',
                      ),
                    ),
                  deadlineMs,
                ),
              ),
            ])
          : await openRequest
        this.name = name
        return result
      } catch (error) {
        attempts -= 1
        if (attempts <= 0) {
          this.releaseLock()
          throw error
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
  }

  private get openName(): string {
    if (this.name === null) {
      throw this.notOpenError()
    }
    return this.name
  }

  /**
   * Cross-tab write-block arbitration (docs/multi-tab.md). In shared mode
   * the broker grants slots; in dedicated mode storage is exclusive to
   * this driver and its in-process queue, so the slot is a free no-op.
   */
  async acquireWorkSlot(exclusive: boolean): Promise<() => Promise<void>> {
    if (!this.sharedMode) {
      return async () => {}
    }
    const { slot } = await this.request<{ slot: number }>({
      op: 'acquireSlot',
      exclusive,
    })
    return async () => {
      await this.request({ op: 'releaseSlot', slot })
    }
  }

  /**
   * Change propagation (docs/multi-tab.md): commits publish to the broker,
   * which relays them to the other tabs; the broker's relays arrive here
   * and go to the registered handler. Both are shared-mode-only —
   * dedicated storage has no other context to tell.
   */
  publishChanges(changes: ExternalChangeSet): void {
    if (!this.sharedMode || this.name === null) {
      return
    }
    // best-effort: a lost notification means a stale cache elsewhere
    // until the next commit, and the next real request errors loudly
    void this.request({
      op: 'publishChanges',
      name: this.name,
      changes,
    }).catch(() => {})
  }

  onExternalChanges(handler: (changes: ExternalChangeSet) => void): void {
    this.externalChangesHandler = handler
  }

  /**
   * Sync ownership (docs/multi-tab.md): in shared mode, a lease from
   * the broker decides which tab's synchronize actually runs; asking
   * again renews it, and an expired lease passes to the next asker (a
   * closed tab stops renewing, so ownership self-heals). Dedicated
   * storage always owns sync.
   */
  async requestSyncTurn(): Promise<boolean> {
    if (!this.sharedMode || this.name === null) {
      return true
    }
    const { granted } = await this.request<{ granted: boolean }>({
      op: 'syncTurn',
      name: this.name,
      leaseMs: this.options.syncLeaseMs ?? 10_000,
    })
    return granted
  }

  async close(): Promise<void> {
    const name = this.openName
    await this.request({ op: 'close', name })
    this.name = null
    // a self-created worker dies here, releasing the pool's file locks
    // for other tabs; injected endpoints without terminate are untouched
    this.endpoint?.terminate?.()
    this.endpoint = null
    this.releaseLock()
  }

  async query(sql: string, args: SqlArgs): Promise<Row[]> {
    return this.request<Row[]>({ op: 'query', name: this.openName, sql, args })
  }

  async execute(sql: string, args: SqlArgs): Promise<void> {
    await this.request({ op: 'execute', name: this.openName, sql, args })
  }

  async executeBatch(statements: readonly BatchStatement[]): Promise<void> {
    await this.request({
      op: 'executeBatch',
      name: this.openName,
      statements,
    })
  }

  async setUserVersion(version: number): Promise<void> {
    await this.request({ op: 'setUserVersion', name: this.openName, version })
  }

  async destroy(): Promise<void> {
    const name = this.name
    this.name = null
    if (name !== null && this.endpoint) {
      await this.request({ op: 'destroy', name: name })
    }
    this.endpoint?.terminate?.()
    this.endpoint = null
    this.releaseLock()
  }
}
