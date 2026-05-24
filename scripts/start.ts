#!/usr/bin/env tsx
import { runCli } from './cihub-cli';

runCli(process.argv.slice(2)).catch((error) => {
  console.error('ci-hub cli failed', error);
  process.exit(1);
});
