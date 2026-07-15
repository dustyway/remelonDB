import type {
  BatchStatement,
  Row,
  SqlArgs,
  SqliteDriver,
} from '@remelon/core'
import type {
  Endpoint,
  StorageKind,
  WorkerRequest,
  WorkerResponse,
} from './protocol'

// structural declaration — no DOM lib needed for typechecking
declare const Worker: new (
  url: URL,
  options: { type: 'module' },
) => {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  terminate(): void
}

// Omit must distribute over the request union
type RequestPayload = WorkerRequest extends infer R
  ? R extends WorkerRequest
    ? Omit<R, 'id'>
    : never
  : never

export interface WebSqliteDriverOptions {
  /**
   * 'opfs' (default): persistent, via the OPFS SyncAccessHandle pool.
   * Unavailable OPFS is a loud error, never a silent downgrade.
   * 'memory': explicit non-persistent storage (tests, previews).
   */
  readonly storage?: StorageKind
  /** Override the transport — used by tests to run in-process. */
  readonly createEndpoint?: () => Endpoint
}

/**
 * SqliteDriver for browsers: SQLite-WASM running in a dedicated Worker
 * (OPFS sync-access handles are worker-only), reached via postMessage RPC.
 * See docs/reference/driver.md for why the seam is async.
 */
export class WebSqliteDriver implements SqliteDriver {
  private endpoint: Endpoint | null = null
  private name: string | null = null
  private nextId = 1
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()

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
    }
  }

  private request<T>(payload: RequestPayload): Promise<T> {
    const endpoint = this.endpoint
    if (!endpoint) {
      throw new Error('WebSqliteDriver: database is not open')
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
    if (!this.endpoint) {
      this.endpoint = this.createEndpoint()
      this.endpoint.addMessageListener((message) => this.handleResponse(message))
    }
    const result = await this.request<{ userVersion: number }>({
      op: 'open',
      name,
      storage: this.options.storage ?? 'opfs',
    })
    this.name = name
    return result
  }

  private get openName(): string {
    if (this.name === null) {
      throw new Error('WebSqliteDriver: database is not open')
    }
    return this.name
  }

  async close(): Promise<void> {
    const name = this.openName
    await this.request({ op: 'close', name })
    this.name = null
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
  }
}
