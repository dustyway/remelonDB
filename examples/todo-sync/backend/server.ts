import { createServer } from 'node:http';
import { text } from 'node:stream/consumers';
import { createSyncEngine } from '@remelondb/server';
import { wire } from './schema';
import { createStore } from './store';

// The entire backend. The sync engine owns every protocol semantic
// (cursors, conflicts, rejection, the interleave); the store keeps rows
// in memory; this file only wires two routes in the canonical HTTP
// binding: every protocol outcome is an HTTP 200 with the variant in
// the body, and only a malformed request is a 400. One shared scope —
// this demo has no accounts, every browser shares the list.

const engine = createSyncEngine({
  store: await createStore(),
  tables: {
    todos: {
      validate: (row) => wire.localRows['todos']!.safeParse(row).success,
    },
  },
});
const handlers = engine.as('everyone');

const server = createServer(async (request, response) => {
  const respond = (status: number, body: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  try {
    if (request.method !== 'POST') {
      return respond(404, { error: 'POST /sync/pull or /sync/push' });
    }
    const body: unknown = JSON.parse(await text(request));
    if (request.url === '/sync/pull') {
      return respond(
        200,
        wire.pullResult.encode(await handlers.pull(wire.pullArgs.parse(body))),
      );
    }
    if (request.url === '/sync/push') {
      return respond(
        200,
        wire.pushResult.encode(await handlers.push(wire.pushArgs.parse(body))),
      );
    }
    return respond(404, { error: 'unknown route' });
  } catch (error) {
    return respond(400, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(8787, () => {
  console.log('todo-sync server: http://localhost:8787');
});
