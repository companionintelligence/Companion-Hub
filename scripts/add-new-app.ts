#!/usr/bin/env bun
/**
 * Add New App to CI App Store
 *
 * Workflow:
 * 1. Create app config and docker-compose
 * 2. Pull and test the container
 * 3. Take baseline screenshot
 * 4. Collect resource benchmarks
 * 5. Add to test catalog
 *
 * Usage:
 *   bun run scripts/add-new-app.ts <id> <name> <image> <port> [categories]
 *
 * Examples:
 *   bun run scripts/add-new-app.ts ghost Ghost ghost:5 2368 blog,cms
 *   bun run scripts/add-new-app.ts nextcloud Nextcloud nextcloud:28 443
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface AppConfig {
  id: string;
  name: string;
  description: string;
  image: string;
  port: number;
  categories: string[];
  version?: string;
  website?: string;
  source?: string;
  env?: Record<string, string>;
  volumes?: string[];
}

interface AppBenchmark {
  memoryMb: number;
  cpuPercent: number;
  startupMs: number;
  imageSizeMb: number;
}

const APP_STORE_DIR = '../CI-App-Store/apps';
const CATALOG_PATH = 'e2e/generated/catalog.json';
const BASELINES_DIR = 'e2e/screenshots/baselines';

async function addNewApp(config: AppConfig): Promise<void> {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log(`║  Adding New App: ${config.name.padEnd(40)} ║`);
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const appDir = join(APP_STORE_DIR, config.id);
  const containerName = `test-${config.id}`;

  try {
    // Step 1: Create app directory and config
    console.log('📁 Step 1: Creating app configuration...\n');

    if (!existsSync(appDir)) {
      mkdirSync(appDir, { recursive: true });
    }

    // Create config.json
    const appConfig = {
      $schema: 'https://schemas.companionintelligence.com/v2/app-info.json',
      min_tipi_version: 'v4.5.0',
      name: config.name,
      id: config.id,
      available: true,
      short_desc: config.description,
      author: 'Community',
      port: config.port,
      categories: config.categories,
      description: config.description,
      tipi_version: 1,
      version: config.version || '1.0.0',
      source: config.source || '',
      website: config.website || '',
      exposable: true,
      supported_architectures: ['arm64', 'amd64'],
      form_fields: [],
    };

    writeFileSync(join(appDir, 'config.json'), JSON.stringify(appConfig, null, 2));
    console.log('   ✅ Created config.json\n');

    // Create docker-compose.yml
    // Using raw strings for docker-compose template variables
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Docker template variables
    const defaultVolume = '${APP_DATA_DIR}/data:/data';
    const volumes = config.volumes || [defaultVolume];
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Docker template variables
    const defaultTz = '${TZ}';
    const envLines = config.env
      ? Object.entries(config.env)
          .map(([k, v]) => `      - ${k}=${v}`)
          .join('\n')
      : `      - TZ=${defaultTz}`;

    const dockerCompose = `
services:
  ${config.id}:
    image: ${config.image}
    container_name: ${config.id}
    restart: unless-stopped
    ports:
      - "\${APP_PORT}:${config.port}"
    volumes:
${volumes.map((v) => `      - ${v}`).join('\n')}
    environment:
${envLines}
`.trim();

    writeFileSync(join(appDir, 'docker-compose.yml'), dockerCompose);
    console.log('   ✅ Created docker-compose.yml\n');

    // Step 2: Pull and test container
    console.log('🐳 Step 2: Testing container...\n');

    console.log('   Pulling image...');
    execSync(`docker pull ${config.image}`, { stdio: 'inherit' });
    console.log('');

    // Clean up any existing test container
    try {
      execSync(`docker stop ${containerName} 2>/dev/null; docker rm ${containerName} 2>/dev/null`, { stdio: 'pipe' });
    } catch {
      // Container may not exist, ignore
    }

    console.log('   Starting container...');
    execSync(`docker run -d --name ${containerName} -p ${config.port}:${config.port} ${config.image}`, { stdio: 'inherit' });
    console.log('');

    // Step 3: Wait for health and measure startup time
    console.log('⏱️  Step 3: Measuring startup time...\n');
    const startupMs = await measureStartup(config.port);

    if (startupMs < 0) {
      throw new Error('Container failed to become healthy within timeout');
    }
    console.log(`   ✅ Container healthy in ${startupMs}ms\n`);

    // Step 4: Collect benchmarks
    console.log('📊 Step 4: Collecting resource benchmarks...\n');
    const benchmark = await collectBenchmarks(containerName, config.image, startupMs);

    console.log(`   Memory:  ${benchmark.memoryMb.toFixed(0)} MB`);
    console.log(`   CPU:     ${benchmark.cpuPercent.toFixed(1)}%`);
    console.log(`   Image:   ${benchmark.imageSizeMb.toFixed(0)} MB`);
    console.log(`   Startup: ${benchmark.startupMs}ms\n`);

    // Step 5: Take baseline screenshot
    console.log('📸 Step 5: Taking baseline screenshot...\n');

    if (!existsSync(BASELINES_DIR)) {
      mkdirSync(BASELINES_DIR, { recursive: true });
    }

    const screenshotPath = join(BASELINES_DIR, `${config.id}.png`);
    try {
      execSync(`npx playwright screenshot http://localhost:${config.port}/ ${screenshotPath} --wait-for-selector body`, {
        stdio: 'inherit',
        timeout: 30000,
      });
      console.log(`   ✅ Screenshot saved to ${screenshotPath}\n`);
    } catch {
      console.log('   ⚠️  Screenshot failed (may need login or JS)\n');
    }

    // Step 6: Add to catalog
    console.log('📝 Step 6: Adding to test catalog...\n');

    const catalog = existsSync(CATALOG_PATH) ? JSON.parse(readFileSync(CATALOG_PATH, 'utf-8')) : [];

    interface CatalogApp {
      id: string;
      storeSlug: string;
      name: string;
      expectedPort: number;
      healthEndpoint: string;
      hasGui: boolean;
      categories: string[];
      priority: string;
      benchmark?: {
        memoryMb: number;
        cpuPercent: number;
        startupMs: number;
        imageSizeMb: number;
      };
    }

    // Remove existing entry if present
    const existingIndex = catalog.findIndex((a: CatalogApp) => a.id === config.id);
    if (existingIndex >= 0) {
      catalog.splice(existingIndex, 1);
    }

    catalog.push({
      id: config.id,
      storeSlug: 'ci-apps',
      name: config.name,
      expectedPort: config.port,
      healthEndpoint: '/',
      hasGui: true,
      categories: config.categories,
      priority: 'medium',
      benchmark: {
        memoryMb: benchmark.memoryMb,
        cpuPercent: benchmark.cpuPercent,
        startupMs: benchmark.startupMs,
        imageSizeMb: benchmark.imageSizeMb,
      },
    });

    writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2));
    console.log(`   ✅ Added to catalog (${catalog.length} total apps)\n`);

    // Cleanup
    console.log('🧹 Step 7: Cleaning up...\n');
    execSync(`docker stop ${containerName} && docker rm ${containerName}`, { stdio: 'pipe' });
    console.log('   ✅ Container removed\n');

    // Success!
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  ✨ APP ADDED SUCCESSFULLY!                                 ║');
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log(`║  ID:         ${config.id.padEnd(45)} ║`);
    console.log(`║  Name:       ${config.name.padEnd(45)} ║`);
    console.log(`║  Port:       ${String(config.port).padEnd(45)} ║`);
    console.log(`║  Categories: ${config.categories.join(', ').padEnd(45)} ║`);
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log(`║  Memory:     ${String(`${benchmark.memoryMb.toFixed(0)} MB`).padEnd(45)} ║`);
    console.log(`║  Startup:    ${String(`${benchmark.startupMs}ms`).padEnd(45)} ║`);
    console.log('╚════════════════════════════════════════════════════════════╝\n');
  } catch (error) {
    console.error(`\n❌ Error: ${error instanceof Error ? error.message : String(error)}\n`);

    // Cleanup on failure
    try {
      execSync(`docker stop ${containerName} 2>/dev/null; docker rm ${containerName} 2>/dev/null`, { stdio: 'pipe' });
    } catch {
      // Container may not exist, ignore
    }

    process.exit(1);
  }
}

async function measureStartup(port: number, maxWaitMs = 120000): Promise<number> {
  const startTime = Date.now();
  const url = `http://localhost:${port}/`;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5000),
        headers: { 'User-Agent': 'CI-App-Tester/1.0' },
      });

      // Accept any non-5xx response
      if (response.status < 500) {
        return Date.now() - startTime;
      }
    } catch {
      // Still starting
    }

    await new Promise((r) => setTimeout(r, 2000));
    process.stdout.write('.');
  }

  console.log('');
  return -1;
}

async function collectBenchmarks(containerName: string, image: string, startupMs: number): Promise<AppBenchmark> {
  // Get container stats
  const statsOutput = execSync(`docker stats ${containerName} --no-stream --format "{{.MemUsage}}|||{{.CPUPerc}}"`, { encoding: 'utf-8' }).trim();

  const [memUsage, cpuPerc] = statsOutput.split('|||');

  // Parse memory (e.g., "256MiB / 16GiB")
  const memMatch = memUsage.match(/(\d+(?:\.\d+)?)\s*(MiB|GiB|MB|GB)/i);
  let memoryMb = memMatch ? Number.parseFloat(memMatch[1]) : 0;
  if (memMatch?.[2].toLowerCase().includes('g')) {
    memoryMb *= 1024;
  }

  // Parse CPU
  const cpuPercent = Number.parseFloat(cpuPerc.replace('%', '')) || 0;

  // Get image size
  const imageSizeOutput = execSync(`docker image inspect ${image} --format "{{.Size}}"`, { encoding: 'utf-8' }).trim();
  const imageSizeMb = Number.parseInt(imageSizeOutput, 10) / 1024 / 1024;

  return {
    memoryMb,
    cpuPercent,
    startupMs,
    imageSizeMb,
  };
}

// CLI
const args = process.argv.slice(2);

if (args.length < 4) {
  console.log(`
Usage: bun run add-new-app.ts <id> <name> <image> <port> [categories]

Arguments:
  id          App identifier (lowercase, hyphens)
  name        Display name
  image       Docker image (e.g., nginx:latest)
  port        Container port
  categories  Comma-separated categories (optional)

Examples:
  bun run add-new-app.ts ghost Ghost ghost:5 2368 blog,cms
  bun run add-new-app.ts uptime-kuma "Uptime Kuma" louislam/uptime-kuma:1 3001 utilities,monitoring
  bun run add-new-app.ts n8n n8n n8nio/n8n 5678 automation
`);
  process.exit(1);
}

addNewApp({
  id: args[0],
  name: args[1],
  image: args[2],
  port: Number.parseInt(args[3], 10),
  description: `${args[1]} - Self-hosted application`,
  categories: args[4]?.split(',') || ['utilities'],
});
