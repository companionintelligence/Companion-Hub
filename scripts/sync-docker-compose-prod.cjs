#!/usr/bin/env node
/**
 * Copies the canonical docker-compose.prod.yml into the Tauri desktop bundle.
 * Run before desktop build and in CI to prevent drift.
 */
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const source = path.join(repoRoot, 'docker-compose.prod.yml');
const target = path.join(repoRoot, 'packages/desktop/src-tauri/resources/docker-compose.prod.yml');

fs.copyFileSync(source, target);
console.log(`Synced ${path.relative(repoRoot, source)} → ${path.relative(repoRoot, target)}`);
