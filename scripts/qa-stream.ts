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

// Durable results — qa-aggregate.ts SCPs results.json (an array of QAResult) and
// batch-<N>-summary.json off each node. We append every app result here as it finishes
// so a long run survives an SSH drop, and write the batch summary on batch_done.
const RESULTS_JSON = join(RESULTS_DIR, 'results.json');
const QA_BATCH = process.env.QA_BATCH ?? '0';
const BATCH_SUMMARY_JSON = join(RESULTS_DIR, `batch-${QA_BATCH}-summary.json`);

// Intra-node concurrency: how many apps run in parallel on ONE node. Default 2 — each app is
// fully isolated (ephemeral `-p 0:`, `qa-<app>` compose project, per-app scratch dir) so they
// don't collide. Multi-service apps are heavier (DB+redis+app), so they consume 2 pool slots.
const QA_CONCURRENCY = Math.max(1, Number(process.env.QA_CONCURRENCY) || 2);

// Optional per-container resource caps (off by default). When set, applied to the single-service
// `docker run` (--memory/--cpus) and to every generated compose service (mem_limit/cpus). Keeps a
// runaway app from starving its neighbours once apps run concurrently.
const QA_MEM_LIMIT = process.env.QA_MEM_LIMIT?.trim() || ''; // e.g. "1g", "512m"
const QA_CPU_LIMIT = process.env.QA_CPU_LIMIT?.trim() || ''; // e.g. "1.5", "2"

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

/**
 * Map qa-stream's internal `result` object onto the QAResult shape qa-aggregate.ts consumes
 * (memoryMb/imageSizeMb/cpuPercent/timestamp/…). Field names differ between the two — this is
 * the single place that bridges them so results.json stays loadable by the aggregator.
 */
type Score = 'pass' | 'warn' | 'fail' | 'skip' | 'error' | 'timeout';

function toQAResult(result: Record<string, unknown>): Record<string, unknown> {
  const ts = typeof result.ts === 'number' ? result.ts : Date.now();
  return {
    appId: result.appId,
    name: result.name ?? result.appId,
    image: result.image ?? '',
    port: result.port ?? 0,
    imageSizeMb: result.imageMb ?? 0,
    pullTimeMs: result.pullMs ?? 0,
    startupMs: result.startupMs ?? 0,
    responseTimeMs: 0, // not separately measured by the stream runner
    memoryMb: result.memMb ?? 0,
    memoryPeakMb: result.memPeakMb ?? 0,
    cpuPercent: result.cpuPct ?? 0,
    httpStatus: result.httpStatus ?? 0,
    screenshotPath: result.hasScreenshot ? join(SCREENSHOTS_DIR, `${result.appId}.png`) : null,
    score: result.score ?? 'fail',
    notes: result.notes ?? '',
    retried: result.retried ?? false,
    attempts: result.attempts ?? 1,
    timestamp: new Date(ts).toISOString(),
  };
}

/**
 * Append one app's result to $RESULTS_DIR/results.json as an array element. Read-modify-write
 * (the runner is the only writer and apps finish one event at a time, even under the worker pool —
 * the JS event loop serializes these synchronous writes). Best-effort: a durable-store failure must
 * never fail the run, since the authoritative result already went out over stdout.
 */
