#!/usr/bin/env tsx
/**
 * Fleet Test Orchestrator
 *
 * Distributes app catalog tests across the fleet servers
 * and collects results for unified reporting. Dry run by default.
 *
 * Usage:
 *   pnpm exec tsx scripts/run-fleet-tests.ts [--batch=<0-9>] [--execute] [--verbose]
 *
 * Examples:
 *   pnpm exec tsx scripts/run-fleet-tests.ts
 *   pnpm exec tsx scripts/run-fleet-tests.ts --batch=2 --execute --verbose
 */

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
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

/**
 * Fleet server config is loaded from the FLEET_CONFIG_JSON environment variable.
 * Set it before running, e.g.:
 *   export FLEET_CONFIG_JSON='[{"name":"lab-1","ip":"100.64.0.1","batch":0},...]'
 *
 * IPs are Tailscale addresses — keep them out of source control.
 */
const FLEET_CONFIG_JSON = process.env.FLEET_CONFIG_JSON;
if (!FLEET_CONFIG_JSON) {
  console.error('ERROR: FLEET_CONFIG_JSON environment variable is not set.');
  console.error('  export FLEET_CONFIG_JSON=\'[{"name":"lab-1","ip":"100.64.0.1","batch":0},...]\' ');
  process.exit(1);
}
const FLEET: FleetServer[] = JSON.parse(FLEET_CONFIG_JSON);

const SSH_USER = process.env.FLEET_SSH_USER ?? 'ci';
const SSH_OPTIONS = '-o StrictHostKeyChecking=no -o ConnectTimeout=30';
const RESULTS_DIR = 'e2e/results';
const SCREENSHOTS_DIR = 'e2e/screenshots';
const HUB_REF = process.env.FLEET_HUB_REF ?? execSync('git branch --show-current', { encoding: 'utf-8' }).trim();

/**
 * The ref defaults to whatever branch the control machine happens to have checked
 * out, and every node then fetches it by name. A local-only branch makes all nine
 * fail identically with `couldn't find remote ref`, ~60 chars of which survive the
 * error truncation below. One ls-remote turns that into an instant local message.
 */
function assertRefIsPushed(): void {
  const remote = execSync(`git ls-remote --heads origin ${HUB_REF}`, { encoding: 'utf-8' }).trim();
  if (remote) {
    return;
  }
  console.error(`\n\u274c Ref '${HUB_REF}' does not exist on origin, so no node can fetch it.`);
  console.error('   The fleet tests whatever ref you name — it defaults to your current local branch.');
  console.error('   Push it, or pin one explicitly:  FLEET_HUB_REF=dev FLEET_HUB_SHA=$(git rev-parse origin/dev)\n');
  process.exit(1);
}
const HUB_SHA = process.env.FLEET_HUB_SHA ?? execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
const APPS_PER_BATCH = (() => {
  try {
    const summary = JSON.parse(readFileSync('e2e/generated/summary.json', 'utf-8'));
    return Number(summary.appsPerBatch) || 10;
  } catch {
    return 10;
  }
})();

async function main() {
  const args = process.argv.slice(2);
  const singleBatch = args.find((a) => a.startsWith('--batch='))?.split('=')[1];
  const execute = args.includes('--execute');
  const verbose = args.includes('--verbose');

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║       CI App Store Fleet Testing System                     ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  // Ensure results directory exists
  if (!existsSync(RESULTS_DIR)) {
    mkdirSync(RESULTS_DIR, { recursive: true });
  }

  // Determine which servers to run
  const serversToRun = singleBatch === undefined ? FLEET : FLEET.filter((s) => s.batch === Number.parseInt(singleBatch, 10));

  console.log(`📋 Running tests on ${serversToRun.length} server(s):\n`);
  serversToRun.forEach((s) => {
    console.log(`   • ${s.name} (${s.ip}) - Batch ${s.batch}`);
  });
  console.log('');

  if (!execute) {
    console.log('🔍 Dry run mode - not executing tests. Pass --execute to run.\n');
    return;
  }

  // Cheapest check first: a ref no node can fetch fails all of them identically.
  assertRefIsPushed();

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
      failed: APPS_PER_BATCH,
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

  // A fleet run where nothing passed is a failure, not a success. This exited 0
  // for months while every batch matched zero tests, so anything wrapping it read
  // red as green.
  if (report.totalApps > 0 && report.passed === 0) {
    console.error(`\n\u274c Fleet run failed: 0 of ${report.totalApps} apps passed.`);
    process.exitCode = 1;
  }
}

async function runTestsOnServer(server: FleetServer, _verbose: boolean): Promise<TestResult> {
  const startTime = Date.now();

  console.log(`📦 [${server.name}] Starting batch ${server.batch}...`);

  const sshCommand = `
    cd ~/devel/CI-Hub &&
    git fetch --quiet origin ${HUB_REF} &&
    git checkout --detach ${HUB_SHA} &&
    git rev-parse --short HEAD &&
    (pnpm install --silent 2>/dev/null || true) &&
    E2E_RUN_CATALOG_TESTS=true pnpm exec playwright test e2e/generated/catalog-batch-${server.batch}.spec.ts \
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
      execSync(`scp ${SSH_OPTIONS} -r ${SSH_USER}@${server.ip}:~/devel/CI-Hub/e2e/screenshots/current/ ${SCREENSHOTS_DIR}/${server.name}/`, {
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
      failed: APPS_PER_BATCH,
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
