import type {
  BatchStatement,
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
  postMessage(message: unknown): void
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
    }
  | undefined

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

  constructor(private readonly options: WebSqliteDriverOptions = {}) {}

  private createEndpoint(): Endpoint {
    if (this.options.createEndpoint) {
      return this.options.createEndpoint()
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

  async open(name: string): Promise<{ userVersion: number }> {
    if (this.name !== null) {
      throw new Error('WebSqliteDriver: database is already open')
    }
    const storage = this.options.storage ?? 'opfs'
    const coordinated =
      storage === 'opfs' ? await this.acquireTabLock(name) : false
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
        const result = await this.request<{ userVersion: number }>({
          op: 'open',
          name,
          storage,
        })
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