function appendDurableResult(result: Record<string, unknown>): void {
  try {
    let arr: unknown[] = [];
    if (existsSync(RESULTS_JSON)) {
      try {
        const parsed = JSON.parse(readFileSync(RESULTS_JSON, 'utf-8'));
        if (Array.isArray(parsed)) arr = parsed;
      } catch {
        /* corrupt/partial file — start fresh rather than lose this result */
      }
    }
    arr.push(toQAResult(result));
    writeFileSync(RESULTS_JSON, JSON.stringify(arr, null, 2));
  } catch (e) {
    process.stderr.write(`results.json append failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

/**
 * Emit an app_result over stdout (the live, authoritative channel the fleet server reads) AND
 * append it to the durable results.json. Every per-app return path goes through this, so a run
 * that loses its SSH pipe still leaves a complete results.json behind for qa-aggregate.ts.
 */
function emitResult(appId: string, result: Record<string, unknown>) {
  emit({ event: 'app_result', appId, result });
  appendDurableResult(result);
}

/** Single-quote a value for safe interpolation into a shell command. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function execQuiet(cmd: string, timeoutMs = 120_000): { ok: boolean; out: string; err: string; ms: number } {
  const t = Date.now();
  try {
    // killSignal SIGKILL (not the default SIGTERM): a `docker` CLI blocked on a wedged daemon
    // socket ignores SIGTERM, which would let the call hang past `timeoutMs` and freeze the whole
    // node's pool. SIGKILL force-reaps it so the timeout is a real wall.
    const out = execSync(cmd, { encoding: 'utf-8', stdio: 'pipe', timeout: timeoutMs, killSignal: 'SIGKILL' }).trim();
    return { ok: true, out, err: '', ms: Date.now() - t };
  } catch (e: unknown) {
    const err = e instanceof Error ? e.message : String(e);
    return { ok: false, out: '', err, ms: Date.now() - t };
  }
}

/**
 * Async, non-blocking variant of execQuiet — and the reason the per-app watchdog can actually fire.
 * execSync (execQuiet) blocks the single Node thread for the whole call, so a JS timer set in qaApp
 * can't preempt a stalled docker op. Every post-pull docker op inside attemptApp (readiness inspect,
 * backend health, stats, teardown) runs through this instead, keeping the event loop free so the
 * watchdog timer and the readiness deadline check stay live. SIGKILL on timeout (see execQuiet).
 */
function execAsync(cmd: string, timeoutMs = 120_000): Promise<{ ok: boolean; out: string; err: string; ms: number }> {
  const t = Date.now();
  return new Promise((resolve) => {
    exec(cmd, { encoding: 'utf-8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 }, (e, stdout, stderr) => {
      const out = (stdout ?? '').toString().trim();
      if (e) resolve({ ok: false, out, err: `${(stderr ?? '').toString()}${e.message ?? ''}`, ms: Date.now() - t });
      else resolve({ ok: true, out, err: '', ms: Date.now() - t });
    });
  });
}

// Teardowns the watchdog kicks off in the background (it must NOT block dispatch). Tracked so the
// process can give them a bounded grace to finish before it force-exits — otherwise process.exit(0)
// races the `docker rm -f` and leaks the container.
const pendingTeardowns = new Set<Promise<void>>();
function trackTeardown(p: Promise<void>): void {
  const tracked = p.catch(() => {
    /* best-effort */
  });
  pendingTeardowns.add(tracked);
  void tracked.finally(() => pendingTeardowns.delete(tracked));
}
/** Give in-flight background teardowns up to graceMs to finish, then return regardless (never hang). */
async function drainTeardowns(graceMs: number): Promise<void> {
  if (!pendingTeardowns.size) return;
  await Promise.race([Promise.allSettled([...pendingTeardowns]), new Promise((r) => setTimeout(r, graceMs))]);
}

/**
 * Tear an app's containers down without ever blocking — called from attemptApp's `finally` AND from
 * the per-app watchdog (which only knows the appId/containerName, not the live compose handles).
 * Best-effort and SIGKILL-bounded: a wedged daemon can't stall it. Idempotent — `docker rm -f` and
 * `compose down` on a nonexistent container/project are fast no-ops — so it's safe to call from both
 * paths (and twice for one app: watchdog + the abandoned attempt's finally).
 */
async function forceTeardown(o: {
  appId: string;
  containerName: string;
  composeProject?: string;
  composeYml?: string;
  scratchDirs?: string[];
}): Promise<void> {
  const project = (o.composeProject || `qa-${o.appId}`).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const ymlRef = o.composeYml ? `-f ${o.composeYml}` : '';
  // Compose teardown (operates on the project by name when we have no yml — compose v2 matches the
  // project label), then a single-container force-remove. One of the two is a no-op per app shape.
  await execAsync(`docker compose -p ${project} ${ymlRef} down -v --remove-orphans 2>/dev/null`, 150_000);
  await execAsync(`docker rm -f ${o.containerName} 2>/dev/null`, 30_000);
  for (const d of o.scratchDirs ?? []) {
    try {
      wipeScratchTree(d);
    } catch {
      /* best-effort — a wipe failure must never block dispatch */
    }
  }
}

interface AppConfig {
  name?: string;
  port?: number;
  url_suffix?: string;
  no_gui?: boolean;
  categories?: string[];
}

interface HealthCheck {
  test?: string[] | string;
  interval?: string;
  timeout?: string;
  retries?: number;
  startPeriod?: string;
  start_period?: string; // lowercase manifests use snake_case
}

interface DockerService {
  name?: string;
  image?: string;
  isMain?: boolean;
  internalPort?: number;
  user?: string; // run-as user (uid[:gid] or name) — honored by the real Hub builder (service.builder.ts setUser); mirrored here
  command?: string[] | string; // entrypoint override; carries DB migration/predeploy steps for some apps
  // Host-privilege fields — mirror the real Hub builder (service.builder.ts). Dropping them is a
  // spurious fail: steam-headless declares `privileged: true` and dies on `mount: /proc: permission
  // denied` without it; pi-hole/netdata/home-assistant/searxng/collabora etc. need caps/devices.
  privileged?: boolean;
  capAdd?: string[];
  devices?: string[];
  securityOpt?: string[];
  sysctls?: Record<string, number | string>;
  dns?: string | string[];
  extraHosts?: string[];
  volumes?: { hostPath?: string; containerPath?: string }[];
  environment?: { key?: string; value?: string }[];
  dependsOn?: unknown; // map {svc:{condition}} (Hub) or string[] — handled in composeUp
  healthCheck?: HealthCheck;
  healthcheck?: HealthCheck; // lowercase variant — some manifests (documenso/matomo/nextcloud/nocodb/passbolt) use it; honor both
  // GPU reservation (compose `deploy.resources.reservations.devices`). Apps that reserve an
  // nvidia/gpu device REQUIRE host GPU hardware the fleet nodes don't have — detected so they're
  // classified as skip(gpu) rather than counted as a fail when they refuse to boot.
  deploy?: {
    resources?: {
      reservations?: {
        devices?: { driver?: string; capabilities?: string[]; count?: number | string }[];
      };
    };
  };
}

interface ComposeJson {
  services?: DockerService[];
}

/**
 * True if ANY service in the stack requires a GPU — either it reserves an nvidia/gpu device via
 * compose `deploy.resources.reservations.devices`, or its image is a GPU-only build (rocm/cuda/
 * amd-strix). Such apps can't run on the GPU-less fleet nodes, so they're a skip(gpu), not a fail.
 */
function requiresGpu(services: DockerService[]): boolean {
  for (const s of services) {
    if (s.image && /rocm|cuda|amd-strix/i.test(s.image)) return true;
    const devices = s.deploy?.resources?.reservations?.devices ?? [];
    for (const d of devices) {
      if (d.driver === 'nvidia') return true;
      if ((d.capabilities ?? []).some((c) => /gpu|nvidia|compute/i.test(c))) return true;
    }
  }
  return false;
}

async function attemptApp(appId: string): Promise<Record<string, unknown>> {
  emit({ event: 'app_start', appId, ts: Date.now() });

  const containerName = `qa-stream-${appId}`;
  const scratchDirs: string[] = [];
  let runFlags = '';
  let cmdSuffix = ''; // single-service manifest `command`, appended after the image in `docker run`
  let services: DockerService[] = [];
  let isMulti = false;
  let statsName = containerName; // container to `docker stats` (overridden for compose path)
  let composeProject = '';
  let composeYml = '';
  const result: Record<string, unknown> = {
    appId,
    score: 'fail' as Score,
    notes: '',
    ts: Date.now(),
  };

  // Cleanup stale container
  execQuiet(`docker stop ${containerName} 2>/dev/null; docker rm ${containerName} 2>/dev/null`);

  try {
    // ── Config ────────────────────────────────────────────────
    const configPath = join(APP_STORE_DIR, appId, 'config.json');
    if (!existsSync(configPath)) {
      result.score = 'error';
      result.failKind = 'config';
      result.notes = `config.json not found at ${configPath}`;
      return result;
    }

    const config: AppConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    result.name = config.name ?? appId;
    result.port = config.port ?? 80;
    result.categories = config.categories ?? [];

    // Skip non-HTTP apps immediately — they're CLI/MCP/stdio services, not web apps.
    // Pulling + running them just to fail the HTTP check produces misleading fail counts.
    if (config.no_gui) {
      result.score = 'skip' as Score;
      result.notes = 'no_gui: stdio/CLI service, no HTTP to verify';
      return result;
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
          // Seed the mount from the app's source data/ subtree (mirrors Hub copyDataDir + the
          // composeUp path) so config FILE targets and seeded dirs (e.g. quarkdown's docs/main.qd)
          // exist before boot — previously this path mounted an empty dir and seed-reliant apps failed.
          const seed = seedSourceFor(appId, v.hostPath);
          if (seed && statSync(seed).isFile()) {
            mkdirSync(dirname(scratch), { recursive: true });
            rmSync(scratch, { recursive: true, force: true });
            cpSync(seed, scratch); // file:file bind
          } else if (seed) {
            mkdirSync(scratch, { recursive: true });
            cpSync(seed, scratch, { recursive: true });
          } else {
            mkdirSync(scratch, { recursive: true });
          }
          if (statSync(scratch).isDirectory()) chmodSync(scratch, 0o777); // any runtime uid can write
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
        // Host-privilege flags — mirror the Hub builder (service.builder.ts). steam-headless
        // declares `privileged: true` and dies on `mount: /proc: permission denied` without it;
        // pi-hole/searxng/anything-llm/collabora need cap_add; home-assistant needs devices.
        if (main?.privileged === true) runFlags += ' --privileged';
        for (const c of main?.capAdd ?? []) runFlags += ` --cap-add ${shQuote(String(c))}`;
        for (const d of main?.devices ?? []) runFlags += ` --device ${shQuote(subst(String(d)))}`;
        for (const so of main?.securityOpt ?? []) runFlags += ` --security-opt ${shQuote(String(so))}`;
        for (const [k, val] of Object.entries(main?.sysctls ?? {})) runFlags += ` --sysctl ${shQuote(`${k}=${val}`)}`;
        // dns / extra_hosts — mirror the Hub builder. vui needs a fixed resolver; some apps need host.docker.internal.
        for (const d of Array.isArray(main?.dns) ? main!.dns : main?.dns ? [String(main.dns)] : []) runFlags += ` --dns ${shQuote(String(d))}`;
        for (const eh of main?.extraHosts ?? []) runFlags += ` --add-host ${shQuote(subst(String(eh)))}`;
        // Manifest `command` override — the single-service path used to run the image's DEFAULT cmd,
        // so apps that declare `command` (e.g. quarkdown's preview server) ran the wrong process and
        // false-failed. docker run takes command+args AFTER the image: array = exec form (args as-is);
        // a plain string is a shell command (match compose's `sh -c`).
        if (main?.command !== undefined) {
          cmdSuffix = Array.isArray(main.command)
            ? ` ${main.command.map((c) => shQuote(subst(String(c)))).join(' ')}`
            : ` sh -c ${shQuote(subst(String(main.command)))}`;
        }
      }
    } else if (existsSync(composeYmlPath)) {
      const yml = readFileSync(composeYmlPath, 'utf-8');
      const m = yml.match(/^\s*image:\s*(.+)/m);
      result.image = m ? m[1].trim() : `${appId}:latest`;
    } else {
      result.score = 'error';
      result.failKind = 'config';
      result.notes = 'No docker-compose.json or docker-compose.yml';
      return result;
    }

    const mainImg = String(result.image ?? '');
    // Skip private CI images (require GHCR auth not available on fleet nodes).
    if (mainImg.startsWith('ghcr.io/companionintelligence/')) {
      result.score = 'skip' as Score;
      result.notes = 'private GHCR image — requires auth not available on fleet nodes';
      return result;
    }
    // Skip VM images (dockurr/macos, dockurr/windows) — require KVM/nested virt.
    if (mainImg.startsWith('dockurr/')) {
      result.score = 'skip' as Score;
      result.notes = 'VM image — requires KVM/nested virtualisation unavailable on fleet nodes';
      return result;
    }
    // Skip GPU-required apps — detected via compose `deploy.reservations.devices` (nvidia/gpu) on
    // ANY service, or a GPU-only image build (rocm/cuda/amd-strix). These need GPU hardware the
    // fleet nodes lack, so they're skip(gpu) — NOT a fail. (This stops hunyuan3d and similar image-
    // /video-gen apps from showing as false fails.) `reason:"gpu"` lets the dashboard bucket them.
    if (requiresGpu(services) || /rocm|amd-strix|:cuda|\.cuda/i.test(mainImg)) {
      result.score = 'skip' as Score;
      result.reason = 'gpu';
      result.notes = 'requires GPU (nvidia device reservation or rocm/cuda image) — no GPU on fleet nodes';
      return result;
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
          result.score = 'skip' as Score;
          result.notes = 'registry auth required for dependency image';
          return result;
        }
        if (/manifest unknown|not found|does not exist|404/i.test(up.err)) {
          result.score = 'skip' as Score;
          result.notes = 'dependency image not found in registry';
          return result;
        }
        result.score = 'error';
        result.failKind = 'compose';
        result.notes = `compose up failed: ${up.err}`;
        return result;
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
          result.score = 'skip' as Score;
          result.notes = 'image not found in registry — broken marketplace entry';
          return result;
        }
        // Auth failure on any registry (not just CI images caught above) → skip
        if (/failed to authorize|unauthorized|denied|authentication required/i.test(errText)) {
          result.score = 'skip' as Score;
          result.notes = 'registry auth required — no credentials on fleet nodes';
          return result;
        }
        result.score = 'error';
        result.failKind = 'pull';
        result.notes = `Pull failed: ${errText.slice(0, 200)}`;
        return result;
      }
      const sizeR = execQuiet(`docker image inspect ${result.image} --format "{{.Size}}"`);
      result.imageMb = sizeR.ok ? Math.round(Number(sizeR.out) / 1024 / 1024) : 0;

      phase(appId, 'starting', `Starting container (internal port ${result.port})`);
      // Optional resource caps (off unless QA_MEM_LIMIT/QA_CPU_LIMIT set) — keep one runaway app
      // from starving its neighbours now that apps run concurrently on a node.
      const capFlags = (QA_MEM_LIMIT ? ` --memory ${QA_MEM_LIMIT}` : '') + (QA_CPU_LIMIT ? ` --cpus ${QA_CPU_LIMIT}` : '');
      // Bind a Docker-assigned host port (host side :0) so we never collide with the
      // Hub/Traefik (commonly on :80) or another app under test on the same node.
      const run = execQuiet(`docker run -d --name ${containerName} -p 0:${result.port}${capFlags}${runFlags} ${result.image}${cmdSuffix}`, 60_000);
      if (!run.ok) {
        result.score = 'error';
        result.failKind = 'start';
        result.notes = `Container start failed: ${run.err.slice(0, 200)}`;
        return result;
      }
      // Resolve the host port Docker assigned (output like "0.0.0.0:49154\n[::]:49154").
      const portMap = execQuiet(`docker port ${containerName} ${result.port}/tcp`);
      hostPort = portMap.ok ? Number(portMap.out.split('\n')[0]?.trim().split(':').pop()) : 0;
      if (!hostPort) {
        execQuiet(`docker rm -f ${containerName}`, 30_000);
        result.score = 'error';
        result.failKind = 'portmap';
        result.notes = `Could not resolve host port mapping for container :${result.port}`;
        return result;
      }
    }

    // ── Readiness ─────────────────────────────────────────────
    // Wait for the app to become ready using THREE signals — a bare HTTP-on-/ poll tests the
    // wrong thing (too short for slow boots, and it burns the whole ceiling on already-dead apps):
    //   (1) the container's own Docker healthcheck reports "healthy"  -> ready (authoritative)
    //   (2) HTTP on / returns < 500                                   -> ready
    //   (3) the backend container has exited or is restart-looping    -> FAIL FAST (don't wait)
    // Generous ceiling: heavy apps run DB migrations on first boot that take minutes.
    // Override with QA_READY_TIMEOUT_MS (authoritative — bypasses the scaling below).
    phase(appId, 'http', `Waiting for ${appId} to become ready on :${hostPort}`);
    // Probe + screenshot the app's real UI path (config.url_suffix, e.g. plex's /web/index.html).
    // Apps like plex serve their API/XML at `/`, so a bare `/` probe screenshots the wrong page and
    // makes a working app look broken. Falls back to `/` when no suffix is declared.
    const uiPath = config.url_suffix && String(config.url_suffix).startsWith('/') ? String(config.url_suffix) : '/';
    // Concurrency slows first-boot (shared CPU/disk while peers also pull+migrate), so scale the
    // ceiling up modestly when QA_CONCURRENCY>1: +50% per extra slot, capped at 2x. This only
    // affects the success ceiling — the fail-fast exit/restart-loop signals below are unchanged,
    // so a genuinely dead app still bails immediately rather than burning the longer ceiling.
    const readyScale = QA_CONCURRENCY > 1 ? Math.min(2, 1 + (QA_CONCURRENCY - 1) * 0.5) : 1;
    const maxWaitMs = Number(process.env.QA_READY_TIMEOUT_MS) || Math.round((isMulti ? 600_000 : 300_000) * readyScale);
    const readyStart = Date.now();
    let httpStatus = 0;
    let ready = false;
    let readyVia = '';
    let deadReason = '';

    while (!ready && Date.now() - readyStart < maxWaitMs) {
      await new Promise((r) => setTimeout(r, 3000));
      // (3) + (1): inspect the main container — fail fast if dead/looping, succeed if healthcheck passes.
      // execAsync (not execQuiet) so a stalled inspect on a wedged daemon can't block the loop past
      // its own deadline check — the readiness ceiling must stay a hard wall.
      const ins = await execAsync(
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
        const res = await fetch(`http://localhost:${hostPort}${uiPath}`, { signal: AbortSignal.timeout(4000) });
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
      const bh = await captureBackendHealth({ composeProject, composeYml, containerName });
      result.backendErrors = bh.errors;
      const waited = Math.round((Date.now() - readyStart) / 1000);
      // Container exited / restart-looped after a clean start = a real app FAIL; never becoming
      // ready with no death signal = an infra TIMEOUT (retryable on a warm second attempt).
      result.score = deadReason ? 'fail' : 'timeout';
      result.failKind = deadReason ? 'exit' : 'timeout';
      result.notes =
        (deadReason ? `backend ${deadReason} after ${waited}s` : `not ready within ${Math.round(maxWaitMs / 1000)}s`) +
        (bh.down.length ? ` — down: ${bh.down.join(', ')}` : '') +
        (bh.errors ? ` | ${bh.errors.replace(/\s+/g, ' ').slice(0, 200)}` : '');
      return result;
    }

    // Backend health: the frontend served, but a backend service may be crashed/restarting
    // (the "page loads, login broken" case). Capture it so it isn't a false pass.
    const backend = await captureBackendHealth({ composeProject, composeYml, containerName });
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
            `http://localhost:${hostPort}${uiPath}`,
          ],
          { timeout: 30_000, killSignal: 'SIGKILL', stdio: 'pipe' },
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
      const s = await execAsync(`docker stats ${statsName} --no-stream --format "{{.MemUsage}}|||{{.CPUPerc}}"`, 10_000);
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
    result.score = 'error';
    result.failKind = 'exception';
    result.notes = err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
  } finally {
    // Non-blocking, SIGKILL-bounded teardown (see forceTeardown) — a wedged daemon here used to
    // hang the app's promise forever, which wedged the node's pool and the whole fleet run.
    await forceTeardown({ appId, containerName, composeProject, composeYml, scratchDirs });
  }

  return result;
}

