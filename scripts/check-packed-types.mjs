// Typechecks the committed fixtures in scripts/fixtures/packed-types
// against the PACKED tarballs' public declarations — what an npm
// consumer's tsc actually sees. The in-repo typecheck resolves
// workspace source, so d.ts-only breakage (a lost overload, a widened
// generic, broken export metadata) is invisible to it; this is the
// check that would have caught the select-inference regression at the
// public boundary.
//
// Run: node scripts/check-packed-types.mjs <tarball-dir>
// (pack first: pnpm -r --filter './packages/*' pack --pack-destination <dir>)
import { execFileSync } from 'node:child_process';
import { findPackageJSON } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const tarballDir = process.argv[2];
if (!tarballDir) {
  console.error('usage: node scripts/check-packed-types.mjs <tarball-dir>');
  process.exit(1);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Every packed package the fixtures can typecheck without a framework
// stack. Not covered here, and deliberately so: the RN drivers (their
// declarations need react-native's types — the RN harness lane consumes
// them packed) and the nestjs module (needs the Nest type stack).
const WANTED = [
  'remelondb-core-',
  'remelondb-driver-node-',
  'remelondb-driver-web-',
  'remelondb-server-',
  'remelondb-store-drizzle-',
];
const files = readdirSync(tarballDir);
const tarballs = WANTED.map((prefix) => {
  const matches = files.filter(
    (f) => f.startsWith(prefix) && f.endsWith('.tgz'),
  );
  if (matches.length !== 1) {
    // zero = pack failed; two = a stale tarball from an earlier local
    // run is still in the directory and versions would be ambiguous
    console.error(
      `expected exactly one ${prefix}*.tgz in ${tarballDir}, found ${matches.length}: ${matches.join(', ')}`,
    );
    process.exit(1);
  }
  return join(resolve(tarballDir), matches[0]);
});

const dir = mkdtempSync(join(tmpdir(), 'packed-types-'));
try {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'packed-types', private: true }, null, 2),
  );
  // --ignore-scripts: declarations only, no native builds. Peer
  // versions are the EXACT versions installed in this workspace
  // (resolved through node_modules, i.e. the lockfile's choice), so the
  // check is reproducible and tracks the repo toolchain — a manifest
  // range here would let a fresh upstream release fail CI without any
  // remelondb change.
  const installedVersion = (name, from) => {
    // findPackageJSON works regardless of the package's exports map
    // (typescript, for one, does not expose its package.json)
    const pj = findPackageJSON(name, pathToFileURL(join(root, from, 'x.js')));
    if (!pj) throw new Error(`cannot resolve ${name} from ${from}`);
    return `${name}@${JSON.parse(readFileSync(pj, 'utf8')).version}`;
  };
  const peers = [
    installedVersion('typescript', '.'),
    installedVersion('vitest', '.'),
    installedVersion('@types/node', '.'),
    installedVersion('drizzle-orm', 'packages/store-drizzle'),
    installedVersion('react', 'packages/core'),
    installedVersion('@types/react', 'packages/core'),
    installedVersion('zod', 'packages/core'),
  ];
  execFileSync(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      ...tarballs,
      ...peers,
    ],
    { cwd: dir, stdio: 'inherit' },
  );
  cpSync(join(root, 'scripts/fixtures/packed-types'), dir, { recursive: true });
  // Two projects: the base checks every remelondb d.ts with a full lib
  // check (skipLibCheck off); the drizzle fixture runs separately with
  // skipLibCheck because drizzle-orm's own published d.ts cannot pass
  // one (see tsconfig.drizzle.json).
  execFileSync('npx', ['tsc', '--noEmit', '-p', join(dir, 'tsconfig.json')], {
    cwd: dir,
    stdio: 'inherit',
  });
  execFileSync(
    'npx',
    ['tsc', '--noEmit', '-p', join(dir, 'tsconfig.drizzle.json')],
    { cwd: dir, stdio: 'inherit' },
  );
  // and once more in require mode (see tsconfig.drizzle-cjs.json)
  execFileSync(
    'npx',
    ['tsc', '--noEmit', '-p', join(dir, 'tsconfig.drizzle-cjs.json')],
    { cwd: dir, stdio: 'inherit' },
  );
  console.log(
    'PACKED TYPES CHECK: PASS { core (+react/zod/conformance), server (+conformance), driver-node, driver-web, store-drizzle (esm+cjs) }',
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
