// Derives each package's publishConfig.exports and tsdown entry list from
// its `exports` map, so a subpath added in one place cannot be forgotten in
// the others (the way @remelondb/core/react was missing from 0.1.0).
//
//   node scripts/sync-exports.mjs          rewrite package.json files
//   node scripts/sync-exports.mjs --check  exit 1 if anything would change
//
// Convention this enforces: every exports value is ./src/<path>.ts, and
// publishes as ./dist/<path>.{mjs,d.mts}. tsdown configs read their entry
// list from package.json exports, so they need no generation.

import { readFileSync, writeFileSync, globSync } from 'node:fs';

const check = process.argv.includes('--check');
let drift = 0;

for (const path of globSync('packages/*/package.json').sort()) {
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  const publishExports = {};
  for (const [subpath, src] of Object.entries(pkg.exports)) {
    const m = /^\.\/src\/(.+)\.ts$/.exec(src);
    if (!m) {
      console.error(
        `${path}: exports["${subpath}"] = "${src}" does not match ./src/**/*.ts`,
      );
      process.exit(1);
    }
    const dist = `./dist/${m[1]}`;
    // dualFormat packages (tsdown format esm+cjs) publish a require pair so
    // CommonJS consumers get declarations that resolve peers in require mode.
    publishExports[subpath] = pkg.dualFormat
      ? {
          import: { types: `${dist}.d.mts`, default: `${dist}.mjs` },
          require: { types: `${dist}.d.cts`, default: `${dist}.cjs` },
        }
      : {
          types: `${dist}.d.mts`,
          import: `${dist}.mjs`,
          default: `${dist}.mjs`,
        };
  }
  const before = JSON.stringify(pkg.publishConfig.exports);
  const after = JSON.stringify(publishExports);
  if (before !== after) {
    drift += 1;
    if (check) {
      console.error(
        `${path}: publishConfig.exports is out of sync with exports`,
      );
    } else {
      pkg.publishConfig.exports = publishExports;
      writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
      console.log(`${path}: publishConfig.exports rewritten`);
    }
  }
}

if (check && drift) process.exit(1);
console.log(
  check ? 'publishConfig.exports in sync' : `done (${drift} file(s) changed)`,
);
