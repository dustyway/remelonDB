// Executable check for docs/backend-tutorial.md: extracts the ```js
// blocks at runtime and executes them, in order, against the built
// workspace packages — the markdown is the single source. Blocks fenced
// ```js fragment (the NestJS mounting) are illustrative and skipped;
// the store, engine, and sync round trip run for real against Postgres:
// DATABASE_URL if set (CI provides a service container), otherwise the
// tutorial's own docker fallback on localhost:5433.
//
// The assembled module lives inside packages/store-drizzle so pg and
// drizzle-orm resolve from that package's dependencies; the mapped
// @remelondb/* specifiers resolve to built dist files.
//
// Run: pnpm build && node scripts/check-backend-tutorial.mjs
import { readFile, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const MODULES = {
  '@remelondb/core': new URL('../packages/core/dist/index.mjs', import.meta.url)
    .href,
  '@remelondb/core/zod': new URL(
    '../packages/core/dist/zod/index.mjs',
    import.meta.url,
  ).href,
  '@remelondb/server': new URL(
    '../packages/server/dist/index.mjs',
    import.meta.url,
  ).href,
  '@remelondb/store-drizzle': new URL(
    '../packages/store-drizzle/dist/index.mjs',
    import.meta.url,
  ).href,
  zod: import.meta.resolve('zod'),
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = MODULES[specifier];
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
});

// --- extract ```js blocks (skip ```js fragment) ---
const markdown = await readFile(
  new URL('../docs/backend-tutorial.md', import.meta.url),
  'utf8',
);
const blocks = [];
let fragments = 0;
let current = null;
for (const line of markdown.split('\n')) {
  if (current === null) {
    if (line.trim() === '```js') current = [];
    else if (line.trim() === '```js fragment') fragments++;
  } else if (line.trim() === '```') {
    blocks.push(current.join('\n'));
    current = null;
  } else {
    current.push(line);
  }
}
if (blocks.length === 0) throw new Error('no ```js blocks found');

// --- merge imports, rewrite sources, collect bodies ---
const IMPORT_RE = /^import\s*\{([^}]*)\}\s*from\s*'([^']+)'\s*$/;
const specifiersByModule = new Map();
const localNames = new Map();
const addSpecifier = (module_, spec) => {
  const url = MODULES[module_] ?? module_; // unmapped bare specifiers resolve from the package
  const set = specifiersByModule.get(url) ?? new Set();
  specifiersByModule.set(url, set);
  const local = spec.includes(' as ') ? spec.split(' as ')[1].trim() : spec;
  const existing = localNames.get(local);
  if (existing && existing !== `${module_}:${spec}`) {
    throw new Error(`conflicting imports for local name '${local}'`);
  }
  localNames.set(local, `${module_}:${spec}`);
  set.add(spec);
};
const bodies = blocks.map((block) =>
  block
    .split('\n')
    .filter((line) => {
      const match = line.match(IMPORT_RE);
      if (!match) return true;
      for (const spec of match[1].split(',')) {
        const trimmed = spec.trim();
        if (trimmed) addSpecifier(match[2], trimmed);
      }
      return false;
    })
    .join('\n'),
);
const imports = [...specifiersByModule]
  .map(([url, specs]) => `import { ${[...specs].join(', ')} } from '${url}'`)
  .join('\n');

const ASSERTIONS = `
// --- assertions (appended by scripts/check-backend-tutorial.mjs) ---
const assert = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg) }
assert(first.cursor === '0', 'empty pull cursor: ' + first.cursor)
assert(!('conflict' in pushed), 'push conflicted')
assert(pushed.cursor === '1', 'push cursor: ' + pushed.cursor)
const seen = secondDevice.changes.tasks.updated.map((row) => row.id)
assert(seen.length === 1 && seen[0] === 'task-1', 'second device saw: ' + seen)
assert(afterDelete.changes.tasks.deleted.includes('task-1'), 'tombstone not delivered')
const raw = await pool.query("select deleted_at, rev from tasks where id = 'task-1'")
assert(raw.rows[0].deleted_at !== null, 'row not tombstoned in postgres')
assert(Number(raw.rows[0].rev) > 1, 'tombstone rev not bumped')
const graceRows = [
  ...(grace.changes.tasks?.created ?? []),
  ...(grace.changes.tasks?.updated ?? []),
  ...(grace.changes.tasks?.deleted ?? []),
]
assert(graceRows.length === 0, 'scope leaked: ' + graceRows.length)
await pool.end()
globalThis.__backendTutorialPassed = { blocks: ${blocks.length} }
`;

const assembled = [
  '// AUTO-ASSEMBLED from docs/backend-tutorial.md — do not edit',
  imports,
  ...bodies,
  ASSERTIONS,
].join('\n');

const file = new URL(
  '../packages/store-drizzle/backend-tutorial.assembled.mjs',
  import.meta.url,
);
await writeFile(file, assembled);
try {
  await import(pathToFileURL(file.pathname).href);
} catch (error) {
  console.error(`assembled module kept at ${file.pathname} for inspection`);
  throw error;
}
await rm(file, { force: true });
console.log('BACKEND TUTORIAL CHECK: PASS', {
  blocksRun: blocks.length,
  fragmentsSkipped: fragments,
  ...globalThis.__backendTutorialPassed,
});
