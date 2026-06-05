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

import { exec, execSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  // 1) Playwright browser cache — chrome-linux64 (newer) or chrome-linux (older).
  const base = join(home, '.cache', 'ms-playwright');
  if (existsSync(base)) {
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
  }
  // 2) System-installed Chromium/Chrome — Playwright can't install browsers on Ubuntu 26.04
  //    (support lands in PW v1.61; repo pins ^1.52), so fall back to a distro/snap browser.
  for (const p of [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ]) {
    if (existsSync(p)) return p;
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
  name?: string;
  image?: string;
  isMain?: boolean;
  internalPort?: number;
  volumes?: { hostPath?: string; containerPath?: string }[];
  environment?: { key?: string; value?: string }[];
  dependsOn?: unknown; // map {svc:{condition}} (Hub) or string[] — handled in composeUp
}

interface ComposeJson {
  services?: DockerService[];
}

async function qaApp(appId: string) {
  emit({ event: 'app_start', appId, ts: Date.now() });

  const containerName = `qa-stream-${appId}`;
  const scratchDirs: string[] = [];
  let runFlags = '';
  let services: DockerService[] = [];
  let isMulti = false;
  let statsName = containerName; // container to `docker stats` (overridden for compose path)
  let composeProject = '';
  let composeYml = '';
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

    // Skip non-HTTP apps immediately — they're CLI/MCP/stdio services, not web apps.
    // Pulling + running them just to fail the HTTP check produces misleading fail counts.
    if (config.no_gui) {
      result.score = 'skip' as 'pass' | 'warn' | 'fail';
      result.notes = 'no_gui: stdio/CLI service, no HTTP to verify';
      emit({ event: 'app_result', appId, result });
      return;
    }

    // Image from docker-compose.json (Hub V2 format) or .yml
    const composeJsonPath = join(APP_STORE_DIR, appId, 'docker-compose.json');
    const composeYmlPath = join(APP_STORE_DIR, appId, 'docker-compose.yml');

    if (existsSync(composeJsonPath)) {
      const compose: ComposeJson = JSON.parse(readFileSync(composeJsonPath, 'utf-8'));
      services = compose.services ?? [];
      isMulti = services.length > 1;
      const main = compose.services?.find((s) => s.isMain) ?? compose.services?.[0];
      result.image = main?.image ?? `${appId}:latest`;
      if (main?.internalPort) result.port = main.internalPort;
      // Single-service path only: build `docker run` flags. Multi-service apps go through
      // the compose path (composeUp) which handles volumes + ${VAR}-substituted env itself.
      if (!isMulti) {
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

    // Skip private ghcr.io/companionintelligence images — nodes have no GHCR auth
    // and these are internal CI apps not intended for the smoke-test fleet.
    const mainImg = String(result.image ?? '');
    if (mainImg.startsWith('ghcr.io/companionintelligence/')) {
      result.score = 'skip' as 'pass' | 'warn' | 'fail';
      result.notes = 'private GHCR image — requires auth not available on fleet nodes';
      emit({ event: 'app_result', appId, result });
      return;
    }

    // ── Pull + Start ──────────────────────────────────────────
    const startT0 = Date.now();
    let hostPort = 0;

    if (isMulti) {
      // Multi-service: bring up the full compose stack so DB/redis/etc. are available and
      // shared secrets line up via consistent ${VAR} substitution.
      phase(appId, 'starting', `Composing ${services.length} services`);
      const scratchBase = join(RESULTS_DIR, 'scratch', appId);
      mkdirSync(scratchBase, { recursive: true });
      scratchDirs.push(scratchBase);
      composeYml = join(scratchBase, 'docker-compose.gen.yml');
      const up = composeUp(appId, services, scratchBase, composeYml);
      composeProject = up.project;
      result.pullMs = Date.now() - startT0;
      if (!up.ok) {
        result.score = 'fail';
        result.notes = `compose up failed: ${up.err}`;
        emit({ event: 'app_result', appId, result });
        return;
      }
      hostPort = up.hostPort;
      statsName = up.statsName;
    } else {
      // Single-service: plain `docker pull` + `docker run`.
      phase(appId, 'pulling', `Pulling ${result.image}`);
      const pullT0 = Date.now();
      const pull = execQuiet(`docker pull ${result.image}`, 900_000);
      result.pullMs = Date.now() - pullT0;
      if (!pull.ok) {
        result.score = 'fail';
        result.notes = `Pull failed: ${pull.err.slice(0, 200)}`;
        emit({ event: 'app_result', appId, result });
        return;
      }
      const sizeR = execQuiet(`docker image inspect ${result.image} --format "{{.Size}}"`);
      result.imageMb = sizeR.ok ? Math.round(Number(sizeR.out) / 1024 / 1024) : 0;

      phase(appId, 'starting', `Starting container (internal port ${result.port})`);
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
      hostPort = portMap.ok ? Number(portMap.out.split('\n')[0]?.trim().split(':').pop()) : 0;
      if (!hostPort) {
        execQuiet(`docker rm -f ${containerName}`, 30_000);
        result.score = 'fail';
        result.notes = `Could not resolve host port mapping for container :${result.port}`;
        emit({ event: 'app_result', appId, result });
        return;
      }
    }

    // ── HTTP ──────────────────────────────────────────────────
    phase(appId, 'http', `Waiting for HTTP on host :${hostPort}`);
    let httpOk = false;
    let httpStatus = 0;
    const maxWaitMs = isMulti ? 180_000 : 90_000; // multi-service stacks boot slower
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
      const s = execQuiet(`docker stats ${statsName} --no-stream --format "{{.MemUsage}}|||{{.CPUPerc}}"`, 10_000);
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
    if (composeProject && composeYml) {
      execQuiet(`docker compose -p ${composeProject} -f ${composeYml} down -v --remove-orphans 2>/dev/null`, 180_000);
    } else {
      execQuiet(`docker stop ${containerName} 2>/dev/null; docker rm ${containerName} 2>/dev/null`);
    }
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

/** Resolve an app's main image from its marketplace compose (json preferred, else yml). */
function resolveMainImage(appId: string): string | null {
  const cj = join(APP_STORE_DIR, appId, 'docker-compose.json');
  const cy = join(APP_STORE_DIR, appId, 'docker-compose.yml');
  try {
    if (existsSync(cj)) {
      const compose: ComposeJson = JSON.parse(readFileSync(cj, 'utf-8'));
      const main = compose.services?.find((s) => s.isMain) ?? compose.services?.[0];
      return main?.image ?? null;
    }
    if (existsSync(cy)) {
      const m = readFileSync(cy, 'utf-8').match(/^\s*image:\s*(.+)/m);
      return m ? m[1].trim() : null;
    }
  } catch {
    return null;
  }
  return null;
}

function pullAsync(image: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    exec(`docker pull ${image}`, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err) => resolve(!err));
  });
}

/**
 * Warm the image cache before the per-app loop so heavy images don't time out on a cold pull
 * mid-test — the dominant flakiness source (gitlab/onlyoffice/openproject flip fail->pass once
 * cached). Bounded concurrency; failures are non-fatal (the per-app pull re-reports real ones).
 */
async function prepull(appIds: string[]): Promise<void> {
  const images = [...new Set(appIds.map(resolveMainImage).filter((x): x is string => !!x && !x.includes('${')))];
  if (!images.length) return;
  emit({ event: 'prepull_start', count: images.length, ts: Date.now() });
  const CONCURRENCY = 3;
  let idx = 0;
  let done = 0;
  async function worker() {
    while (idx < images.length) {
      const img = images[idx++];
      const ok = await pullAsync(img, 900_000);
      done++;
      process.stderr.write(`prepull [${done}/${images.length}] ${ok ? 'ok' : 'FAIL'} ${img}\n`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, images.length) }, () => worker()));
  emit({ event: 'prepull_done', count: images.length, ts: Date.now() });
}