/**
 * Per-app entry point used by the worker pool. Runs attemptApp, and on a transient failure
 * (cold-pull `error` from a `pull` failKind, or a readiness `timeout`) retries ONCE — attemptApp
 * tears down its own containers in `finally`, so the retry starts clean and hits the now-warm
 * image cache. Emits exactly one app_result (the pool/server count `done` off it), so a retry
 * never double-counts. Real app crashes (`fail`), missing/404 images (`skip`), and structural
 * harness errors (port-map, dir-vs-file mount) are NOT retried.
 */
function isRetryableTransient(result: Record<string, unknown>): boolean {
  return result.failKind === 'pull' || result.failKind === 'timeout';
}

/** attemptApp + the single transient-failure retry, split out so qaApp can race it against the watchdog. */
async function attemptWithRetry(appId: string): Promise<Record<string, unknown>> {
  let result = await attemptApp(appId);
  if (isRetryableTransient(result)) {
    const firstScore = String(result.score);
    const firstNotes = String(result.notes ?? '');
    const retry = await attemptApp(appId);
    retry.retried = true;
    retry.attempts = 2;
    retry.firstAttemptScore = firstScore;
    retry.firstAttemptNotes = firstNotes;
    result = retry;
  } else {
    result.attempts = 1;
  }
  return result;
}

