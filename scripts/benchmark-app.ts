#!/usr/bin/env bun
/**
 * Benchmark Single App
 *
 * Install an app, collect detailed resource metrics,
 * and generate a benchmark report.
 *
 * Usage:
 *   bun run scripts/benchmark-app.ts <app-id> [--save]
 *
 * Examples:
 *   bun run scripts/benchmark-app.ts nextcloud
 *   bun run scripts/benchmark-app.ts jellyfin --save
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface BenchmarkResult {
  appId: string;
  name: string;
  timestamp: string;

  // Timing
  imagePullMs: number;
  containerStartMs: number;
  healthCheckMs: number;
  totalStartupMs: number;

  // Resources
  memoryMb: number;
  memoryPeakMb: number;
  cpuPercent: number;
  cpuPeakPercent: number;
  diskUsageMb: number;
  imageSizeMb: number;

  // Network
  portOpen: boolean;
  responseTimeMs: number;
  httpStatus: number;

  // Container info
  image: string;
  containerPlatform: string;
}

const CATALOG_PATH = 'e2e/generated/catalog.json';
const BENCHMARKS_DIR = 'e2e/results/benchmarks';

async function benchmarkApp(appId: string): Promise<BenchmarkResult> {
  console.log(`\n🔬 Benchmarking: ${appId}\n`);

  // Load app config from catalog
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf-8'));
  // biome-ignore lint/suspicious/noExplicitAny: JSON data
  const app = catalog.find((a: any) => a.id === appId);

  if (!app) {
    throw new Error(`App "${appId}" not found in catalog`);
  }

  // Load docker-compose to get image
  const dockerComposePath = `../CI-App-Store/apps/${appId}/docker-compose.yml`;
  const dockerComposeContent = readFileSync(dockerComposePath, 'utf-8');
  const imageMatch = dockerComposeContent.match(/image:\s*(.+)/);
  const image = imageMatch ? imageMatch[1].trim() : `${appId}:latest`;

  const containerName = `benchmark-${appId}`;
  const result: Partial<BenchmarkResult> = {
    appId,
    name: app.name,
    timestamp: new Date().toISOString(),
    image,
  };

  try {
    // Cleanup any existing container
    try {
      execSync(`docker stop ${containerName} 2>/dev/null; docker rm ${containerName} 2>/dev/null`, { stdio: 'pipe' });
    } catch {
      /* ignore */
    }

    // 1. Measure image pull time
    console.log('📥 Pulling image...');
    const pullStart = Date.now();
    execSync(`docker pull ${image}`, { stdio: 'pipe' });
    result.imagePullMs = Date.now() - pullStart;
    console.log(`   Pull time: ${result.imagePullMs}ms`);

    // 2. Get image size
    const imageSizeOutput = execSync(`docker image inspect ${image} --format "{{.Size}}"`, { encoding: 'utf-8' }).trim();
    result.imageSizeMb = Number.parseInt(imageSizeOutput, 10) / 1024 / 1024;
    console.log(`   Image size: ${result.imageSizeMb.toFixed(0)}MB`);

    // Get platform
    const platformOutput = execSync(`docker image inspect ${image} --format "{{.Architecture}}"`, { encoding: 'utf-8' }).trim();
    result.containerPlatform = platformOutput;

    // 3. Measure container start time
    console.log('\n🐳 Starting container...');
    const startTime = Date.now();
    execSync(`docker run -d --name ${containerName} -p ${app.expectedPort}:${app.expectedPort} ${image}`, { stdio: 'pipe' });
    result.containerStartMs = Date.now() - startTime;
    console.log(`   Container start: ${result.containerStartMs}ms`);

    // 4. Measure health check time
    console.log('\n⏱️  Waiting for health check...');
    const healthStart = Date.now();
    let healthy = false;
    let attempts = 0;
    const maxAttempts = 60;

    while (!healthy && attempts < maxAttempts) {
      attempts++;
      await new Promise((r) => setTimeout(r, 2000));

      try {
        const response = await fetch(`http://localhost:${app.expectedPort}${app.healthEndpoint}`, {
          signal: AbortSignal.timeout(5000),
        });

        if (response.status < 500) {
          healthy = true;
          result.healthCheckMs = Date.now() - healthStart;
          result.httpStatus = response.status;
          result.responseTimeMs = Date.now() - healthStart;
          result.portOpen = true;
        }
      } catch {
        process.stdout.write('.');
      }
    }

    if (healthy) {
      console.log(`\n   Health check: ${result.healthCheckMs}ms`);
    } else {
      result.healthCheckMs = -1;
      result.portOpen = false;
      console.log('\n   ⚠️  Health check timeout');
    }

    result.totalStartupMs = (result.imagePullMs || 0) + (result.containerStartMs || 0) + (result.healthCheckMs || 0);

    // 5. Collect resource metrics
    console.log('\n📊 Collecting resource metrics...');

    // Wait a bit for the app to stabilize
    await new Promise((r) => setTimeout(r, 5000));

    // Sample resources over 30 seconds
    let maxMem = 0;
    let maxCpu = 0;
    const samples: { mem: number; cpu: number }[] = [];

    for (let i = 0; i < 6; i++) {
      try {
        const stats = execSync(`docker stats ${containerName} --no-stream --format "{{.MemUsage}}|||{{.CPUPerc}}"`, { encoding: 'utf-8' }).trim();

        const [memStr, cpuStr] = stats.split('|||');

        // Parse memory
        const memMatch = memStr.match(/(\d+(?:\.\d+)?)\s*(MiB|GiB|MB|GB)/i);
        let memMb = memMatch ? Number.parseFloat(memMatch[1]) : 0;
        if (memMatch?.[2].toLowerCase().includes('g')) {
          memMb *= 1024;
        }

        // Parse CPU
        const cpu = Number.parseFloat(cpuStr.replace('%', '')) || 0;

        samples.push({ mem: memMb, cpu });
        maxMem = Math.max(maxMem, memMb);
        maxCpu = Math.max(maxCpu, cpu);

        process.stdout.write('.');
        await new Promise((r) => setTimeout(r, 5000));
      } catch {
        /* ignore */
      }
    }

    result.memoryMb = samples.reduce((sum, s) => sum + s.mem, 0) / samples.length;
    result.memoryPeakMb = maxMem;
    result.cpuPercent = samples.reduce((sum, s) => sum + s.cpu, 0) / samples.length;
    result.cpuPeakPercent = maxCpu;

    console.log(`\n   Memory (avg): ${result.memoryMb.toFixed(0)}MB`);
    console.log(`   Memory (peak): ${result.memoryPeakMb.toFixed(0)}MB`);
    console.log(`   CPU (avg): ${result.cpuPercent.toFixed(1)}%`);
    console.log(`   CPU (peak): ${result.cpuPeakPercent.toFixed(1)}%`);

    // 6. Get disk usage
    const _diskOutput = execSync(`docker system df -v --format "{{.Size}}" | head -5`, { encoding: 'utf-8' });
    result.diskUsageMb = result.imageSizeMb; // Simplified

    // 7. Cleanup
    console.log('\n🧹 Cleaning up...');
    execSync(`docker stop ${containerName} && docker rm ${containerName}`, { stdio: 'pipe' });
    console.log('   Done');

    return result as BenchmarkResult;
  } catch (error) {
    // Cleanup on error
    try {
      execSync(`docker stop ${containerName} 2>/dev/null; docker rm ${containerName} 2>/dev/null`, { stdio: 'pipe' });
    } catch {
      /* ignore */
    }

    throw error;
  }
}

