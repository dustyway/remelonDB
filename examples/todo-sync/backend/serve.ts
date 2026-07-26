import { createServer } from 'node:http'
import { text } from 'node:stream/consumers'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSyncEngine } from '@remelondb/server'
import { wire } from './schema'
import { createStore } from './store'

// Deployment entry: the same two sync routes as server.ts plus static
// serving of the built web client, one process on one port. server.ts
// stays the didactic minimum; read that first.

const dist =
  process.env['DIST'] ?? fileURLToPath(new URL('../frontend/dist', import.meta.url))
const port = Number(process.env['PORT'] ?? 8787)

const engine = createSyncEngine({
  store: await createStore(),
  tables: {
    todos: { validate: (row) => wire.rows['todos']!.safeParse(row).success },
  },
})
const handlers = engine.as('everyone')

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
}

const server = createServer(async (request, response) => {
  const respond = (status: number, body: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }
  try {
    if (request.method === 'POST') {
      const body: unknown = JSON.parse(await text(request))
      if (request.url === '/sync/pull') {
        return respond(200, await handlers.pull(wire.pullArgs.parse(body)))
      }
      if (request.url === '/sync/push') {
        return respond(200, await handlers.push(wire.pushArgs.parse(body)))
      }
      return respond(404, { error: 'POST /sync/pull or /sync/push' })
    }
    if (request.method !== 'GET') {
      return respond(404, { error: 'GET a file, or POST /sync/*' })
    }
    const pathname = new URL(request.url ?? '/', 'http://x').pathname
    // normalize collapses any ../ before the join leaves dist
    const file = join(dist, normalize(pathname === '/' ? '/index.html' : pathname))
    if (!file.startsWith(dist)) {
      return respond(404, { error: 'not found' })
    }
    try {
      const content = await readFile(file)
      response.writeHead(200, {
        'content-type': contentTypes[extname(file)] ?? 'application/octet-stream',
        // Vite emits hashed asset names — safe to cache hard; index.html is not hashed
        'cache-control': file.includes('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      })
      return response.end(content)
    } catch {
      return respond(404, { error: 'not found' })
    }
  } catch (error) {
    return respond(400, { error: error instanceof Error ? error.message : String(error) })
  }
})

server.listen(port, () => {
  console.log(`todo-sync serving ${dist} and /sync on :${port}`)
})
