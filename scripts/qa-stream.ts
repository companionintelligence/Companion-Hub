#!/usr/bin/env tsx
/**
 * QA Stream Runner
 *
 * Runs per-app Docker tests and emits newline-delimited JSON events to stdout.
 * Designed to be SCP'd to fleet nodes and invoked by fleet-qa-server.ts.
 *
 * Usage:
 *   tsx scripts/qa-stream.ts nextcloud jellyfin uptime-kuma
 *
 * Env vars:
 *   APP_STORE_DIR   path to CI-Marketplace/apps  (default: ~/devel/CI-Marketplace/apps
 *                   with fallback to ~/devel/CI-App-Store/apps)
 *   RESULTS_DIR     local results output dir      (default: ~/qa-results)
 *   SKIP_SCREENSHOT set to "1" to skip Playwright screenshot
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = homedir();
const APP_STORE_DIR =
  process.env.APP_STORE_DIR ??
  (existsSync(join(home, 'devel/CI-Marketplace/apps')) ? join(home, 'devel/CI-Marketplace/apps') : join(home, 'devel/CI-App-Store/apps'));
const RESULTS_DIR = process.env.RESULTS_DIR ?? join(home, 'qa-results');
const SCREENSHOTS_DIR = join(RESULTS_DIR, 'screenshots');
const SKIP_SCREENSHOT = process.env.SKIP_SCREENSHOT === '1';

[RESULTS_DIR, SCREENSHOTS_DIR].forEach((d) => {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
});

function emit(obj: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function phase(appId: string, phase: string, message: string) {
  emit({ event: 'app_phase', appId, phase, message, ts: Date.now() });
}

function execQuiet(cmd: string, timeoutMs = 120_000): { ok: boolean; out: string; err: string; ms: number } {
  const t = Date.now();
  try {
    const out = execSync(cmd, { encoding: 'utf-8', stdio: 'pipe', timeout: timeoutMs }).trim();
    return { ok: true, out, err: '', ms: Date.now() - t };
  } catch (e: unknown) {
    const err = e instanceof Error ? e.message : String(e);
    return { ok: false, out: '', err, ms: Date.now() - t };
  }
}

function summarizeText(text: string, maxLen = 220): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

interface AppConfig {
  name?: string;
  port?: number;
  url_suffix?: string;
  no_gui?: boolean;
  categories?: string[];
}

interface DockerService {
  image?: string;
  isMain?: boolean;
  internalPort?: number;
}

interface ComposeJson {
  services?: DockerService[];
}

async function qaApp(appId: string) {
  emit({ event: 'app_start', appId, ts: Date.now() });

  const containerName = `qa-stream-${appId}`;
  const result: Record<string, unknown> = {
    appId,
    score: 'fail' as 'pass' | 'warn' | 'fail',
    notes: '',
    ts: Date.now(),
  };

  // Cleanup stale container
  execQuiet(`docker stop ${containerName} 2>/dev/null; docker rm ${containerName} 2>/dev/null`);

  try {
    // ── Config ────────────────────────────────────────────────
    const configPath = join(APP_STORE_DIR, appId, 'config.json');
    if (!existsSync(configPath)) {
      result.score = 'fail';
      result.notes = `config.json not found at ${configPath}`;
      emit({ event: 'app_result', appId, result });
      return;
    }

    const config: AppConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    result.name = config.name ?? appId;
    result.port = config.port ?? 80;
    result.categories = config.categories ?? [];

    // Image from docker-compose.json (Hub V2 format) or .yml
    const composeJsonPath = join(APP_STORE_DIR, appId, 'docker-compose.json');
    const composeYmlPath = join(APP_STORE_DIR, appId, 'docker-compose.yml');

    if (existsSync(composeJsonPath)) {
      const compose: ComposeJson = JSON.parse(readFileSync(composeJsonPath, 'utf-8'));
      const main = compose.services?.find((s) => s.isMain) ?? compose.services?.[0];
      result.image = main?.image ?? `${appId}:latest`;
      if (main?.internalPort) result.port = main.internalPort;
    } else if (existsSync(composeYmlPath)) {
      const yml = readFileSync(composeYmlPath, 'utf-8');
      const m = yml.match(/^\s*image:\s*(.+)/m);
      result.image = m ? m[1].trim() : `${appId}:latest`;
    } else {
      result.score = 'fail';
      result.notes = 'No docker-compose.json or docker-compose.yml';
      emit({ event: 'app_result', appId, result });
      return;
    }

    // ── Pull ──────────────────────────────────────────────────
    phase(appId, 'pulling', `Pulling ${result.image}`);
    const pullT0 = Date.now();
    const pull = execQuiet(`docker pull ${result.image}`, 300_000);
    result.pullMs = Date.now() - pullT0;

    if (!pull.ok) {
      result.score = 'fail';
      result.notes = `Pull failed: ${pull.err.slice(0, 200)}`;
      emit({ event: 'app_result', appId, result });
      return;
    }

    // Image size
    const sizeR = execQuiet(`docker image inspect ${result.image} --format "{{.Size}}"`);
    result.imageMb = sizeR.ok ? Math.round(Number(sizeR.out) / 1024 / 1024) : 0;

    // ── Start ─────────────────────────────────────────────────
    phase(appId, 'starting', `Starting container on port ${result.port}`);
    const startT0 = Date.now();
    const run = execQuiet(`docker run -d --name ${containerName} -p ${result.port}:${result.port} ${result.image}`, 60_000);
    if (!run.ok) {
      result.score = 'fail';
      result.notes = `Container start failed: ${run.err.slice(0, 200)}`;
      emit({ event: 'app_result', appId, result });
      return;
    }

    // ── HTTP ──────────────────────────────────────────────────
    phase(appId, 'http', `Waiting for HTTP on :${result.port}`);
    let httpOk = false;
    let httpStatus = 0;
    const maxWaitMs = 90_000;
    const httpStart = Date.now();

    while (!httpOk && Date.now() - httpStart < maxWaitMs) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const res = await fetch(`http://localhost:${result.port}/`, {
          signal: AbortSignal.timeout(4000),
        });
        httpStatus = res.status;
        httpOk = httpStatus < 500;
      } catch {
        // still waiting
      }
    }

    result.httpStatus = httpStatus;
    result.startupMs = Date.now() - startT0;

    if (!httpOk) {
      result.score = 'fail';
      result.notes = 'No HTTP response within 90s';
      emit({ event: 'app_result', appId, result });
      return;
    }

    // ── Screenshot ────────────────────────────────────────────
    const screenshotPath = join(SCREENSHOTS_DIR, `${appId}.png`);
    let screenshotReason = '';
    if (SKIP_SCREENSHOT || config.no_gui) {
      result.hasScreenshot = false;
      screenshotReason = SKIP_SCREENSHOT ? 'SKIP_SCREENSHOT=1' : 'config.no_gui=true';
    } else {
      phase(appId, 'screenshot', 'Taking screenshot');
      const ss = spawnSync(
        'bash',
        [
          '-lc',
          'if command -v playwright >/dev/null 2>&1; then ' +
            `playwright screenshot http://localhost:${result.port}/ ${screenshotPath} --wait-for-timeout=3000; ` +
            'elif command -v pnpm >/dev/null 2>&1; then ' +
            `pnpm dlx playwright screenshot http://localhost:${result.port}/ ${screenshotPath} --wait-for-timeout=3000; ` +
            'else ' +
            `echo "no playwright or pnpm found" >&2; exit 127; ` +
            'fi',
        ],
        { timeout: 30_000, stdio: 'pipe' },
      );
      result.hasScreenshot = ss.status === 0;
      if (!result.hasScreenshot) {
        const stderr = summarizeText(ss.stderr?.toString() ?? '');
        const stdout = summarizeText(ss.stdout?.toString() ?? '');
        screenshotReason = stderr || stdout || `screenshot command exited ${ss.status ?? 'unknown'}`;
      }
    }

    // ── Benchmark ─────────────────────────────────────────────
    phase(appId, 'benchmark', 'Collecting metrics');
    await new Promise((r) => setTimeout(r, 2000));

    let memTotal = 0;
    let memPeak = 0;
    let cpuTotal = 0;
    let samples = 0;

    for (let i = 0; i < 3; i++) {
      const s = execQuiet(`docker stats ${containerName} --no-stream --format "{{.MemUsage}}|||{{.CPUPerc}}"`, 10_000);
      if (s.ok) {
        const [memStr, cpuStr] = s.out.split('|||');
        const memM = memStr?.match(/(\d+(?:\.\d+)?)\s*(MiB|GiB|MB|GB)/i);
        let mb = memM ? Number.parseFloat(memM[1]) : 0;
        if (memM?.[2].toLowerCase().startsWith('g')) mb *= 1024;
        const cpu = Number.parseFloat((cpuStr ?? '0').replace('%', '')) || 0;
        memTotal += mb;
        memPeak = Math.max(memPeak, mb);
        cpuTotal += cpu;
        samples++;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }

    result.memMb = samples ? Math.round(memTotal / samples) : 0;
    result.memPeakMb = Math.round(memPeak);
    result.cpuPct = samples ? Math.round((cpuTotal / samples) * 10) / 10 : 0;

    // ── Score ─────────────────────────────────────────────────
    // httpOk is guaranteed true here (the !httpOk early-return is above)
    result.score = result.hasScreenshot ? 'pass' : 'warn';
    if (!result.hasScreenshot && !result.notes) {
      result.notes = `Screenshot unavailable: ${screenshotReason || 'unknown reason'}`;
    }
  } catch (err) {
    result.score = 'fail';
    result.notes = err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
  } finally {
    execQuiet(`docker stop ${containerName} 2>/dev/null; docker rm ${containerName} 2>/dev/null`);
  }

  emit({ event: 'app_result', appId, result });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const appIds = process.argv.slice(2);
  if (appIds.length === 0) {
    process.stderr.write('Usage: qa-stream.ts <app-id> [app-id...]\n');
    process.exit(1);
  }

  emit({ event: 'batch_start', apps: appIds, storeDir: APP_STORE_DIR, ts: Date.now() });

  for (const appId of appIds) {
    await qaApp(appId);
  }

  const results = appIds.length;
  emit({ event: 'batch_done', total: results, ts: Date.now() });
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
