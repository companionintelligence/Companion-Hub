#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { dirname, join, resolve } = require('node:path');

const tsxRoot = dirname(require.resolve('tsx/package.json'));
const tsxCli = join(tsxRoot, 'dist/cli.mjs');
const entrypoint = resolve(__dirname, '../scripts/start.ts');
const result = spawnSync(process.execPath, [tsxCli, entrypoint, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error('Failed to launch cihub:', result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
