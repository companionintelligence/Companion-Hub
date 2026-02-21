#!/usr/bin/env bun
/**
 * Fleet Test Orchestrator
 *
 * Distributes app catalog tests across 7 fleet servers
 * and collects results for unified reporting.
 */

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

interface FleetServer {
  name: string;
  ip: string;
  batch: number;
}

interface TestResult {
  server: FleetServer;
  success: boolean;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  apps: AppResult[];
  error?: string;
}

interface AppResult {
  appId: string;
  name: string;
  install: 'pass' | 'fail' | 'skip';
  healthCheck: 'pass' | 'fail' | 'skip';
  subdomain: 'pass' | 'fail' | 'skip';
  screenshot: 'pass' | 'fail' | 'skip';
  cleanup: 'pass' | 'fail' | 'skip';
  duration: number;
  error?: string;
  benchmark?: {
    startupMs: number;
    memoryMb: number;
    cpuPercent: number;
  };
}

const FLEET: FleetServer[] = [
  { name: 'core-1', ip: '100.108.17.53', batch: 0 },
  { name: 'core-2', ip: '100.101.156.33', batch: 1 },
  { name: 'core-3', ip: '100.108.125.105', batch: 2 },
  { name: 'core-4', ip: '100.76.114.122', batch: 3 },
  { name: 'core-5', ip: '100.118.2.90', batch: 4 },
  { name: 'core-6', ip: '100.95.23.128', batch: 5 },
  { name: 'core-7', ip: '100.74.95.94', batch: 6 },
];

const SSH_USER = 'ci';
const SSH_OPTIONS = '-o StrictHostKeyChecking=no -o ConnectTimeout=30';
const RESULTS_DIR = 'e2e/results';
const SCREENSHOTS_DIR = 'e2e/screenshots';