/**
 * Absolute per-app watchdog budget (ms) — the hard backstop that guarantees one app can never wedge
 * the node's worker pool (and therefore the whole fleet run, which only ends when each node's SSH
 * process exits). The readiness ceiling already force-fails slow/dead apps and every docker op is now
 * SIGKILL-bounded + non-blocking, so this fires only when a truly wedged daemon stalls an await. Budget
 * = cold-pull (~15m) + the readiness ceiling, doubled for the one transient retry, + teardown margin.
 * Override with QA_APP_WATCHDOG_MS.
 */
function appWatchdogMs(appId: string): number {
  const override = Number(process.env.QA_APP_WATCHDOG_MS);
  if (override > 0) return Math.max(10_000, override);
  const multi = slotWeightFor(appId) > 1;
  const readyScale = QA_CONCURRENCY > 1 ? Math.min(2, 1 + (QA_CONCURRENCY - 1) * 0.5) : 1;
  const readyCeil = Number(process.env.QA_READY_TIMEOUT_MS) || Math.round((multi ? 600_000 : 300_000) * readyScale);
  return (900_000 + readyCeil) * 2 + 120_000;
}

/**
 * Per-app entry point used by the worker pool. Races attemptApp(+retry) against a hard watchdog timer
 * so a wedged app force-fails as `timeout` instead of hanging the pool. Emits EXACTLY one app_result
 * (the pool/server count `done` off it) — attemptApp never emits its own, so an abandoned (watchdog-
 * lost) attempt can't double-report. Real crashes (`fail`), missing images (`skip`), and structural
 * harness errors are returned by attemptApp and pass straight through (only pull/timeout retry once).
 */
