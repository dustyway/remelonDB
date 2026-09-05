// Structural consistency check for docs/codebase-guide.md.
//
// This deliberately checks durable facts rather than prose style: release
// version, navigation counts, checkpoint coverage, repository paths, and a
// small set of public API entries that have drifted before.

import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const guidePath = resolve(root, 'docs/codebase-guide.md');
const packagePath = resolve(root, 'package.json');
const [guide, packageText] = await Promise.all([
  readFile(guidePath, 'utf8'),
  readFile(packagePath, 'utf8'),
]);
const pkg = JSON.parse(packageText);
const failures = [];

const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

const metadataVersion = guide.match(
  /^version:\s*['"]([^'" ·]+)[^'"\n]*['"]/m,
)?.[1];
// The cover date (pandoc's standard `date`, rendered on the title page)
// must match the version stamp's date part, or the two drift apart.
const coverDate = guide.match(/^date:\s*['"]([^'"]+)['"]/m)?.[1];
const versionDate = guide.match(
  /^version:\s*['"][^'"·]*·\s*([^'"\s]+)['"]/m,
)?.[1];
expect(
  coverDate === versionDate,
  `cover date ${coverDate ?? '<missing>'} != version stamp date ${versionDate ?? '<missing>'}`,
);
const proseVersion = guide.match(
  /describes the codebase at version \*\*([^*]+)\*\* or newer/,
)?.[1];
expect(
  metadataVersion === pkg.version,
  `metadata version ${metadataVersion ?? '<missing>'} != package version ${pkg.version}`,
);
expect(
  proseVersion === pkg.version,
  `preface version ${proseVersion ?? '<missing>'} != package version ${pkg.version}`,
);

const topHeadings = [...guide.matchAll(/^# (.+)$/gm)].map((match) => match[1]);
const chapters = topHeadings.filter(
  (heading) =>
    !heading.includes('{.unnumbered}') && !heading.startsWith('Appendix '),
);
const appendices = topHeadings.filter((heading) =>
  heading.startsWith('Appendix '),
);
const checkpoints = [...guide.matchAll(/^## Checkpoint$/gm)].length;
const answered = new Set(
  [...guide.matchAll(/^\*\*Ch\. (\d+)\.\*\*/gm)].map((match) =>
    Number(match[1]),
  ),
);

expect(
  chapters.length === 15,
  `expected 15 numbered chapters, found ${chapters.length}`,
);
expect(
  checkpoints === chapters.length,
  `expected one checkpoint per chapter (${chapters.length}), found ${checkpoints}`,
);
for (let chapter = 1; chapter <= chapters.length; chapter += 1) {
  expect(
    answered.has(chapter),
    `Appendix D is missing answers for Chapter ${chapter}`,
  );
}
expect(
  appendices.length === 6,
  `expected 6 appendices, found ${appendices.length}`,
);
expect(
  /Six appendices follow:/.test(guide),
  'preface must say that six appendices follow',
);
expect(
  /Part VI \(Chapter 15\)/.test(guide),
  'preface navigation must include Part VI / Chapter 15',
);

const requiredApiText = [
  'init(), close(), subscribe()',
  'useQueryCountResult(query)',
  'RemelonSyncModule.forRoot(options)',
  'new WebSqliteDriver(options?)',
];
for (const text of requiredApiText) {
  expect(guide.includes(text), `public API appendix is missing: ${text}`);
}

const forbiddenClaims = [
  'a `db.write` block compiles to one atomic batch',
  'The `db.write` block is the bracket around one',
  'run it inside a transaction: everything inside either takes effect together or not at all',
];
for (const claim of forbiddenClaims) {
  expect(
    !guide.includes(claim),
    `stale db.write atomicity claim remains: ${claim}`,
  );
}

const fragileLineRefs = [
  ...guide.matchAll(/`([^`\n]+\.tsx?):\d+(?:-\d+|\+)?`/g),
];
expect(
  fragileLineRefs.length === 0,
  `fragile source line references remain: ${fragileLineRefs.map((match) => match[0]).join(', ')}`,
);

const referencedPaths = new Set();
for (const match of guide.matchAll(
  /`((?:packages|docs|scripts)\/[A-Za-z0-9_./-]+)`/g,
)) {
  referencedPaths.add(match[1].replace(/[.,;:]$/, ''));
}
for (const path of referencedPaths) {
  try {
    await access(resolve(root, path));
  } catch {
    failures.push(`referenced repository path does not exist: ${path}`);
  }
}

if (failures.length > 0) {
  console.error('CODEBASE GUIDE CHECK: FAIL');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `CODEBASE GUIDE CHECK: PASS (${chapters.length} chapters, ${appendices.length} appendices, ${referencedPaths.size} paths)`,
  );
}
