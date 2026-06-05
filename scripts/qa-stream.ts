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
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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
  user?: string; // run-as user (uid[:gid] or name) — honored by the real Hub builder (service.builder.ts setUser); mirrored here
  command?: string[] | string; // entrypoint override; carries DB migration/predeploy steps for some apps
  volumes?: { hostPath?: string; containerPath?: string }[];
  environment?: { key?: string; value?: string }[];
  dependsOn?: unknown; // map {svc:{condition}} (Hub) or string[] — handled in composeUp
  healthCheck?: {
    test?: string[] | string;
    interval?: string;
    timeout?: string;
    retries?: number;
    startPeriod?: string;
  };
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
        // Substitute ${VAR} placeholders with consistent values (admin passwords, secret keys,
        // etc.) instead of dropping them — dropping them is why single-service apps booted with
        // no credentials set and had broken logins. Same substitution the compose path uses.
        const cache = new Map<string, string>();
        const scratchBase = join(RESULTS_DIR, 'scratch', appId);
        const subst = (s: string) => s.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => valueForVar(k, cache, scratchBase));
        for (const e of main?.environment ?? []) {
          if (!e.key || e.value == null) continue;
          runFlags += ` -e ${e.key}=${shQuote(subst(String(e.value)))}`;
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

    const mainImg = String(result.image ?? '');
    // Skip private CI images (require GHCR auth not available on fleet nodes).
    if (mainImg.startsWith('ghcr.io/companionintelligence/')) {
      result.score = 'skip' as 'pass' | 'warn' | 'fail';
      result.notes = 'private GHCR image — requires auth not available on fleet nodes';
      emit({ event: 'app_result', appId, result });
      return;
    }
    // Skip VM images (dockurr/macos, dockurr/windows) — require KVM/nested virt.
    if (mainImg.startsWith('dockurr/')) {
      result.score = 'skip' as 'pass' | 'warn' | 'fail';
      result.notes = 'VM image — requires KVM/nested virtualisation unavailable on fleet nodes';
      emit({ event: 'app_result', appId, result });
      return;
    }
    // Skip images with explicit GPU/ROCm markers — require CUDA/ROCm hardware.
    if (/rocm|amd-strix|:cuda|\.cuda/i.test(mainImg)) {
      result.score = 'skip' as 'pass' | 'warn' | 'fail';
      result.notes = 'GPU image — requires CUDA/ROCm hardware unavailable on fleet nodes';
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
        // Classify compose failures the same as single-service pull failures
        if (/failed to authorize|unauthorized|denied|authentication required/i.test(up.err)) {
          result.score = 'skip' as 'pass' | 'warn' | 'fail';
          result.notes = 'registry auth required for dependency image';
          emit({ event: 'app_result', appId, result });
          return;
        }
        if (/manifest unknown|not found|does not exist|404/i.test(up.err)) {
          result.score = 'skip' as 'pass' | 'warn' | 'fail';
          result.notes = 'dependency image not found in registry';
          emit({ event: 'app_result', appId, result });
          return;
        }
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
        const errText = pull.err + pull.out;
        // Image doesn't exist in any registry → skip (broken marketplace entry, not a test failure)
        if (/manifest unknown|not found|does not exist|404|no such image/i.test(errText)) {
          result.score = 'skip' as 'pass' | 'warn' | 'fail';
          result.notes = 'image not found in registry — broken marketplace entry';
          emit({ event: 'app_result', appId, result });
          return;
        }
        // Auth failure on any registry (not just CI images caught above) → skip
        if (/failed to authorize|unauthorized|denied|authentication required/i.test(errText)) {
          result.score = 'skip' as 'pass' | 'warn' | 'fail';
          result.notes = 'registry auth required — no credentials on fleet nodes';
          emit({ event: 'app_result', appId, result });
          return;
        }
        result.score = 'fail';
        result.notes = `Pull failed: ${errText.slice(0, 200)}`;
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

    // ── Readiness ─────────────────────────────────────────────
    // Wait for the app to become ready using THREE signals — a bare HTTP-on-/ poll tests the
    // wrong thing (too short for slow boots, and it burns the whole ceiling on already-dead apps):
    //   (1) the container's own Docker healthcheck reports "healthy"  -> ready (authoritative)
    //   (2) HTTP on / returns < 500                                   -> ready
    //   (3) the backend container has exited or is restart-looping    -> FAIL FAST (don't wait)
    // Generous ceiling: heavy apps run DB migrations on first boot that take minutes.
    // Override with QA_READY_TIMEOUT_MS.
    phase(appId, 'http', `Waiting for ${appId} to become ready on :${hostPort}`);
    const maxWaitMs = Number(process.env.QA_READY_TIMEOUT_MS) || (isMulti ? 600_000 : 300_000);
    const readyStart = Date.now();
    let httpStatus = 0;
    let ready = false;
    let readyVia = '';
    let deadReason = '';

    while (!ready && Date.now() - readyStart < maxWaitMs) {
      await new Promise((r) => setTimeout(r, 3000));
      // (3) + (1): inspect the main container — fail fast if dead/looping, succeed if healthcheck passes.
      const ins = execQuiet(
        `docker inspect ${statsName} --format '{{.State.Status}}|{{.RestartCount}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'`,
        8_000,
      );
      if (ins.ok) {
        const [st, rc, health] = (ins.out || '').split('|');
        const restarts = Number(rc || 0);
        if (st === 'exited' || st === 'dead') {
          deadReason = `container ${st}`;
          break;
        }
        if (restarts >= 4) {
          deadReason = `restart loop (${restarts} restarts)`;
          break;
        }
        if (health === 'healthy') {
          ready = true;
          readyVia = 'healthcheck';
        }
      }
      if (ready) break;
      // (2) HTTP probe
      try {
        const res = await fetch(`http://localhost:${hostPort}/`, { signal: AbortSignal.timeout(4000) });
        httpStatus = res.status;
        if (httpStatus < 500) {
          ready = true;
          readyVia = `http ${httpStatus}`;
        }
      } catch {
        // not serving yet
      }
    }

    result.httpStatus = httpStatus;
    result.startupMs = Date.now() - readyStart;
    result.readyVia = readyVia;

    if (!ready) {
      const bh = captureBackendHealth({ composeProject, composeYml, containerName });
      result.backendErrors = bh.errors;
      result.score = 'fail';
      const waited = Math.round((Date.now() - readyStart) / 1000);
      result.notes =
        (deadReason ? `backend ${deadReason} after ${waited}s` : `not ready within ${Math.round(maxWaitMs / 1000)}s`) +
        (bh.down.length ? ` — down: ${bh.down.join(', ')}` : '') +
        (bh.errors ? ` | ${bh.errors.replace(/\s+/g, ' ').slice(0, 200)}` : '');
      emit({ event: 'app_result', appId, result });
      return;
    }

    // Backend health: the frontend served, but a backend service may be crashed/restarting
    // (the "page loads, login broken" case). Capture it so it isn't a false pass.
    const backend = captureBackendHealth({ composeProject, composeYml, containerName });
    result.backendHealthy = backend.healthy;
    if (!backend.healthy) {
      result.backendDown = backend.down;
      result.backendErrors = backend.errors;
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
    // A served frontend with a crashed/restarting backend is NOT a pass — flag it as a
    // degraded warn with the failing service + error excerpt so it's fixable, not hidden.
    if (result.backendHealthy === false) {
      result.score = 'warn';
      result.notes =
        `frontend serves but backend degraded — down: ${(result.backendDown as string[]).join(', ')}` +
        (result.backendErrors ? ` | ${String(result.backendErrors).replace(/\s+/g, ' ').slice(0, 200)}` : '');
    }
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
      wipeScratchTree(d);
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
 * Remove a scratch tree completely, including stateful-service data dirs that Postgres/redis
 * write as uid 999/root — a plain rmSync run as the non-root fleet user can't delete those, so
 * fall back to a throwaway root container. Best-effort: an empty mountpoint may linger, but the
 * run-poisoning contents (a stale pgdata that pins the previous run's POSTGRES_PASSWORD) are gone.
 */
function wipeScratchTree(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* root-owned data below blocks rmSync — wiped via a root container next */
  }
  if (existsSync(dir)) {
    execQuiet(`docker run --rm -v ${shQuote(dir)}:/scratch alpine find /scratch -mindepth 1 -delete`, 60_000);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort: contents are root-removed; an empty mountpoint may linger */
    }
  }
}

/**
 * If a volume's hostPath points under the app's source `data/` subtree AND a seed file/dir exists
 * there, return its absolute source path so composeUp can copy it into the scratch mount. This
 * mirrors the real Hub, whose marketplaceService.copyDataDir seeds ${APP_DATA_DIR}/data/... from
 * the app source BEFORE `compose up` — without it a config FILE target (e.g. nginx default.conf)
 * gets an empty DIR bind-mounted over it and compose aborts ("mount a directory onto a file"), and
 * dir seeds like data/initdb/*.sql silently never run. Returns null for runtime-only volumes
 * (pgdata, redis, storage, minio) that have no source seed and must start empty.
 */
function seedSourceFor(appId: string, hostPath?: string): string | null {
  if (!hostPath) return null;
  // hostPath is like "${APP_DATA_DIR}/data/nginx/nginx.conf" — strip the leading ${VAR}/ so the
  // remainder is the app-relative path, which equals the path under the app's source directory.
  const rel = hostPath.replace(/^\$\{[A-Z0-9_]+\}\/+/, '');
  // Only ever seed from the data/ subtree; refuse traversal/absolute paths.
  if (rel.includes('..') || rel.startsWith('/') || !(rel === 'data' || rel.startsWith('data/'))) return null;
  const src = join(APP_STORE_DIR, appId, rel);
  return existsSync(src) ? src : null;
}

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
  // Start from a clean scratch tree (scoped to THIS app's scratchBase). Postgres only applies
  // POSTGRES_PASSWORD on first init of an EMPTY data dir, but valueForVar mints a fresh
  // ${...DB_PASSWORD} every run — a pgdata left behind by a prior run (e.g. one killed before the
  // finally cleanup ran) keeps the OLD password while cloud/gotrue connect with the NEW one, so
  // they fail "password authentication failed for user postgres" and the backend reports unhealthy.
  // Wiping here also lets data/initdb/*.sql re-run each time. Robust against root/uid-999 pgdata.
  wipeScratchTree(scratchBase);
  mkdirSync(scratchBase, { recursive: true });
  const cache = new Map<string, string>();
  const subst = (s: string) => s.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => valueForVar(k, cache, scratchBase));
  const main = services.find((s) => s.isMain) ?? services[0];
  const mainPort = main?.internalPort ?? 80;
  // Services that declare a healthcheck: a depends_on may only request `service_healthy`
  // against these — asking it of a service without one makes `compose up` error out.
  const hasHealthcheck = new Set(services.filter((s) => s.name && s.healthCheck?.test).map((s) => s.name as string));
  let y = 'services:\n';
  for (const s of services) {
    if (!s.name || !s.image) continue;
    y += `  ${s.name}:\n    image: ${yamlStr(subst(s.image))}\n    restart: "no"\n`;
    // Run-as user — mirror the real Hub builder (service.builder.ts emits `user:`). Dropping it
    // diverges from production: an app that sets `user` (or expects the image default once a
    // manifest stops forcing `user: root`) otherwise runs under the wrong uid and fails spuriously.
    if (s.user != null && String(s.user).length) {
      y += `    user: ${yamlStr(subst(String(s.user)))}\n`;
    }
    // Command override — for some apps (e.g. affine) this is the ONLY thing that runs the
    // DB migration/predeploy step; dropping it boots the app against an empty schema and
    // crashes with `relation "..." does not exist`.
    if (s.command !== undefined) {
      if (Array.isArray(s.command)) {
        y += '    command:\n';
        for (const c of s.command) y += `      - ${yamlStr(subst(String(c)))}\n`;
      } else {
        y += `    command: ${yamlStr(subst(String(s.command)))}\n`;
      }
    }
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
        // Seed the mount from the app's source data/ subtree (mirrors Hub copyDataDir) so config
        // FILE targets and initdb scripts exist before compose up; otherwise an empty dir is mounted.
        const seed = seedSourceFor(appId, v.hostPath);
        if (seed && statSync(seed).isFile()) {
          // File target (e.g. nginx default.conf): the scratch mount must itself be a FILE so the
          // bind is file:file — mounting a dir onto a file is what aborts `compose up`.
          mkdirSync(dirname(sc), { recursive: true });
          rmSync(sc, { recursive: true, force: true });
          cpSync(seed, sc);
        } else if (seed) {
          // Directory seed (e.g. data/initdb → /docker-entrypoint-initdb.d): copy its contents in.
          mkdirSync(sc, { recursive: true });
          cpSync(seed, sc, { recursive: true });
        } else {
          // No source seed: ephemeral runtime dir (pgdata/redis/storage/minio), fresh + empty.
          mkdirSync(sc, { recursive: true });
        }
        // The scratch dir is created owned by the harness user (uid 1001 `ci`). Images that run
        // as a different uid (n8n's `node`=1000, mattermost=2000, …) can't write a 1001-owned bind
        // mount → spurious EACCES and a false fail. Make the dir writable by any runtime uid;
        // teardown wipes non-owned content via a throwaway root container. (File mounts — read-only
        // config — are left untouched so we don't trip apps that reject world-writable config.)
        if (statSync(sc).isDirectory()) chmodSync(sc, 0o777);
        y += `      - ${yamlStr(`${sc}:${cp}`)}\n`;
      }
    }
    // Healthcheck — emitted so dependents can wait on `service_healthy` (below). A scalar
    // `test` string is interpreted by compose as CMD-SHELL; an array form carries its own
    // CMD / CMD-SHELL prefix. ${VAR}s (e.g. DB passwords) are substituted like everywhere else.
    const hc = s.healthCheck;
    if (hc?.test) {
      y += '    healthcheck:\n';
      if (Array.isArray(hc.test)) {
        y += '      test:\n';
        for (const t of hc.test) y += `        - ${yamlStr(subst(String(t)))}\n`;
      } else {
        y += `      test: ${yamlStr(subst(String(hc.test)))}\n`;
      }
      if (hc.interval) y += `      interval: ${yamlStr(String(hc.interval))}\n`;
      if (hc.timeout) y += `      timeout: ${yamlStr(String(hc.timeout))}\n`;
      if (hc.retries != null) y += `      retries: ${hc.retries}\n`;
      if (hc.startPeriod) y += `      start_period: ${yamlStr(String(hc.startPeriod))}\n`;
    }
    const dep = s.dependsOn;
    if (Array.isArray(dep) && dep.length) {
      y += '    depends_on:\n';
      for (const d of dep) y += `      - ${yamlStr(String(d))}\n`;
    } else if (dep && typeof dep === 'object') {
      // Map form {svc:{condition}} — render conditions so the main service waits for
      // postgres/redis to be healthy before its migration command runs. Downgrade
      // `service_healthy` to `service_started` when the target declares no healthcheck,
      // since compose rejects `service_healthy` against a service without one.
      const entries = Object.entries(dep as Record<string, unknown>);
      if (entries.length) {
        y += '    depends_on:\n';
        for (const [name, spec] of entries) {
          const want = spec && typeof spec === 'object' ? String((spec as { condition?: string }).condition ?? '') : '';
          const cond = want === 'service_healthy' && !hasHealthcheck.has(name) ? 'service_started' : want || 'service_started';
          y += `      ${name}:\n        condition: ${cond}\n`;
        }
      }
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

/**
 * Inspect whether the app's BACKEND is actually healthy — a frontend can serve HTTP 200
 * while a backend service (db, api, worker) is crashed/restarting, which is exactly the
 * "page loads but login is broken" failure. Returns down services + a scan of their error
 * logs. Cheap when healthy (no log fetch).
 */
function captureBackendHealth(o: { composeProject: string; composeYml: string; containerName: string }): {
  healthy: boolean;
  down: string[];
  errors: string;
} {
  const ERR = `grep -iE 'error|fatal|fail|refused|denied|panic|cannot|unable|exception|no such host' | tail -8`;
  if (o.composeProject && o.composeYml) {
    const ps = execQuiet(`docker compose -p ${o.composeProject} -f ${o.composeYml} ps -a --format '{{.Service}}|{{.State}}'`, 20_000);
    const down: string[] = [];
    for (const line of ps.out.split('\n')) {
      const [svc, state] = line.split('|');
      if (svc && state && !/running|^up/i.test(state.trim())) down.push(`${svc}(${state.trim()})`);
    }
    let errors = '';
    if (down.length) {
      const logs = execQuiet(`docker compose -p ${o.composeProject} -f ${o.composeYml} logs --tail 25 2>&1 | ${ERR}`, 25_000);
      errors = logs.out.slice(-700);
    }
    return { healthy: down.length === 0, down, errors };
  }
  const st = execQuiet(`docker inspect ${o.containerName} --format '{{.State.Status}}|{{.RestartCount}}'`);
  const [status, restarts] = (st.out || '|').split('|');
  const restartCount = Number(restarts || 0);
  const healthy = status === 'running' && restartCount < 3;
  let errors = '';
  if (!healthy) {
    const logs = execQuiet(`docker logs --tail 25 ${o.containerName} 2>&1 | ${ERR}`, 20_000);
    errors = logs.out.slice(-700);
  }
  return { healthy, down: healthy ? [] : [`main(${status},restarts=${restartCount})`], errors };
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
