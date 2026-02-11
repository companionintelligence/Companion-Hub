#!/usr/bin/env bun
/**
 * Pre-pull Docker images during off-peak hours
 *
 * Run this overnight to avoid Docker Hub rate limits during testing
 * Usage: BATCH=0 bun run scripts/prepull-images.ts
 */

import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP_STORE_DIR = process.env.APP_STORE_DIR || join(process.env.HOME || '~', 'devel/CI-App-Store/apps');
const BATCH = Number.parseInt(process.env.BATCH || '0', 10);
const TOTAL_BATCHES = Number.parseInt(process.env.TOTAL_BATCHES || '7', 10);

// Get all apps
const allApps = readdirSync(APP_STORE_DIR)
  .filter((f) => existsSync(join(APP_STORE_DIR, f, 'config.json')))
  .filter((f) => !f.startsWith('_'))
  .sort();

// Calculate batch
const batchSize = Math.ceil(allApps.length / TOTAL_BATCHES);
const startIdx = BATCH * batchSize;
const endIdx = Math.min(startIdx + batchSize, allApps.length);
const batchApps = allApps.slice(startIdx, endIdx);

console.log('╔════════════════════════════════════════════════════════════╗');
console.log(`║  Pre-pulling Docker Images - Batch ${BATCH}                      ║`);
console.log('╚════════════════════════════════════════════════════════════╝\n');
console.log(`Total apps: ${allApps.length}`);
console.log(`Batch ${BATCH}: apps ${startIdx + 1} to ${endIdx} (${batchApps.length} apps)\n`);

let pulled = 0;
let failed = 0;
let skipped = 0;

for (const appId of batchApps) {
  try {
    // Get image from docker-compose.json
    const composeJsonPath = join(APP_STORE_DIR, appId, 'docker-compose.json');
    const composeYmlPath = join(APP_STORE_DIR, appId, 'docker-compose.yml');

    let image: string | null = null;

    if (existsSync(composeJsonPath)) {
      const compose = JSON.parse(readFileSync(composeJsonPath, 'utf-8'));
      const mainService = compose.services?.find((s: { isMain?: boolean }) => s.isMain) || compose.services?.[0];
      image = mainService?.image;
    } else if (existsSync(composeYmlPath)) {
      const content = readFileSync(composeYmlPath, 'utf-8');
      const match = content.match(/image:\s*(.+)/);
      image = match ? match[1].trim() : null;
    }

    if (!image || image.includes('<') || image === 'null') {
      console.log(`⏭️  ${appId}: No valid image, skipping`);
      skipped++;
      continue;
    }

    // Check if already exists
    try {
      execSync(`docker image inspect ${image} 2>/dev/null`, { stdio: 'pipe' });
      console.log(`✅ ${appId}: Already have ${image}`);
      skipped++;
      continue;
    } catch {
      // Image not found, pull it
    }

    console.log(`📥 ${appId}: Pulling ${image}...`);

    try {
      execSync(`docker pull ${image}`, {
        stdio: 'inherit',
        timeout: 300000, // 5 min max per image
      });
      pulled++;
      console.log('   ✓ Pulled');
    } catch (_e) {
      failed++;
      console.log('   ✗ Failed to pull');
    }

    // Small delay to avoid rate limits
    await Bun.sleep(1000);
  } catch (_e) {
    console.log(`❌ ${appId}: Error - ${e}`);
    failed++;
  }
}

console.log('\n════════════════════════════════════════════════════════════');
console.log('PRE-PULL COMPLETE');
console.log('════════════════════════════════════════════════════════════');
console.log(`Pulled: ${pulled} | Skipped: ${skipped} | Failed: ${failed}`);
