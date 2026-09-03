#!/usr/bin/env tsx
import { runCli } from './lib/cli-dispatch.js';

runCli(process.argv.slice(2)).catch((error) => {
  console.error('ci-hub cli failed', error);
  process.exit(1);
});
