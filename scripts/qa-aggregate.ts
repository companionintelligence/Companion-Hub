#!/usr/bin/env bun
/**
 * Aggregate QA Results from Fleet
 *
 * Collects results from all fleet servers via SSH and generates a unified report.
 *
 * Usage:
 *   bun run scripts/qa-aggregate.ts
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FLEET = [
  { name: 'core-1', ip: '100.108.17.53', batch: 0 },
  { name: 'core-2', ip: '100.101.156.33', batch: 1 },
  { name: 'core-3', ip: '100.108.125.105', batch: 2 },
  { name: 'core-4', ip: '100.76.114.122', batch: 3 },
  { name: 'core-5', ip: '100.118.2.90', batch: 4 },
  { name: 'core-6', ip: '100.95.23.128', batch: 5 },
  { name: 'core-7', ip: '100.74.95.94', batch: 6 },
];

const SSH_USER = 'ci';
const LOCAL_RESULTS = './qa-aggregate';

interface QAResult {
  appId: string;
  name: string;
  image: string;
  port: number;
  imageSizeMb: number;
  pullTimeMs: number;
  startupMs: number;
  responseTimeMs: number;
  memoryMb: number;
  memoryPeakMb: number;
  cpuPercent: number;
  httpStatus: number;
  screenshotPath: string | null;
  score: 'pass' | 'warn' | 'fail';
  notes: string;
  timestamp: string;
}

interface BatchSummary {
  batch: number;
  total: number;
  passed: number;
  warned: number;
  failed: number;
  passRate: number;
  elapsedMinutes: number;
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  App Store QA - Fleet Aggregator                           ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  // Create local results directory
  if (!existsSync(LOCAL_RESULTS)) mkdirSync(LOCAL_RESULTS, { recursive: true });

  const allResults: QAResult[] = [];
  const batchSummaries: (BatchSummary & { server: string })[] = [];

  // Collect from each server
  for (const server of FLEET) {
    console.log(`\n📥 Collecting from ${server.name} (${server.ip})...`);

    const serverDir = join(LOCAL_RESULTS, server.name);
    if (!existsSync(serverDir)) mkdirSync(serverDir, { recursive: true });

    try {
      // Copy results.json
      execSync(`scp -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${SSH_USER}@${server.ip}:~/qa-results/results.json ${serverDir}/`, {
        stdio: 'pipe',
        timeout: 30000,
      });
      console.log('   ✓ results.json');

      // Copy batch summary
      execSync(`scp -o StrictHostKeyChecking=no ${SSH_USER}@${server.ip}:~/qa-results/batch-${server.batch}-summary.json ${serverDir}/`, {
        stdio: 'pipe',
        timeout: 30000,
      });
      console.log('   ✓ batch summary');

      // Copy screenshots
      execSync(`scp -r -o StrictHostKeyChecking=no ${SSH_USER}@${server.ip}:~/qa-results/screenshots ${serverDir}/`, {
        stdio: 'pipe',
        timeout: 120000,
      });
      console.log('   ✓ screenshots');

      // Parse and merge
      const resultsFile = join(serverDir, 'results.json');
      if (existsSync(resultsFile)) {
        const results = JSON.parse(readFileSync(resultsFile, 'utf-8'));
        allResults.push(...results);
      }

      const summaryFile = join(serverDir, `batch-${server.batch}-summary.json`);
      if (existsSync(summaryFile)) {
        const summary = JSON.parse(readFileSync(summaryFile, 'utf-8'));
        batchSummaries.push({ ...summary, server: server.name });
      }
    } catch (_error) {
      console.log(`   ✗ Failed to collect from ${server.name}`);
    }
  }

  // Calculate totals
  const totalPassed = allResults.filter((r) => r.score === 'pass').length;
  const totalWarned = allResults.filter((r) => r.score === 'warn').length;
  const totalFailed = allResults.filter((r) => r.score === 'fail').length;
  const totalApps = allResults.length;
  const _passRate = totalApps > 0 ? (totalPassed / totalApps) * 100 : 0;

  console.log(`\n${'═'.repeat(60)}`);
  console.log('FLEET RESULTS');
  console.log('═'.repeat(60));
  console.log(`\nTotal apps tested: ${totalApps}`);
  console.log(`✅ Pass: ${totalPassed} (${((totalPassed / totalApps) * 100).toFixed(1)}%)`);
  console.log(`⚠️ Warn: ${totalWarned} (${((totalWarned / totalApps) * 100).toFixed(1)}%)`);
  console.log(`❌ Fail: ${totalFailed} (${((totalFailed / totalApps) * 100).toFixed(1)}%)`);

  // Save merged results
  writeFileSync(join(LOCAL_RESULTS, 'all-results.json'), JSON.stringify(allResults, null, 2));

  // Generate unified report
  let md = '# App Store QA Report\n\n';
  md += `**Date:** ${new Date().toISOString().split('T')[0]}\n`;
  md += `**Total Apps:** ${totalApps}\n\n`;

  md += '## Summary\n\n';
  md += '| Status | Count | Percent |\n|--------|-------|--------|\n';
  md += `| ✅ Pass | ${totalPassed} | ${((totalPassed / totalApps) * 100).toFixed(1)}% |\n`;
  md += `| ⚠️ Warn | ${totalWarned} | ${((totalWarned / totalApps) * 100).toFixed(1)}% |\n`;
  md += `| ❌ Fail | ${totalFailed} | ${((totalFailed / totalApps) * 100).toFixed(1)}% |\n\n`;

  md += '## Server Results\n\n';
  md += '| Server | Batch | Apps | Pass | Warn | Fail | Rate | Time |\n';
  md += '|--------|-------|------|------|------|------|------|------|\n';
  for (const s of batchSummaries) {
    md += `| ${s.server} | ${s.batch} | ${s.total} | ${s.passed} | ${s.warned} | ${s.failed} | ${s.passRate.toFixed(0)}% | ${s.elapsedMinutes.toFixed(0)}m |\n`;
  }
  md += '\n';

  md += `## Failed Apps (${totalFailed})\n\n`;
  const failedApps = allResults.filter((r) => r.score === 'fail').sort((a, b) => a.appId.localeCompare(b.appId));
  if (failedApps.length === 0) {
    md += 'None! 🎉\n\n';
  } else {
    md += '| App | Image | Notes |\n|-----|-------|-------|\n';
    for (const app of failedApps) {
      md += `| ${app.appId} | ${app.image || '-'} | ${app.notes || '-'} |\n`;
    }
    md += '\n';
  }

  md += `## Warnings (${totalWarned})\n\n`;
  const warnedApps = allResults.filter((r) => r.score === 'warn').sort((a, b) => a.appId.localeCompare(b.appId));
  if (warnedApps.length === 0) {
    md += 'None\n\n';
  } else {
    md += '| App | Notes |\n|-----|-------|\n';
    for (const app of warnedApps.slice(0, 50)) {
      // Limit to 50
      md += `| ${app.appId} | ${app.notes || '-'} |\n`;
    }
    if (warnedApps.length > 50) {
      md += `| ... | (${warnedApps.length - 50} more) |\n`;
    }
    md += '\n';
  }

  md += '## Resource Usage\n\n';
  md += '### Top 20 by Memory\n\n';
  const byMemory = [...allResults]
    .filter((r) => r.memoryMb > 0)
    .sort((a, b) => b.memoryMb - a.memoryMb)
    .slice(0, 20);
  md += '| App | Memory | Peak | CPU | Startup | Image Size |\n';
  md += '|-----|--------|------|-----|---------|------------|\n';
  for (const app of byMemory) {
    md += `| ${app.appId} | ${app.memoryMb}MB | ${app.memoryPeakMb}MB | ${app.cpuPercent}% | ${(app.startupMs / 1000).toFixed(1)}s | ${app.imageSizeMb}MB |\n`;
  }
  md += '\n';

  md += '### Slowest to Start (Top 20)\n\n';
  const byStartup = [...allResults]
    .filter((r) => r.startupMs > 0)
    .sort((a, b) => b.startupMs - a.startupMs)
    .slice(0, 20);
  md += '| App | Startup Time | Memory |\n';
  md += '|-----|--------------|--------|\n';
  for (const app of byStartup) {
    md += `| ${app.appId} | ${(app.startupMs / 1000).toFixed(1)}s | ${app.memoryMb}MB |\n`;
  }
  md += '\n';

  md += '### Largest Images (Top 20)\n\n';
  const bySize = [...allResults]
    .filter((r) => r.imageSizeMb > 0)
    .sort((a, b) => b.imageSizeMb - a.imageSizeMb)
    .slice(0, 20);
  md += '| App | Image Size | Memory |\n';
  md += '|-----|------------|--------|\n';
  for (const app of bySize) {
    md += `| ${app.appId} | ${app.imageSizeMb}MB | ${app.memoryMb}MB |\n`;
  }

  writeFileSync(join(LOCAL_RESULTS, 'report.md'), md);
  console.log(`\n📁 Report saved to ${LOCAL_RESULTS}/report.md`);

  // Also save benchmarks JSON
  const benchmarks = allResults.map((r) => ({
    appId: r.appId,
    imageSizeMb: r.imageSizeMb,
    memoryMb: r.memoryMb,
    memoryPeakMb: r.memoryPeakMb,
    cpuPercent: r.cpuPercent,
    startupMs: r.startupMs,
    score: r.score,
  }));

  writeFileSync(join(LOCAL_RESULTS, 'benchmarks.json'), JSON.stringify(benchmarks, null, 2));
  console.log(`📁 Benchmarks saved to ${LOCAL_RESULTS}/benchmarks.json`);
}

main().catch(console.error);