/**
 * A consistent value for a ${VAR} placeholder, cached so a shared secret (e.g. a DB
 * password referenced by both the app and its db service) gets the SAME value everywhere —
 * that's what lets multi-service apps actually connect under a standalone smoke test.
 */
function valueForVar(name: string, cache: Map<string, string>, scratchBase: string): string {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  let v: string;
  if (/PASSWORD|SECRET|KEY|TOKEN|SALT|HASH/.test(name)) v = randomBytes(16).toString('hex');
  else if (/USER(NAME)?$/.test(name)) v = 'ciadmin';
  else if (/EMAIL/.test(name)) v = 'ci@ci.localhost';
  else if (/DATA_DIR$|_DIR$/.test(name)) {
    v = join(scratchBase, `var_${name.toLowerCase()}`);
    mkdirSync(v, { recursive: true });
  } else if (/DOMAIN|HOST(NAME)?$/.test(name)) v = 'ci.localhost';
  else if (/URL/.test(name)) v = 'http://localhost';
  else if (/PORT/.test(name)) v = '8080';
  else v = randomBytes(8).toString('hex');
  cache.set(name, v);
  return v;
}

const yamlStr = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Bring up a multi-service app's FULL compose stack (deps included) with consistent
 * ${VAR} substitution, publishing the main service on a Docker-assigned host port.
 * Returns the host port for the HTTP check and the main container name for `docker stats`.
 */
