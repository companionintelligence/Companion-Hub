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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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

/**
 * Locate a usable Chromium binary from the Playwright browser cache directly,
 * without `pnpm exec playwright` (which fails from $HOME — no package.json) or
 * `playwright install` (no Chromium build is published for Ubuntu 26.04).
 * Newer Playwright lays the binary under chrome-linux64/, older under chrome-linux/.
 * Override with QA_CHROMIUM_PATH. Returns null if nothing usable is found.
 */
let _chromiumBin: string | null | undefined;
function resolveChromiumBinary(): string | null {
  if (_chromiumBin === undefined) _chromiumBin = computeChromiumBinary();
  return _chromiumBin;
}
function computeChromiumBinary(): string | null {
  const envBin = process.env.QA_CHROMIUM_PATH;
  if (envBin && existsSync(envBin)) return envBin;
  const base = join(home, '.cache', 'ms-playwright');
  if (!existsSync(base)) return null;
  const all = readdirSync(base).filter((d) => d.startsWith('chromium'));
  const full = all
    .filter((d) => /^chromium-\d/.test(d))
    .sort()
    .reverse(); // prefer full chromium, newest first
  const shell = all
    .filter((d) => !/^chromium-\d/.test(d))
    .sort()
    .reverse(); // headless_shell fallback
  for (const d of [...full, ...shell]) {
    for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-linux64/headless_shell', 'chrome-linux/headless_shell']) {
      const p = join(base, d, sub);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function emit(obj: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function phase(appId: string, phase: string, message: string) {
  emit({ event: 'app_phase', appId, phase, message, ts: Date.now() });
}

/** Single-quote a value for safe interpolation into a shell command. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
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
  volumes?: { hostPath?: string; containerPath?: string }[];
  environment?: { key?: string; value?: string }[];
}

interface ComposeJson {
  services?: DockerService[];
}

async function qaApp(appId: string) {
  emit({ event: 'app_start', appId, ts: Date.now() });

  const containerName = `qa-stream-${appId}`;
  const scratchDirs: string[] = [];
  let runFlags = '';
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
      // Mount an ephemeral scratch dir per declared volume so stateful apps can
      // boot for the smoke test (e.g. vaultwarden refuses to start without /data).
      for (const v of main?.volumes ?? []) {
        if (!v.containerPath) continue;
        const scratch = join(RESULTS_DIR, 'scratch', appId, String(scratchDirs.length));
        mkdirSync(scratch, { recursive: true });
        scratchDirs.push(scratch);
        runFlags += ` -v ${scratch}:${v.containerPath}`;
      }
      // Pass literal compose env (skip unresolved ${...} placeholders we can't fill).
      for (const e of main?.environment ?? []) {
        if (!e.key || e.value == null || String(e.value).includes('${')) continue;
        runFlags += ` -e ${e.key}=${shQuote(String(e.value))}`;
      }
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
    phase(appId, 'starting', `Starting container (internal port ${result.port})`);
    const startT0 = Date.now();
    // Bind a Docker-assigned host port (host side :0) so we never collide with the
    // Hub/Traefik (commonly on :80) or another app under test on the same node.
    const run = execQuiet(`docker run -d --name ${containerName} -p 0:${result.port}${runFlags} ${result.image}`, 60_000);
    if (!run.ok) {
      result.score = 'fail';
      result.notes = `Container start failed: ${run.err.slice(0, 200)}`;
      emit({ event: 'app_result', appId, result });
      return;
    }

    // Resolve the host port Docker assigned (output like "0.0.0.0:49154\n[::]:49154").
    const portMap = execQuiet(`docker port ${containerName} ${result.port}/tcp`);
    const hostPort = portMap.ok ? Number(portMap.out.split('\n')[0]?.trim().split(':').pop()) : 0;
    if (!hostPort) {
      execQuiet(`docker rm -f ${containerName}`, 30_000);
      result.score = 'fail';
      result.notes = `Could not resolve host port mapping for container :${result.port}`;
      emit({ event: 'app_result', appId, result });
      return;
    }

    // ── HTTP ──────────────────────────────────────────────────
    phase(appId, 'http', `Waiting for HTTP on host :${hostPort}`);
    let httpOk = false;
    let httpStatus = 0;
    const maxWaitMs = 90_000;
    const httpStart = Date.now();

    while (!httpOk && Date.now() - httpStart < maxWaitMs) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const res = await fetch(`http://localhost:${hostPort}/`, {
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
    if (SKIP_SCREENSHOT || config.no_gui) {
      result.hasScreenshot = false;
    } else {
      phase(appId, 'screenshot', 'Taking screenshot');
      const chromeBin = resolveChromiumBinary();
      if (chromeBin) {
        const ss = spawnSync(
          chromeBin,
          [
            '--headless=new',
            '--no-sandbox',
            '--disable-gpu',
            '--hide-scrollbars',
            `--screenshot=${screenshotPath}`,
            '--window-size=1280,800',
            '--virtual-time-budget=4000',
            `http://localhost:${hostPort}/`,
          ],
          { timeout: 30_000, stdio: 'pipe' },
        );
        result.hasScreenshot = ss.status === 0 && existsSync(screenshotPath);
      } else {
        result.hasScreenshot = false;
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
  } catch (err) {
    result.score = 'fail';
    result.notes = err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
  } finally {
    execQuiet(`docker stop ${containerName} 2>/dev/null; docker rm ${containerName} 2>/dev/null`);
    for (const d of scratchDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort scratch cleanup */
      }
    }
  }

  emit({ event: 'app_result', appId, result });
}

// ── Main ──────────────────────────────────────────────────────────────────────
const appIds = process.argv.slice(2);
if (appIds.length === 0) {
  process.stderr.write('Usage: qa-stream.ts <app-id> [app-id...]\n');
  process.exit(1);
}

// Wrapped in an async IIFE: tsx transforms this file as CommonJS (package.json
// has no "type":"module"), and CJS does not support top-level await.
void (async () => {
  emit({ event: 'batch_start', apps: appIds, storeDir: APP_STORE_DIR, ts: Date.now() });

  for (const appId of appIds) {
    await qaApp(appId);
  }

  const results = appIds.length;
  emit({ event: 'batch_done', total: results, ts: Date.now() });
})().catch((err) => {
  process.stderr.write(`qa-stream fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
