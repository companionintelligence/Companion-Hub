#!/usr/bin/env node
/**
 * CI gate: fail if committed swagger.json drifts from Nest-generated OpenAPI, or if the frontend
 * API client differs from what `pnpm run gen:api-client` writes from that swagger.json.
 * The client half catches a swagger change nobody regenerated, a hand edit, a generator bump and
 * a generator that no longer runs (TypeScript 7 reaching the repo root).
 * Usage: node scripts/check-openapi-drift.cjs
 */
const { execFileSync, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
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

/** Relative paths of every file under `dir`. */
const walk = (dir, prefix = '') =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = path.posix.join(prefix, entry.name);
    return entry.isDirectory() ? walk(path.join(dir, entry.name), rel) : [rel];
  });

/** The client's files as git sees them: tracked or untracked, never ignored (a stray .DS_Store doesn't count). */
const clientFiles = () =>
  execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', clientDir], { encoding: 'utf8' })
    .split('\0')
    .filter((file) => file && fs.existsSync(file))
    .map((file) => path.posix.relative(clientDir, file));

/** Generates into a temp folder and lists what differs from the client folder. Never writes to the tree. */
const checkClient = () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-hub-api-client-'));
  try {
    try {
      execSync(`pnpm run gen:api-client -o ${JSON.stringify(out)} --no-log-file`, { stdio: 'inherit' });
    } catch {
      return { failed: true };
    }
    const expected = new Set(walk(out));
    const actual = new Set(clientFiles());
    const differences = [];
    for (const file of [...new Set([...expected, ...actual])].sort()) {
      if (!actual.has(file)) differences.push(`missing: ${file}`);
      else if (!expected.has(file)) differences.push(`not generated: ${file}`);
      else if (!fs.readFileSync(path.join(out, file)).equals(fs.readFileSync(path.join(clientDir, file)))) differences.push(`differs: ${file}`);
    }
    return { differences };
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
};

const result = checkClient();
if (result.failed) {
  console.error(`openapi drift: pnpm run gen:api-client failed, so ${clientDir} can't be checked. Fix the generator, then ${clientFix}.`);
  process.exit(1);
}
if (result.differences.length > 0) {
  console.error(`openapi drift: ${clientDir} is not what the generator writes from swagger.json:`);
  for (const line of result.differences) console.error(`  ${line}`);
  console.error(`To fix it, ${clientFix}.`);
  process.exit(1);
}

console.log('openapi drift check passed');