function printReport(result: BenchmarkResult): void {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log(`║  BENCHMARK REPORT: ${result.name.padEnd(38)} ║`);
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  App ID:      ${result.appId.padEnd(43)} ║`);
  console.log(`║  Image:       ${result.image.padEnd(43)} ║`);
  console.log(`║  Platform:    ${result.containerPlatform.padEnd(43)} ║`);
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log('║  TIMING                                                     ║');
  console.log(`║    Image Pull:     ${String(`${result.imagePullMs}ms`).padEnd(38)} ║`);
  console.log(`║    Container Start: ${String(`${result.containerStartMs}ms`).padEnd(37)} ║`);
  console.log(`║    Health Check:   ${String(`${result.healthCheckMs}ms`).padEnd(38)} ║`);
  console.log(`║    Total Startup:  ${String(`${result.totalStartupMs}ms`).padEnd(38)} ║`);
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log('║  RESOURCES                                                  ║');
  console.log(`║    Memory (avg):   ${String(`${result.memoryMb.toFixed(0)}MB`).padEnd(38)} ║`);
  console.log(`║    Memory (peak):  ${String(`${result.memoryPeakMb.toFixed(0)}MB`).padEnd(38)} ║`);
  console.log(`║    CPU (avg):      ${String(`${result.cpuPercent.toFixed(1)}%`).padEnd(38)} ║`);
  console.log(`║    CPU (peak):     ${String(`${result.cpuPeakPercent.toFixed(1)}%`).padEnd(38)} ║`);
  console.log(`║    Image Size:     ${String(`${result.imageSizeMb.toFixed(0)}MB`).padEnd(38)} ║`);
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log('║  NETWORK                                                    ║');
  console.log(`║    Port Open:      ${String(result.portOpen ? 'Yes' : 'No').padEnd(38)} ║`);
  console.log(`║    HTTP Status:    ${String(result.httpStatus || 'N/A').padEnd(38)} ║`);
  console.log(`║    Response Time:  ${String(`${result.responseTimeMs || 0}ms`).padEnd(38)} ║`);
  console.log('╚════════════════════════════════════════════════════════════╝\n');
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log(`
Usage: bun run benchmark-app.ts <app-id> [--save]

Arguments:
  app-id    App identifier from catalog
  --save    Save results to benchmarks directory

Examples:
  bun run benchmark-app.ts nextcloud
  bun run benchmark-app.ts jellyfin --save
`);
    process.exit(1);
  }

  const appId = args[0];
  const save = args.includes('--save');

  try {
    const result = await benchmarkApp(appId);
    printReport(result);

    if (save) {
      if (!existsSync(BENCHMARKS_DIR)) {
        mkdirSync(BENCHMARKS_DIR, { recursive: true });
      }

      const filePath = join(BENCHMARKS_DIR, `${appId}.json`);
      writeFileSync(filePath, JSON.stringify(result, null, 2));
      console.log(`📁 Saved to ${filePath}\n`);
    }
  } catch (error) {
    console.error(`\n❌ Benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

main();
