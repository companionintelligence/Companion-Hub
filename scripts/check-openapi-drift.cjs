#!/usr/bin/env node
/**
 * CI gate: fail if committed swagger.json drifts from Nest-generated OpenAPI, or if the committed
 * frontend API client differs from what `pnpm run gen:api-client` writes from that swagger.json.
 * The client half catches a swagger change nobody regenerated, a hand edit, a generator bump and
 * a generator that no longer runs (TypeScript 7 reaching the repo root).
 * Usage: node scripts/check-openapi-drift.cjs
 */
const { execFileSync, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const swaggerPath = path.join(repoRoot, 'packages/backend/src/swagger.json');
const committed = fs.readFileSync(swaggerPath, 'utf8');

process.chdir(repoRoot);
execSync('pnpm --filter backend run gen:swagger', { stdio: 'inherit' });

const generated = fs.readFileSync(swaggerPath, 'utf8');
if (committed !== generated) {
  console.error('openapi drift: packages/backend/src/swagger.json is out of date. Run pnpm gen:swagger and commit.');
  process.exit(1);
}

const clientDir = 'packages/frontend/src/api-client';
const clientFix = 'run pnpm run gen:api-client and commit the result';
const clientChanges = () => execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', clientDir], { encoding: 'utf8' }).trimEnd();

// The generator empties the folder before it writes, so it only runs over a client that matches the
// commit. Uncommitted work there is reported and left alone.
const uncommitted = clientChanges();
if (uncommitted) {
  console.error(`openapi drift: ${clientDir} differs from the commit:\n${uncommitted}\nTo fix it, ${clientFix}.`);
  process.exit(1);
}

try {
  execSync('pnpm run gen:api-client', { stdio: 'inherit' });
} catch {
  // A generator that fails after emptying the folder leaves it half written. It matched the commit a
  // moment ago, so putting the committed files back loses nothing.
  execFileSync('git', ['checkout', '--', clientDir]);
  console.error(`openapi drift: pnpm run gen:api-client failed, so ${clientDir} can't be checked. Fix the generator, then ${clientFix}.`);
  process.exit(1);
}

const stale = clientChanges();
if (stale) {
  console.error(
    `openapi drift: ${clientDir} is not what the generator writes from swagger.json. The regenerated files are left in place:\n${stale}\nTo fix it, ${clientFix}.`,
  );
  process.exit(1);
}

console.log('openapi drift check passed');
