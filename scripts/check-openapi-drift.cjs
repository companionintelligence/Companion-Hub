#!/usr/bin/env node
/**
 * CI gate: fail if committed swagger.json drifts from Nest-generated OpenAPI.
 * Usage: node scripts/check-openapi-drift.cjs
 */
const { execSync } = require('node:child_process');
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

console.log('openapi drift check passed');
