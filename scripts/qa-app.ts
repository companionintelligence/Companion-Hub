#!/usr/bin/env bun
/**
 * QA Single App
 * 
 * Quick test: run container, check port, screenshot, benchmark, cleanup
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RESULTS_DIR = process.env.RESULTS_DIR || join(process.env.HOME || '~', 'qa-results');
const SCREENSHOTS_DIR = join(RESULTS_DIR, 'screenshots');
const APP_STORE_DIR = '../CI-App-Store/apps';

interface QAResult {
  appId: string;
  name: string;
  image: string;
  port: number;
  
  // Timing
  imageSizeMb: number;
  pullTimeMs: number;
  startupMs: number;
  responseTimeMs: number;
  
  // Resources
  memoryMb: number;
  memoryPeakMb: number;
  cpuPercent: number;
  
  // Status
  httpStatus: number;
  screenshotPath: string | null;
  score: 'pass' | 'warn' | 'fail';
  notes: string;
  
  timestamp: string;
}

// Ensure directories
[RESULTS_DIR, SCREENSHOTS_DIR].forEach(dir => {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
});

async function qaApp(appId: string): Promise<QAResult> {
  console.log(`\n🔍 QA: ${appId}\n`);
  
  const result: Partial<QAResult> = {
    appId,
    timestamp: new Date().toISOString(),
    notes: '',
  };
  
  const containerName = `qa-${appId}`;
  
  try {
    // Load app config
    const configPath = join(APP_STORE_DIR, appId, 'config.json');
    if (!existsSync(configPath)) {
      throw new Error(`App config not found: ${configPath}`);
    }
    
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    result.name = config.name || appId;
    result.port = config.port || 80;
    
    // Get image from docker-compose
    const composePath = join(APP_STORE_DIR, appId, 'docker-compose.yml');
    const composeContent = readFileSync(composePath, 'utf-8');
    const imageMatch = composeContent.match(/image:\s*(.+)/);
    result.image = imageMatch ? imageMatch[1].trim() : `${appId}:latest`;
    
    console.log(`   Name: ${result.name}`);
    console.log(`   Image: ${result.image}`);
    console.log(`   Port: ${result.port}`);
    
    // Cleanup any existing container
    try {
      execSync(`docker stop ${containerName} 2>/dev/null; docker rm ${containerName} 2>/dev/null`, { stdio: 'pipe' });
    } catch { /* ignore */ }
    
    // 1. Pull image
    console.log('\n📥 Pulling image...');
    const pullStart = Date.now();
    try {
      execSync(`docker pull ${result.image}`, { stdio: 'pipe', timeout: 300000 });
      result.pullTimeMs = Date.now() - pullStart;
      console.log(`   ✓ Pulled in ${(result.pullTimeMs / 1000).toFixed(1)}s`);
    } catch (e) {
      result.pullTimeMs = -1;
      result.score = 'fail';
      result.notes = 'Image pull failed';
      throw e;
    }
    
    // Get image size
    try {
      const sizeOutput = execSync(
        `docker image inspect ${result.image} --format "{{.Size}}"`,
        { encoding: 'utf-8' }
      ).trim();
      result.imageSizeMb = Math.round(parseInt(sizeOutput) / 1024 / 1024);
    } catch {
      result.imageSizeMb = 0;
    }
    console.log(`   Size: ${result.imageSizeMb}MB`);
    
    // 2. Start container
    console.log('\n🐳 Starting container...');
    const startTime = Date.now();
    try {
      execSync(
        `docker run -d --name ${containerName} -p ${result.port}:${result.port} ${result.image}`,
        { stdio: 'pipe', timeout: 60000 }
      );
    } catch (e) {
      result.startupMs = -1;
      result.score = 'fail';
      result.notes = 'Container start failed';
      throw e;
    }
    
    // 3. Wait for HTTP response
    console.log('\n⏱️  Waiting for HTTP...');
    let httpOk = false;
    let attempts = 0;
    const maxAttempts = 30; // 60 seconds
    
    while (!httpOk && attempts < maxAttempts) {
      attempts++;
      await Bun.sleep(2000);
      
      try {
        const response = await fetch(`http://localhost:${result.port}/`, {
          signal: AbortSignal.timeout(5000),
        });
        
        result.httpStatus = response.status;
        result.responseTimeMs = Date.now() - startTime;
        result.startupMs = result.responseTimeMs;
        httpOk = response.status < 500;
        
        if (httpOk) {
          console.log(`   ✓ HTTP ${result.httpStatus} in ${(result.startupMs / 1000).toFixed(1)}s`);
        }
      } catch {
        process.stdout.write('.');
      }
    }
    
    if (!httpOk) {
      console.log('\n   ✗ No HTTP response');
      result.startupMs = -1;
      result.httpStatus = 0;
      result.score = 'fail';
      result.notes = 'No HTTP response within 60s';
    }
    
    // 4. Take screenshot
    console.log('\n📸 Taking screenshot...');
    const screenshotPath = join(SCREENSHOTS_DIR, `${appId}.png`);
    
    try {
      execSync(
        `bunx playwright screenshot http://localhost:${result.port}/ "${screenshotPath}" --wait-for-timeout=3000`,
        { stdio: 'pipe', timeout: 30000 }
      );
      result.screenshotPath = screenshotPath;
      console.log(`   ✓ Saved to ${appId}.png`);
    } catch {
      console.log('   ⚠ Screenshot failed');
      result.screenshotPath = null;
      if (!result.notes) result.notes = 'Screenshot failed';
    }
    
    // 5. Collect resource metrics
    console.log('\n📊 Benchmarking...');
    await Bun.sleep(3000); // Let app stabilize
    
    let maxMem = 0, totalMem = 0, totalCpu = 0, samples = 0;
    
    for (let i = 0; i < 3; i++) {
      try {
        const stats = execSync(
          `docker stats ${containerName} --no-stream --format "{{.MemUsage}}|||{{.CPUPerc}}"`,
          { encoding: 'utf-8' }
        ).trim();
        
        const [memStr, cpuStr] = stats.split('|||');
        
        // Parse memory
        const memMatch = memStr.match(/(\d+(?:\.\d+)?)\s*(MiB|GiB|MB|GB)/i);
        let memMb = memMatch ? parseFloat(memMatch[1]) : 0;
        if (memMatch && memMatch[2].toLowerCase().includes('g')) memMb *= 1024;
        
        // Parse CPU
        const cpu = parseFloat(cpuStr.replace('%', '')) || 0;
        
        totalMem += memMb;
        totalCpu += cpu;
        maxMem = Math.max(maxMem, memMb);
        samples++;
        
        await Bun.sleep(2000);
      } catch { /* ignore */ }
    }
    
    result.memoryMb = samples > 0 ? Math.round(totalMem / samples) : 0;
    result.memoryPeakMb = Math.round(maxMem);
    result.cpuPercent = samples > 0 ? Math.round((totalCpu / samples) * 10) / 10 : 0;
    
    console.log(`   Memory: ${result.memoryMb}MB (peak: ${result.memoryPeakMb}MB)`);
    console.log(`   CPU: ${result.cpuPercent}%`);
    
    // 6. Determine score
    if (!result.score) {
      if (httpOk && result.screenshotPath) {
        result.score = 'pass';
      } else if (httpOk) {
        result.score = 'warn';
      } else {
        result.score = 'fail';
      }
    }
    
  } catch (error: unknown) {
    if (!result.score) result.score = 'fail';
    if (!result.notes) {
      result.notes = error instanceof Error ? error.message : String(error);
    }
    console.error(`\n❌ Error: ${result.notes}`);
  } finally {
    // Cleanup
    console.log('\n🧹 Cleanup...');
    try {
      execSync(`docker stop ${containerName} 2>/dev/null; docker rm ${containerName} 2>/dev/null`, { stdio: 'pipe' });
    } catch { /* ignore */ }
  }
  
  // Print result
  const icon = result.score === 'pass' ? '✅' : result.score === 'warn' ? '⚠️' : '❌';
  console.log(`\n${icon} ${result.name}: ${result.score?.toUpperCase()}`);
  if (result.notes) console.log(`   Notes: ${result.notes}`);
  
  return result as QAResult;
}

// CLI
const appId = process.argv[2];

if (!appId) {
  console.log(`
Usage: bun run qa-app.ts <app-id>

Examples:
  bun run qa-app.ts nextcloud
  bun run qa-app.ts jellyfin
  bun run qa-app.ts ghost
`);
  process.exit(1);
}

const result = await qaApp(appId);

// Save result
const resultsFile = join(RESULTS_DIR, 'results.json');
let results: QAResult[] = [];
if (existsSync(resultsFile)) {
  results = JSON.parse(readFileSync(resultsFile, 'utf-8'));
}

// Update or append
const existingIdx = results.findIndex(r => r.appId === appId);
if (existingIdx >= 0) {
  results[existingIdx] = result;
} else {
  results.push(result);
}

writeFileSync(resultsFile, JSON.stringify(results, null, 2));
console.log(`\n📁 Saved to ${resultsFile}`);
