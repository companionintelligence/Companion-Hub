#!/usr/bin/env bun
/**
 * QA Batch Runner
 * 
 * Run QA on a batch of apps based on BATCH env var (0-6)
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RESULTS_DIR = process.env.RESULTS_DIR || join(process.env.HOME || '~', 'qa-results');
const APP_STORE_DIR = '../CI-App-Store/apps';
const BATCH = parseInt(process.env.BATCH || '0', 10);
const BATCH_SIZE = 86;

interface QAResult {
  appId: string;
  score: 'pass' | 'warn' | 'fail';
  notes: string;
  memoryMb: number;
  startupMs: number;
  timestamp: string;
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log(`║  App Store QA - Batch ${BATCH}                                    ║`);
  console.log('╚════════════════════════════════════════════════════════════╝\n');
  
  // Ensure directories
  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  
  // Get all apps
  const allApps = readdirSync(APP_STORE_DIR)
    .filter(f => existsSync(join(APP_STORE_DIR, f, 'config.json')))
    .sort();
  
  console.log(`Total apps: ${allApps.length}`);
  
  // Get batch
  const startIdx = BATCH * BATCH_SIZE;
  const endIdx = Math.min(startIdx + BATCH_SIZE, allApps.length);
  const batchApps = allApps.slice(startIdx, endIdx);
  
  console.log(`Batch ${BATCH}: apps ${startIdx + 1} to ${endIdx} (${batchApps.length} apps)\n`);
  
  if (batchApps.length === 0) {
    console.log('No apps in this batch');
    return;
  }
  
  const startTime = Date.now();
  const results: QAResult[] = [];
  let passed = 0, warned = 0, failed = 0;
  
  for (let i = 0; i < batchApps.length; i++) {
    const appId = batchApps[i];
    const progress = `[${i + 1}/${batchApps.length}]`;
    
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`${progress} Testing: ${appId}`);
    console.log('═'.repeat(60));
    
    try {
      // Run qa-app.ts for this app
      execSync(`bun run scripts/qa-app.ts ${appId}`, {
        stdio: 'inherit',
        env: { ...process.env, RESULTS_DIR },
        timeout: 300000, // 5 min max per app
      });
      
      // Read the result
      const resultsFile = join(RESULTS_DIR, 'results.json');
      if (existsSync(resultsFile)) {
        const allResults = JSON.parse(readFileSync(resultsFile, 'utf-8'));
        const appResult = allResults.find((r: QAResult) => r.appId === appId);
        if (appResult) {
          results.push(appResult);
          if (appResult.score === 'pass') passed++;
          else if (appResult.score === 'warn') warned++;
          else failed++;
        }
      }
    } catch (error) {
      console.error(`\n❌ QA script failed for ${appId}`);
      results.push({
        appId,
        score: 'fail',
        notes: 'QA script crashed',
        memoryMb: 0,
        startupMs: -1,
        timestamp: new Date().toISOString(),
      });
      failed++;
    }
    
    // Progress update
    const elapsed = (Date.now() - startTime) / 1000 / 60;
    const rate = (i + 1) / elapsed;
    const remaining = (batchApps.length - i - 1) / rate;
    
    console.log(`\n📊 Progress: ✅${passed} ⚠️${warned} ❌${failed} | ETA: ${remaining.toFixed(0)}min`);
  }
  
  // Generate report
  const elapsed = (Date.now() - startTime) / 1000 / 60;
  
  console.log('\n' + '═'.repeat(60));
  console.log('BATCH COMPLETE');
  console.log('═'.repeat(60));
  console.log(`\nTotal time: ${elapsed.toFixed(1)} minutes`);
  console.log(`Results: ✅ ${passed} pass | ⚠️ ${warned} warn | ❌ ${failed} fail`);
  console.log(`Pass rate: ${((passed / results.length) * 100).toFixed(1)}%`);
  
  // Save batch summary
  const summaryFile = join(RESULTS_DIR, `batch-${BATCH}-summary.json`);
  writeFileSync(summaryFile, JSON.stringify({
    batch: BATCH,
    startIdx,
    endIdx,
    total: batchApps.length,
    passed,
    warned,
    failed,
    passRate: (passed / results.length) * 100,
    elapsedMinutes: elapsed,
    timestamp: new Date().toISOString(),
  }, null, 2));
  
  // Generate markdown report
  const reportFile = join(RESULTS_DIR, `batch-${BATCH}-report.md`);
  let md = `# QA Report - Batch ${BATCH}\n\n`;
  md += `**Date:** ${new Date().toISOString().split('T')[0]}\n`;
  md += `**Apps:** ${startIdx + 1} to ${endIdx} (${batchApps.length} total)\n`;
  md += `**Duration:** ${elapsed.toFixed(1)} minutes\n\n`;
  md += `## Summary\n\n`;
  md += `| Status | Count |\n|--------|-------|\n`;
  md += `| ✅ Pass | ${passed} |\n`;
  md += `| ⚠️ Warn | ${warned} |\n`;
  md += `| ❌ Fail | ${failed} |\n`;
  md += `| **Pass Rate** | ${((passed / results.length) * 100).toFixed(1)}% |\n\n`;
  
  md += `## Failed Apps\n\n`;
  const failedApps = results.filter(r => r.score === 'fail');
  if (failedApps.length === 0) {
    md += `None! 🎉\n\n`;
  } else {
    md += `| App | Notes |\n|-----|-------|\n`;
    for (const app of failedApps) {
      md += `| ${app.appId} | ${app.notes || '-'} |\n`;
    }
    md += '\n';
  }
  
  md += `## Warnings\n\n`;
  const warnedApps = results.filter(r => r.score === 'warn');
  if (warnedApps.length === 0) {
    md += `None\n\n`;
  } else {
    md += `| App | Notes |\n|-----|-------|\n`;
    for (const app of warnedApps) {
      md += `| ${app.appId} | ${app.notes || '-'} |\n`;
    }
    md += '\n';
  }
  
  md += `## Resource Usage (Top 10 by Memory)\n\n`;
  const byMemory = [...results].sort((a, b) => (b.memoryMb || 0) - (a.memoryMb || 0)).slice(0, 10);
  md += `| App | Memory | Startup |\n|-----|--------|--------|\n`;
  for (const app of byMemory) {
    const mem = app.memoryMb ? `${app.memoryMb}MB` : '-';
    const startup = app.startupMs > 0 ? `${(app.startupMs / 1000).toFixed(1)}s` : '-';
    md += `| ${app.appId} | ${mem} | ${startup} |\n`;
  }
  
  writeFileSync(reportFile, md);
  console.log(`\n📁 Report saved to ${reportFile}`);
}

main().catch(console.error);