async function main() {
  const args = process.argv.slice(2);
  const singleBatch = args.find((a) => a.startsWith('--batch='))?.split('=')[1];
  const dryRun = args.includes('--dry-run');
  const verbose = args.includes('--verbose');

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║       CI App Store Fleet Testing System                     ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  // Ensure results directory exists
  if (!existsSync(RESULTS_DIR)) {
    mkdirSync(RESULTS_DIR, { recursive: true });
  }

  // Determine which servers to run
  const serversToRun = singleBatch !== undefined ? FLEET.filter((s) => s.batch === Number.parseInt(singleBatch, 10)) : FLEET;

  console.log(`📋 Running tests on ${serversToRun.length} server(s):\n`);
  serversToRun.forEach((s) => {
    console.log(`   • ${s.name} (${s.ip}) - Batch ${s.batch}`);
  });
  console.log('');

  if (dryRun) {
    console.log('🔍 Dry run mode - not executing tests\n');
    return;
  }

  // Check connectivity first
  console.log('🔌 Checking server connectivity...\n');
  for (const server of serversToRun) {
    try {
      execSync(`ping -c 1 -W 3 ${server.ip}`, { stdio: 'pipe' });
      console.log(`   ✅ ${server.name} - reachable`);
    } catch {
      console.log(`   ❌ ${server.name} - unreachable`);
    }
  }
  console.log('');

  // Start tests in parallel
  console.log('🚀 Starting fleet tests...\n');
  const startTime = Date.now();

  const results = await Promise.allSettled(serversToRun.map((server) => runTestsOnServer(server, verbose)));

  const endTime = Date.now();
  const totalDuration = (endTime - startTime) / 1000 / 60; // minutes

  // Process results
  const testResults: TestResult[] = results.map((result, i) => {
    if (result.status === 'fulfilled') {
      return result.value;
    }
    return {
      server: serversToRun[i],
      success: false,
      passed: 0,
      failed: 86, // Assume all failed
      skipped: 0,
      duration: 0,
      apps: [],
      error: result.reason?.message || 'Unknown error',
    };
  });

  // Generate report
  const report = generateReport(testResults, totalDuration);

  // Save report
  const reportPath = join(RESULTS_DIR, `fleet-report-${new Date().toISOString().split('T')[0]}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  const markdownPath = join(RESULTS_DIR, `fleet-report-${new Date().toISOString().split('T')[0]}.md`);
  writeFileSync(markdownPath, generateMarkdownReport(report));

  // Print summary
  printSummary(report);
}

async function runTestsOnServer(server: FleetServer, _verbose: boolean): Promise<TestResult> {
  const startTime = Date.now();

  console.log(`📦 [${server.name}] Starting batch ${server.batch}...`);

  const sshCommand = `
    cd ~/devel/CI-OS-Hub && 
    git pull --quiet origin dev 2>/dev/null || true &&
    bun install --silent 2>/dev/null || true &&
    bun run playwright test e2e/generated/catalog-batch-${server.batch}.spec.ts \
      --reporter=json \
      --timeout=300000 \
      2>&1
  `;

  try {
    const output = execSync(`ssh ${SSH_OPTIONS} ${SSH_USER}@${server.ip} "${sshCommand}"`, {
      timeout: 7200000, // 2 hour timeout per server
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer
    });

    // Parse Playwright JSON output
    const jsonMatch = output.match(/\{[\s\S]*"stats"[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Could not parse test output');
    }

    const playwrightResult = JSON.parse(jsonMatch[0]);
    const duration = (Date.now() - startTime) / 1000 / 60;

    console.log(
      `✅ [${server.name}] Complete - ${playwrightResult.stats.expected} passed, ${playwrightResult.stats.unexpected} failed (${duration.toFixed(1)}m)`,
    );

    // Collect screenshots
    try {
      execSync(`scp ${SSH_OPTIONS} -r ${SSH_USER}@${server.ip}:~/devel/CI-OS-Hub/e2e/screenshots/current/ ${SCREENSHOTS_DIR}/${server.name}/`, {
        stdio: 'pipe',
      });
    } catch {
      // Screenshots may not exist
    }

    return {
      server,
      success: true,
      passed: playwrightResult.stats.expected || 0,
      failed: playwrightResult.stats.unexpected || 0,
      skipped: playwrightResult.stats.skipped || 0,
      duration,
      apps: parseAppResults(playwrightResult),
    };
  } catch (error) {
    const duration = (Date.now() - startTime) / 1000 / 60;
    console.log(`❌ [${server.name}] Failed after ${duration.toFixed(1)}m: ${error.message?.slice(0, 100)}`);

    return {
      server,
      success: false,
      passed: 0,
      failed: 86,
      skipped: 0,
      duration,
      apps: [],
      error: error.message,
    };
  }
}

// biome-ignore lint/suspicious/noExplicitAny: JSON output
function parseAppResults(playwrightResult: any): AppResult[] {
  const apps: AppResult[] = [];

  for (const suite of playwrightResult.suites || []) {
    for (const spec of suite.specs || []) {
      const appIdMatch = spec.title?.match(/App: (.+)/);
      if (appIdMatch) {
        apps.push({
          appId: appIdMatch[1].toLowerCase().replace(/\s+/g, '-'),
          name: appIdMatch[1],
          install: spec.tests?.[0]?.status === 'expected' ? 'pass' : 'fail',
          healthCheck: spec.tests?.[1]?.status === 'expected' ? 'pass' : 'fail',
          subdomain: spec.tests?.[2]?.status === 'expected' ? 'pass' : 'fail',
          screenshot: spec.tests?.[3]?.status === 'expected' ? 'pass' : 'fail',
          cleanup: spec.tests?.[4]?.status === 'expected' ? 'pass' : 'fail',
          // biome-ignore lint/suspicious/noExplicitAny: JSON output
          duration: spec.tests?.reduce((sum: number, t: any) => sum + (t.duration || 0), 0) / 1000,
        });
      }
    }
  }

  return apps;
}

function generateReport(results: TestResult[], totalDuration: number) {
  const totalPassed = results.reduce((sum, r) => sum + r.passed, 0);
  const totalFailed = results.reduce((sum, r) => sum + r.failed, 0);
  const totalSkipped = results.reduce((sum, r) => sum + r.skipped, 0);
  const totalApps = totalPassed + totalFailed + totalSkipped;

  const failedApps = results
    .flatMap((r) => r.apps.filter((a) => a.install === 'fail' || a.healthCheck === 'fail' || a.subdomain === 'fail'))
    .map((a) => ({
      appId: a.appId,
      name: a.name,
      phase: a.install === 'fail' ? 'install' : a.healthCheck === 'fail' ? 'healthCheck' : 'subdomain',
      error: a.error,
    }));

  return {
    timestamp: new Date().toISOString(),
    totalApps,
    passed: totalPassed,
    failed: totalFailed,
    skipped: totalSkipped,
    passRate: totalApps > 0 ? ((totalPassed / totalApps) * 100).toFixed(1) : '0',
    duration: `${totalDuration.toFixed(0)}m`,
    serverResults: results.map((r) => ({
      server: r.server.name,
      batch: r.server.batch,
      passed: r.passed,
      failed: r.failed,
      duration: `${r.duration.toFixed(1)}m`,
      success: r.success,
      error: r.error,
    })),
    failedApps,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: JSON output
function generateMarkdownReport(report: any): string {
  let md = '# CI App Store Fleet Test Report\n\n';
  md += `**Date:** ${new Date(report.timestamp).toLocaleDateString()}\n`;
  md += `**Duration:** ${report.duration}\n\n`;

  md += '## Summary\n\n';
  md += '| Metric | Value |\n|--------|-------|\n';
  md += `| Total Apps | ${report.totalApps} |\n`;
  md += `| Passed | ${report.passed} (${report.passRate}%) |\n`;
  md += `| Failed | ${report.failed} |\n`;
  md += `| Skipped | ${report.skipped} |\n\n`;

  md += '## Server Results\n\n';
  md += '| Server | Batch | Passed | Failed | Duration | Status |\n';
  md += '|--------|-------|--------|--------|----------|--------|\n';
  for (const sr of report.serverResults) {
    const status = sr.success ? '✅' : '❌';
    md += `| ${sr.server} | ${sr.batch} | ${sr.passed} | ${sr.failed} | ${sr.duration} | ${status} |\n`;
  }
  md += '\n';

  if (report.failedApps.length > 0) {
    md += '## Failed Apps\n\n';
    md += '| App | Phase | Error |\n|-----|-------|-------|\n';
    for (const app of report.failedApps.slice(0, 20)) {
      md += `| ${app.name} | ${app.phase} | ${app.error || 'Unknown'} |\n`;
    }
    if (report.failedApps.length > 20) {
      md += `\n*...and ${report.failedApps.length - 20} more*\n`;
    }
  }

  return md;
}

// biome-ignore lint/suspicious/noExplicitAny: JSON output
function printSummary(report: any) {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║                    TEST SUMMARY                             ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  Total Apps:    ${String(report.totalApps).padEnd(6)} Duration: ${report.duration.padEnd(10)}      ║`);
  console.log(`║  Passed:        ${String(report.passed).padEnd(6)} (${report.passRate}%)                       ║`);
  console.log(`║  Failed:        ${String(report.failed).padEnd(6)}                                 ║`);
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log('║  SERVER BREAKDOWN                                           ║');
  for (const sr of report.serverResults) {
    const status = sr.success ? '✅' : '❌';
    console.log(
      `║  ${status} ${sr.server.padEnd(8)} ${String(sr.passed).padStart(3)} pass / ${String(sr.failed).padStart(2)} fail  ${sr.duration.padStart(6)}       ║`,
    );
  }
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  if (report.failedApps.length > 0) {
    console.log('Failed apps:');
    for (const app of report.failedApps.slice(0, 10)) {
      console.log(`  • ${app.name} - ${app.phase}`);
    }
    if (report.failedApps.length > 10) {
      console.log(`  ... and ${report.failedApps.length - 10} more`);
    }
  }
}

main().catch(console.error);