function composeUp(
  appId: string,
  services: DockerService[],
  scratchBase: string,
  ymlPath: string,
): { ok: boolean; hostPort: number; statsName: string; project: string; err: string } {
  const project = `qa-${appId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const cache = new Map<string, string>();
  const subst = (s: string) => s.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => valueForVar(k, cache, scratchBase));
  const main = services.find((s) => s.isMain) ?? services[0];
  const mainPort = main?.internalPort ?? 80;
  let y = 'services:\n';
  for (const s of services) {
    if (!s.name || !s.image) continue;
    y += `  ${s.name}:\n    image: ${yamlStr(subst(s.image))}\n    restart: "no"\n`;
    const env = (s.environment ?? []).filter((e) => e.key);
    if (env.length) {
      y += '    environment:\n';
      for (const e of env) y += `      ${e.key}: ${yamlStr(subst(String(e.value ?? '')))}\n`;
    }
    const vols = (s.volumes ?? []).filter((v) => v.containerPath);
    if (vols.length) {
      y += '    volumes:\n';
      for (const v of vols) {
        const cp = v.containerPath as string;
        const sc = join(scratchBase, s.name, cp.replace(/[^a-zA-Z0-9]/g, '_'));
        mkdirSync(sc, { recursive: true });
        y += `      - ${yamlStr(`${sc}:${cp}`)}\n`;
      }
    }
    const dep = s.dependsOn;
    const deps = Array.isArray(dep) ? dep.map(String) : dep && typeof dep === 'object' ? Object.keys(dep) : [];
    if (deps.length) {
      y += '    depends_on:\n';
      for (const d of deps) y += `      - ${yamlStr(String(d))}\n`; // list form drops healthcheck conditions — we poll HTTP ourselves
    }
    if (s === main) y += `    ports:\n      - "0:${mainPort}"\n`;
  }
  writeFileSync(ymlPath, y);
  const up = execQuiet(`docker compose -p ${project} -f ${ymlPath} up -d --quiet-pull`, 900_000);
  if (!up.ok) return { ok: false, hostPort: 0, statsName: '', project, err: up.err.slice(-200) };
  // docker compose port may fail if service exited before port was bound — retry briefly
  let portMap = execQuiet(`docker compose -p ${project} -f ${ymlPath} port ${main?.name} ${mainPort}`);
  if (!portMap.ok) {
    execQuiet('sleep 3');
    portMap = execQuiet(`docker compose -p ${project} -f ${ymlPath} port ${main?.name} ${mainPort}`);
  }
  const hostPort = portMap.ok ? Number(portMap.out.split('\n')[0]?.trim().split(':').pop()) : 0;
  return { ok: hostPort > 0, hostPort, statsName: `${project}-${main?.name}-1`, project, err: hostPort > 0 ? '' : 'no host port mapping' };
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

  // Warm the image cache first so per-app pulls hit cache instead of timing out cold.
  await prepull(appIds);

  for (const appId of appIds) {
    await qaApp(appId);
  }

  const results = appIds.length;
  emit({ event: 'batch_done', total: results, ts: Date.now() });
})().catch((err) => {
  process.stderr.write(`qa-stream fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