async function qaApp(appId: string): Promise<void> {
  const containerName = `qa-stream-${appId}`;
  const budgetMs = appWatchdogMs(appId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<Record<string, unknown>>((resolve) => {
    timer = setTimeout(() => {
      // The attempt is wedged (a stalled daemon held an await past every inner timeout). Kick off a
      // background teardown (tracked so the final drain can let it finish) and resolve a timeout
      // verdict so the slot frees and dispatch continues — we do NOT await the teardown here.
      trackTeardown(forceTeardown({ appId, containerName }));
      resolve({
        appId,
        score: 'timeout' as Score,
        failKind: 'watchdog',
        notes: `per-app watchdog fired after ${Math.round(budgetMs / 1000)}s — attempt did not settle (wedged docker daemon); force-failed so dispatch continues`,
        ts: Date.now(),
        watchdog: true,
        attempts: 1,
      });
    }, budgetMs);
  });
  let result: Record<string, unknown>;
  try {
    result = await Promise.race([attemptWithRetry(appId), watchdog]);
  } catch (err) {
    // attemptApp catches its own exceptions, but guard the pool against an unexpected throw.
    result = {
      appId,
      score: 'error' as Score,
      failKind: 'exception',
      notes: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
      ts: Date.now(),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
  emitResult(appId, result);
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

/**
 * Pool slots an app consumes in the intra-node worker pool. Multi-service apps (DB+redis+app)
 * are heavier and run a real `compose up`, so they take 2 slots; single-service apps take 1.
 * Cheap pre-scan of the compose json's service count — mirrors how qaApp computes `isMulti`.
 * (.yml apps and unreadable manifests are single-service for weighting purposes.)
 */
function slotWeightFor(appId: string): number {
  try {
    const cj = join(APP_STORE_DIR, appId, 'docker-compose.json');
    if (existsSync(cj)) {
      const compose: ComposeJson = JSON.parse(readFileSync(cj, 'utf-8'));
      return (compose.services?.length ?? 1) > 1 ? 2 : 1;
    }
  } catch {
    /* unreadable manifest — treat as single-service for weighting */
  }
  return 1;
}

/**
 * Run qaApp over every appId with bounded intra-node concurrency (QA_CONCURRENCY total slots).
 * Each app consumes slotWeightFor(app) slots (multi-service=2, single=1) — a weighted semaphore —
 * so a couple of heavy compose stacks don't oversubscribe the node. Per-app isolation (ephemeral
 * `-p 0:`, `qa-<app>` compose project, per-app scratch dir) is what makes this parallelism safe.
 * An app whose weight exceeds the total budget still runs (clamped) rather than deadlocking.
 */
async function runWithConcurrency(next: () => Promise<string | null>): Promise<void> {
  const total = QA_CONCURRENCY;
  let available = total;
  const inflight = new Set<Promise<void>>();
  let lookahead: string | null = null; // a fetched-but-not-yet-launched app (over-weight wait)
  let ended = false;

  // Pull the next app id, preferring a stashed lookahead. Returns null once the source is drained.
  // `next` may BLOCK (stdin work-stealing mode waits for the server to feed the next id), which is
  // fine — awaiting it yields to in-flight apps' finalizers.
  const fetchNext = async (): Promise<string | null> => {
    if (lookahead !== null) {
      const v = lookahead;
      lookahead = null;
      return v;
    }
    if (ended) return null;
    const v = await next();
    if (v === null) ended = true;
    return v;
  };

  while (!ended || inflight.size > 0) {
    // Launch as many apps as currently fit in the remaining weighted budget.
    while (available > 0) {
      const appId = await fetchNext();
      if (appId === null) break; // source drained — let in-flight finish
      const weight = Math.min(slotWeightFor(appId), total); // clamp so an over-budget app can't deadlock
      if (weight > available && inflight.size > 0) {
        lookahead = appId; // no room right now — stash and wait for a finisher
        break;
      }
      available -= weight;
      const p: Promise<void> = qaApp(appId)
        .catch((err) => {
          // qaApp emits its own result; this guards the pool against an unexpected throw.
          process.stderr.write(`qaApp(${appId}) threw: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
        })
        .finally(() => {
          available += weight;
          inflight.delete(p);
        });
      inflight.add(p);
    }
    if (inflight.size > 0) await Promise.race(inflight);
    else if (ended) break;
  }
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
  else if (/PROTOCOL$|SCHEME$/.test(name))
    v = 'http'; // APP_PROTOCOL etc. — else a random hex makes `${APP_PROTOCOL}://host` a malformed URL
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
  const hasHealthcheck = new Set(services.filter((s) => s.name && (s.healthCheck ?? s.healthcheck)?.test).map((s) => s.name as string));
  let y = 'services:\n';
  for (const s of services) {
    if (!s.name || !s.image) continue;
    y += `  ${s.name}:\n    image: ${yamlStr(subst(s.image))}\n    restart: "no"\n`;
    // Optional resource caps (off unless QA_MEM_LIMIT/QA_CPU_LIMIT set). Applied per service so a
    // multi-service stack stays bounded when several apps run concurrently on one node. These are
    // Compose v2 top-level keys (`mem_limit`/`cpus`) — honored by `docker compose up` without swarm.
    if (QA_MEM_LIMIT) y += `    mem_limit: ${yamlStr(QA_MEM_LIMIT)}\n`;
    if (QA_CPU_LIMIT) y += `    cpus: ${QA_CPU_LIMIT}\n`;
    // Run-as user — mirror the real Hub builder (service.builder.ts emits `user:`). Dropping it
    // diverges from production: an app that sets `user` (or expects the image default once a
    // manifest stops forcing `user: root`) otherwise runs under the wrong uid and fails spuriously.
    if (s.user != null && String(s.user).length) {
      y += `    user: ${yamlStr(subst(String(s.user)))}\n`;
    }
    // Host-privilege fields — mirror the Hub builder so apps that declare them don't false-fail.
    if (s.privileged === true) y += '    privileged: true\n';
    if (Array.isArray(s.capAdd) && s.capAdd.length) {
      y += '    cap_add:\n';
      for (const c of s.capAdd) y += `      - ${yamlStr(String(c))}\n`;
    }
    if (Array.isArray(s.devices) && s.devices.length) {
      y += '    devices:\n';
      for (const d of s.devices) y += `      - ${yamlStr(subst(String(d)))}\n`;
    }
    if (Array.isArray(s.securityOpt) && s.securityOpt.length) {
      y += '    security_opt:\n';
      for (const so of s.securityOpt) y += `      - ${yamlStr(String(so))}\n`;
    }
    if (s.sysctls && typeof s.sysctls === 'object' && Object.keys(s.sysctls).length) {
      y += '    sysctls:\n';
      for (const [k, v] of Object.entries(s.sysctls)) y += `      ${k}: ${yamlStr(String(v))}\n`;
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
    const hc = s.healthCheck ?? s.healthcheck;
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
      const sp = hc.startPeriod ?? hc.start_period;
      if (sp) y += `      start_period: ${yamlStr(String(sp))}\n`;
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
async function captureBackendHealth(o: { composeProject: string; composeYml: string; containerName: string }): Promise<{
  healthy: boolean;
  down: string[];
  errors: string;
}> {
  const ERR = `grep -iE 'error|fatal|fail|refused|denied|panic|cannot|unable|exception|no such host' | tail -8`;
  if (o.composeProject && o.composeYml) {
    const ps = await execAsync(
      `docker compose -p ${o.composeProject} -f ${o.composeYml} ps -a --format '{{.Service}}|{{.State}}|{{.ExitCode}}'`,
      20_000,
    );
    const down: string[] = [];
    for (const line of ps.out.split('\n')) {
      const [svc, state, exitCode] = line.split('|');
      if (!svc || !state) continue;
      const st = state.trim();
      if (/running|^up/i.test(st)) continue;
      // A one-shot init/migrator/seeder that EXITED 0 has COMPLETED — not down. Only count it
      // as down if it exited non-zero, is restarting/dead, or never started (created). This is the
      // single biggest source of false "backend degraded" warns (plane/matomo/hoppscotch/openproject).
      if (/^exited/i.test(st) && (exitCode ?? '').trim() === '0') continue;
      down.push(`${svc}(${st})`);
    }
    let errors = '';
    if (down.length) {
      const logs = await execAsync(`docker compose -p ${o.composeProject} -f ${o.composeYml} logs --tail 25 2>&1 | ${ERR}`, 25_000);
      errors = logs.out.slice(-700);
    }
    return { healthy: down.length === 0, down, errors };
  }
  const st = await execAsync(`docker inspect ${o.containerName} --format '{{.State.Status}}|{{.RestartCount}}'`);
  const [status, restarts] = (st.out || '|').split('|');
  const restartCount = Number(restarts || 0);
  const healthy = status === 'running' && restartCount < 3;
  let errors = '';
  if (!healthy) {
    const logs = await execAsync(`docker logs --tail 25 ${o.containerName} 2>&1 | ${ERR}`, 20_000);
    errors = logs.out.slice(-700);
  }
  return { healthy, down: healthy ? [] : [`main(${status},restarts=${restartCount})`], errors };
}

// ── Main ──────────────────────────────────────────────────────────────────────
// Two dispatch modes:
//   • argv mode (default): app ids are CLI args; the node tests exactly that fixed list, warming
//     the cache for the whole list up-front. Used by drive-qa.mjs and any direct invocation.
//   • stdin mode (QA_STDIN=1 or --stdin): app ids are fed one-per-line over stdin by the fleet
//     server's work-stealing dispatcher — the node pulls the next app as a slot frees, so fast
//     nodes drain more of the shared queue and none sit idle at the tail.
const STDIN_MODE = process.env.QA_STDIN === '1' || process.argv.includes('--stdin');
const appIds = process.argv.slice(2).filter((a) => a !== '--stdin');
if (!STDIN_MODE && appIds.length === 0) {
  process.stderr.write('Usage: qa-stream.ts <app-id> [app-id...]   (or QA_STDIN=1 to read ids from stdin)\n');
  process.exit(1);
}

/**
 * Stdin line reader for work-stealing mode. Buffers partial chunks, hands out one whole app id per
 * call, and returns null once the server closes the pipe (end of queue). The returned function
 * BLOCKS until an id is available or the pipe closes — that backpressure is exactly what makes the
 * server's "feed one more on each app_result" dispatch a work-stealing queue.
 */
function makeStdinReader(): () => Promise<string | null> {
  const queue: string[] = [];
  let closed = false;
  let wake: (() => void) | null = null;
  let buf = '';
  const pump = () => {
    const w = wake;
    wake = null;
    if (w) w();
  };
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk: string) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const id = line.trim();
      if (id) queue.push(id);
    }
    pump();
  });
  process.stdin.on('end', () => {
    const id = buf.trim();
    if (id) queue.push(id);
    closed = true;
    pump();
  });
  return async function nextFromStdin(): Promise<string | null> {
    for (;;) {
      const id = queue.shift();
      if (id !== undefined) return id;
      if (closed) return null;
      await new Promise<void>((res) => {
        wake = res;
      });
    }
  };
}

/** Count of results recorded this run (from the durable results.json) — used for batch_done. */
function countResults(): number {
  try {
    const parsed = JSON.parse(readFileSync(RESULTS_JSON, 'utf-8'));
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/**
 * On batch_done, write batch-<N>-summary.json (the BatchSummary shape qa-aggregate.ts reads) from
 * the durable results.json this run just produced — passed/warned/failed counts, pass rate, and
 * elapsed minutes. Skips (gpu/auth/no_gui/VM) are excluded from the pass-rate denominator so they
 * don't depress it. Best-effort: a summary-write failure must not fail the run.
 */
function writeBatchSummary(startTs: number): void {
  try {
    let arr: { score?: string }[] = [];
    if (existsSync(RESULTS_JSON)) {
      const parsed = JSON.parse(readFileSync(RESULTS_JSON, 'utf-8'));
      if (Array.isArray(parsed)) arr = parsed;
    }
    const passed = arr.filter((r) => r.score === 'pass').length;
    const warned = arr.filter((r) => r.score === 'warn').length;
    const failed = arr.filter((r) => r.score === 'fail').length;
    const errored = arr.filter((r) => r.score === 'error').length;
    const timedOut = arr.filter((r) => r.score === 'timeout').length;
    // Pass-rate denominator = real app verdicts only. skip (non-web) AND error/timeout (infra/harness,
    // not the app's fault) are excluded so flaky infra doesn't depress the marketplace pass rate.
    const scored = passed + warned + failed;
    const summary = {
      batch: Number(QA_BATCH),
      total: arr.length,
      passed,
      warned,
      failed,
      errored,
      timedOut,
      passRate: scored > 0 ? (passed / scored) * 100 : 0,
      elapsedMinutes: (Date.now() - startTs) / 60_000,
    };
    writeFileSync(BATCH_SUMMARY_JSON, JSON.stringify(summary, null, 2));
  } catch (e) {
    process.stderr.write(`batch summary write failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

// Wrapped in an async IIFE: tsx transforms this file as CommonJS (package.json
// has no "type":"module"), and CJS does not support top-level await.
void (async () => {
  const batchStart = Date.now();
  emit({
    event: 'batch_start',
    apps: STDIN_MODE ? [] : appIds,
    mode: STDIN_MODE ? 'stdin' : 'argv',
    storeDir: APP_STORE_DIR,
    ts: batchStart,
  });

  // Start results.json fresh so it holds exactly THIS run's results (qa-aggregate.ts expects a
  // per-run array). Each qaApp appends to it as it finishes, so a dropped SSH pipe still leaves a
  // complete file behind for the aggregator.
  writeFileSync(RESULTS_JSON, '[]');

  // Build the app source for the worker pool: a blocking stdin queue (work-stealing) or a cursor
  // over the fixed argv list.
  let next: () => Promise<string | null>;
  if (STDIN_MODE) {
    // Apps arrive one-at-a-time from the server; the per-app pull (+ retry, + registry mirror) warms
    // the cache, so the batch-wide prepull — which needs the full list up-front — is skipped here.
    next = makeStdinReader();
  } else {
    // Warm the image cache for the whole fixed batch first so heavy images don't cold-pull mid-test.
    await prepull(appIds);
    let i = 0;
    next = async () => (i < appIds.length ? (appIds[i++] ?? null) : null);
  }

  // Bounded intra-node concurrency (QA_CONCURRENCY slots; multi-service apps take 2). Per-app
  // isolation keeps this safe — see runWithConcurrency.
  await runWithConcurrency(next);

  // Persist the batch summary alongside results.json for qa-aggregate.ts to SCP.
  writeBatchSummary(batchStart);

  emit({ event: 'batch_done', total: countResults(), ts: Date.now() });
  // Let any background watchdog teardowns finish (bounded grace) so we don't leak their containers.
  await drainTeardowns(15_000);
  // runWithConcurrency has awaited every TRACKED qaApp, so in the normal case the event loop now
  // drains and the process exits on its own — flushing stdout (important: the SSH pipe may have
  // buffered the final NDJSON results). The ONLY thing that can pin the loop open is a watchdog-
  // abandoned attemptApp lingering as a dangling coroutine (its readiness-loop setTimeout). Arm an
  // UNREF'd fallback: it never keeps the process alive itself, but if something else is pinning the
  // loop it fires shortly after (stdout long since flushed) and force-exits — the node never hangs.
  setTimeout(() => process.exit(0), 2000).unref();
})().catch((err) => {
  process.stderr.write(`qa-stream fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
