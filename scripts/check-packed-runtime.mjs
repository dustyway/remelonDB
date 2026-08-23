// Consumes the packed tarballs from a plain npm project in Node — no
// workspace, no pnpm, real installs — and runs a full local write/query
// plus a sync round-trip. Moved verbatim out of the pack-consume job's
// inline shell so it can run locally.
//
// Run: node scripts/check-packed-runtime.mjs <tarball-dir>
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tarballDir = process.argv[2];
if (!tarballDir) {
  console.error('usage: node scripts/check-packed-runtime.mjs <tarball-dir>');
  process.exit(1);
}
const find = (prefix) => {
  const matches = readdirSync(tarballDir).filter(
    (f) => f.startsWith(prefix) && f.endsWith('.tgz'),
  );
  if (matches.length !== 1) {
    // two matches = a stale tarball from an earlier local run; picking
    // one silently would test an arbitrary version
    console.error(
      `expected exactly one ${prefix}*.tgz in ${tarballDir}, found ${matches.length}`,
    );
    process.exit(1);
  }
  return join(resolve(tarballDir), matches[0]);
};
const core = find('remelondb-core-');
const nodeDriver = find('remelondb-driver-node-');
const server = find('remelondb-server-');

const MAIN = `
import { appSchema, column as c, table, Database, ModelFor, Q } from '@remelondb/core'
import { NodeSqliteDriver } from '@remelondb/driver-node'
import { zodTable, syncSchemas } from '@remelondb/core/zod'
import { createSyncEngine, createMemoryStore } from '@remelondb/server'
import { z } from 'zod'

const tasks = table('tasks', { name: c.string() })
const schema = appSchema({ version: 1, tables: [tasks] })
class Task extends ModelFor(tasks) {}
const db = await Database.open({ driver: new NodeSqliteDriver(), schema, modelClasses: [Task], name: ':memory:' })
await db.write(() => db.get(Task).create({ name: 'ci' }))
const rows = await db.get(Task).query(Q.where('name', 'ci')).fetch()
if (rows.length !== 1) throw new Error('tarball consumption failed')

const Item = z.object({ name: z.string() })
const items = zodTable('items', Item)
if (items.columns.name.type !== 'string') throw new Error('zodTable failed')
const engine = createSyncEngine({ store: createMemoryStore(), tables: { items: {} } })
const h = engine.as('u1')
const first = await h.pull({ cursor: null, schemaVersion: 1, migration: null })
await h.push({ changes: { items: { created: [{ id: 'i1', name: 'hi' }], updated: [], deleted: [] } }, cursor: first.cursor })
const again = await h.pull({ cursor: null, schemaVersion: 1, migration: null })
syncSchemas({ items: Item }).pullResult.parse(again)
if (again.changes.items.updated.length !== 1) throw new Error('server roundtrip failed')
console.log('pack-consume OK')
`;

const dir = mkdtempSync(join(tmpdir(), 'packed-runtime-'));
try {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'consume',
        private: true,
        type: 'module',
        dependencies: {
          '@remelondb/core': `file:${core}`,
          '@remelondb/driver-node': `file:${nodeDriver}`,
          '@remelondb/server': `file:${server}`,
          zod: '^4.0.0',
        },
        overrides: { '@remelondb/core': `file:${core}` },
      },
      null,
      2,
    ),
  );
  // scripts allowed: driver-node's better-sqlite3 needs its native build
  execFileSync('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: dir,
    stdio: 'inherit',
  });
  writeFileSync(join(dir, 'main.mjs'), MAIN);
  execFileSync('node', ['main.mjs'], { cwd: dir, stdio: 'inherit' });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
