#!/usr/bin/env tsx
/**
 * Cleanup all CI-Hub runtime resources (containers, volumes, and local state).
 *
 * Usage:
 *   pnpm exec tsx scripts/cleanup.ts
 */

import { runHubCleanup } from './hub-cleanup-lib';

console.log('🧹 Starting cleanup of CI-Hub resources...\n');
const summary = runHubCleanup();

console.log('\n✅ Cleanup complete!');
console.log('\n📝 Summary:');
console.log(`   - Directories removed: ${summary.removedDirs}`);
console.log(`   - Directories skipped: ${summary.skippedDirs}`);
console.log(`   - Directory failures: ${summary.failedDirs}`);
console.log(`   - Commands attempted: ${summary.attemptedCommands}`);
console.log(`   - Command failures: ${summary.failedCommands}`);
