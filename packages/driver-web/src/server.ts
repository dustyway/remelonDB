/**
 * The worker-side server: owns sqlite-wasm connections keyed by name and
 * answers WorkerRequests. Runs identically inside a real Worker
 * (src/worker.ts) and in-process under Node tests — that's the point.
 *
 * Storage: 'opfs' uses the OPFS SyncAccessHandle pool VFS (persistent, no
 * COOP/COEP headers needed, worker-only — the reason the whole seam is
 * async). 'memory' is explicit and non-persistent; opening with 'opfs'
 * where OPFS is unavailable is a loud error, never a silent downgrade.
 */
import type {
  Database,
  PreparedStatement,
  SqlValue as WasmSqlValue,
  Sqlite3Static,
} from '@sqlite.org/sqlite-wasm'
import type { SqlValue } from '@watermelon-rewrite/core'
import type { Endpoint, WorkerRequest, WorkerResponse } from './protocol'

interface Connection {
  db: Database
  statements: Map<string, PreparedStatement>
  storage: 'opfs' | 'memory'
}

// booleans are stored as 0/1 — the seam-wide convention.
// (bind() throws on parameterless statements, hence the length guard)
const bind = (statement: PreparedStatement, args: readonly SqlValue[]): void => {
  if (args.length > 0) {
    statement.bind(
      args.map((value) =>
        value === true ? 1 : value === false ? 0 : (value as WasmSqlValue),
      ),
    )
  }
}

const fromColumn = (value: unknown): SqlValue => {
  if (typeof value === 'bigint') {
    return Number(value)
  }
  return value as SqlValue
}

export class SqliteWorkerServer {
  private connections = new Map<string, Connection>()
  private poolUtil: Awaited<
    ReturnType<Sqlite3Static['installOpfsSAHPoolVfs']>
  > | null = null

  constructor(private readonly sqlite3: Sqlite3Static) {}

  private connection(name: string): Connection {
    const connection = this.connections.get(name)
    if (!connection) {
      throw new Error(`database '${name}' is not open`)
    }
    return connection
  }

  private prepared(connection: Connection, sql: string): PreparedStatement {
    let statement = connection.statements.get(sql)
    if (!statement) {
      statement = connection.db.prepare(sql)
      connection.statements.set(sql, statement)
    } else {
      statement.reset()
      statement.clearBindings()
    }
    return statement
  }

  private closeConnection(connection: Connection): void {
    for (const statement of connection.statements.values()) {
      statement.finalize()
    }
    connection.statements.clear()
    connection.db.close()
  }

  async open(name: string, storage: 'opfs' | 'memory'): Promise<{ userVersion: number }> {
    if (this.connections.has(name)) {
      throw new Error(`database '${name}' is already open`)
    }
    let db: Database
    if (storage === 'opfs') {
      if (!this.poolUtil) {
        try {
          this.poolUtil = await this.sqlite3.installOpfsSAHPoolVfs({
            initialCapacity: 32, // db + journal per open database
          })
        } catch (error) {
          throw new Error(
            `OPFS storage is unavailable here (${String(error)}) — ` +
              `pass storage: 'memory' if non-persistent storage is intended`,
          )
        }
      }
      db = new this.poolUtil.OpfsSAHPoolDb(name)
    } else {
      db = new this.sqlite3.oo1.DB(':memory:', 'c')
    }
    const connection: Connection = { db, statements: new Map(), storage }
    this.connections.set(name, connection)
    const userVersion = Number(db.selectValue('pragma user_version') ?? 0)
    return { userVersion }
  }

  handle(request: WorkerRequest): unknown {
    switch (request.op) {
      case 'close': {
        this.closeConnection(this.connection(request.name))
        this.connections.delete(request.name)
        return null
      }
      case 'query': {
        const connection = this.connection(request.name)
        const statement = this.prepared(connection, request.sql)
        bind(statement, request.args)
        const columns = statement.getColumnNames()
        const rows: Record<string, SqlValue>[] = []
        while (statement.step()) {
          const values = statement.get([]) as unknown[]
          const row: Record<string, SqlValue> = {}
          columns.forEach((column, index) => {
            row[column] = fromColumn(values[index])
          })
          rows.push(row)
        }
        statement.reset()
        return rows
      }
      case 'execute': {
        const connection = this.connection(request.name)
        const statement = this.prepared(connection, request.sql)
        bind(statement, request.args)
        statement.step()
        statement.reset()
        return null
      }
      case 'executeBatch': {
        const connection = this.connection(request.name)
        const { db } = connection
        db.exec('begin')
        try {
          for (const [sql, argSets] of request.statements) {
            const statement = this.prepared(connection, sql)
            for (const args of argSets) {
              statement.reset()
              statement.clearBindings()
              bind(statement, args)
              statement.step()
            }
            statement.reset()
          }
        } catch (error) {
          db.exec('rollback')
          throw error
        }
        db.exec('commit')
        return null
      }
      case 'setUserVersion': {
        const version = request.version
        if (!Number.isInteger(version) || version < 0) {
          throw new Error(`invalid user_version ${version}`)
        }
        this.connection(request.name).db.exec(`pragma user_version = ${version}`)
        return null
      }
      case 'destroy': {
        const connection = this.connections.get(request.name)
        const storage = connection?.storage
        if (connection) {
          this.closeConnection(connection)
          this.connections.delete(request.name)
        }
        if (storage === 'opfs' && this.poolUtil) {
          // pool filenames are absolute ('/name'), plus journal sidecars
          for (const file of this.poolUtil.getFileNames()) {
            if (file === `/${request.name}` || file.startsWith(`/${request.name}-`)) {
              this.poolUtil.unlink(file)
            }
          }
        }
        return null
      }
      case 'open':
        throw new Error('open is handled asynchronously') // see serve()
    }
  }
}

/**
 * Wire a server to an endpoint. Requests arriving before sqlite-wasm has
 * loaded are answered once it has (promise chaining preserves order).
 */
export function serveSqliteWorker(
  endpoint: Endpoint,
  loadSqlite: () => Promise<Sqlite3Static>,
): void {
  const serverPromise = loadSqlite().then(
    (sqlite3) => new SqliteWorkerServer(sqlite3),
  )
  endpoint.addMessageListener((message) => {
    const request = message as WorkerRequest
    void serverPromise
      .then(async (server) => {
        const result =
          request.op === 'open'
            ? await server.open(request.name, request.storage)
            : server.handle(request)
        const response: WorkerResponse = { id: request.id, ok: true, result }
        endpoint.postMessage(response)
      })
      .catch((error: unknown) => {
        const response: WorkerResponse = {
          id: request.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }
        endpoint.postMessage(response)
      })
  })
}
