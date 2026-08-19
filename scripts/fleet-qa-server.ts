#!/usr/bin/env tsx
/**
 * Fleet QA Dashboard Server
 *
 * Orchestrates per-app Docker tests across the fleet and serves a
 * live web dashboard you can open from any device on the Tailscale network.
 *
 * Usage:
 *   pnpm exec tsx scripts/fleet-qa-server.ts
 *   pnpm exec tsx scripts/fleet-qa-server.ts --port=4242 --mode=quick
 *
 * Environment:
 *   FLEET_CONFIG_JSON   JSON array [{name,ip,batch},...] — same format as run-fleet-tests.ts
 *   FLEET_SSH_USER      SSH user on fleet nodes (default: ci)
 *   HUB_ROOT_REMOTE     Path to CI-Hub checkout on fleet nodes  (default: ~/devel/CI-Hub)
 *   STORE_ROOT_REMOTE   Path to CI-Marketplace on fleet nodes   (default: ~/devel/CI-Marketplace)
 *   QA_PORT             HTTP port to listen on                  (default: 4242)
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, mkdirSync, createReadStream, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { homedir, networkInterfaces } from 'node:os';

const __dir = dirname(fileURLToPath(import.meta.url));

// ─── Config ────────────────────────────────────────────────────────────────

const PORT = Number(process.env.QA_PORT ?? process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] ?? 4242);
const DEFAULT_MODE = (process.argv.find((a) => a.startsWith('--mode='))?.split('=')[1] ?? 'quick') as 'quick' | 'full';
const SSH_USER = process.env.FLEET_SSH_USER ?? 'ci';
const HUB_ROOT_SH = (process.env.HUB_ROOT_REMOTE ?? '~/devel/CI-Hub').replace(/^~/, '$HOME');
const STORE_ROOT = process.env.STORE_ROOT_REMOTE ?? '~/devel/CI-Marketplace';
const RESULTS_DIR = join(homedir(), 'qa-results');
const SCREENSHOTS_DIR = join(RESULTS_DIR, 'fleet-screenshots');
const STREAM_SCRIPT = join(__dir, 'qa-stream.ts');
// qa-stream dynamically imports ./qa-mcp.ts for MCP (no_gui + .mcp) apps, so it must ride along to
// each node. Both import only Node built-ins, so tsx runs the pair standalone in /tmp.
const MCP_SCRIPT = join(__dir, 'qa-mcp.ts');
// QA_CATALOG_FILE points the run at a filtered catalog (e.g. only newly-added apps) without
// clobbering the generated full catalog. Falls back to the generated one.
const CATALOG_FILE = process.env.QA_CATALOG_FILE ?? join(__dir, '..', 'e2e', 'generated', 'catalog.json');

if (!existsSync(SCREENSHOTS_DIR)) mkdirSync(SCREENSHOTS_DIR, { recursive: true });

interface FleetNode {
  name: string;
  ip: string;
  batch: number;
  user?: string; // overrides SSH_USER for this node
}

const BUILTIN_FLEET: FleetNode[] = [
  // Fleet expanded 2026-06-05 to the 10 Ollama-0.24.0 core+beta workers (per liam's roster).
  // All provisioned: Node 22 + CI-Hub + CI-Marketplace(169 apps) + tsx.
  //   core-10:    nvm Node 22 (no passwordless sudo) + repos synced from core-14
  //   core-14/17: Node 22 + repos synced from core-1
  //   beta-ms-a2: NEW node, apt Node 22 (sudo) + repos synced from core-14
  // Dropped: beta-red/beta-5 (offline), core-13 (SSH timeout), core-3 (no sshd),
  //   core-4 (stale dup), core-5 (Tailscale SSH ACL denies ci), fzzy (no sudo).
  { name: 'core-1', ip: '100.108.17.53', batch: 0 },
  { name: 'core-2', ip: '100.101.156.33', batch: 1 },
  { name: 'core-6', ip: '100.95.23.128', batch: 2 },
  { name: 'core-8', ip: '100.98.33.44', batch: 3 },
  { name: 'core-9', ip: '100.113.188.103', batch: 4 },
  { name: 'core-10', ip: '100.87.68.116', batch: 5 },
  { name: 'core-14', ip: '100.101.186.74', batch: 6 },
  { name: 'core-17', ip: '100.67.181.7', batch: 7 },
  { name: 'beta-1', ip: '100.124.211.75', batch: 8 },
  { name: 'beta-ms-a2', ip: '100.119.230.14', batch: 9 },
  // beta-red: recovered 2026-06-09 — x86_64, Docker (mirror→core-1:5050), CI-Hub+CI-Marketplace@dev,
  //   chromium-1208, Node 18 + tsx, git-auth OK, 31G RAM. (core-9 is offline on an expired TS key.)
  { name: 'beta-red', ip: '100.86.79.25', batch: 10 },
  // fzzy: provisioned 2026-06-09 — x86_64, 122G RAM, Docker 29 (no passwordless sudo → no registry
  //   mirror; uses an authed ~/.docker/config.json instead), nvm Node 22 + global tsx, CI-Marketplace
  //   @dev synced. No CI-Hub checkout needed (qa-stream is pure-builtin + tsx).
  { name: 'fzzy', ip: '100.114.164.27', batch: 11 },
];

const FLEET: FleetNode[] = process.env.FLEET_CONFIG_JSON ? JSON.parse(process.env.FLEET_CONFIG_JSON) : BUILTIN_FLEET;

// Docker Hub pull-through cache (see .claude/skills/run-fleet-qa/provision-docker-cache.mjs). Preflight
// asserts each node's daemon.json registry-mirror points here — a missing mirror means that node pulls
// direct from Hub and risks the unauthenticated rate-limit `error` verdicts. Non-blocking: surfaced as
// a warning so a not-yet-provisioned node doesn't abort the whole run.
const CACHE_NODE = process.env.QA_CACHE_NODE ?? 'core-1';
const CACHE_PORT = process.env.QA_CACHE_PORT ?? '5050';
const CACHE_MIRROR_HOSTPORT = (() => {
  const c = (process.env.FLEET_CONFIG_JSON ? JSON.parse(process.env.FLEET_CONFIG_JSON) : BUILTIN_FLEET).find((n: FleetNode) => n.name === CACHE_NODE);
  return c ? `${c.ip}:${CACHE_PORT}` : '';
})();

// ─── App Catalog ────────────────────────────────────────────────────────────

interface AppSpec {
  id: string;
  name: string;
  categories: string[];
  priority: 'high' | 'medium' | 'low';
  expectedPort: number;
  storeSlug: string;
  hasGui: boolean;
  mcp?: boolean; // MCP-server app — verified via the protocol smoke, not the HTTP path
}

let CATALOG: AppSpec[] = [];
if (existsSync(CATALOG_FILE)) {
  CATALOG = JSON.parse(readFileSync(CATALOG_FILE, 'utf-8'));
} else {
  console.warn(`⚠  Catalog not found at ${CATALOG_FILE} — run generate-catalog-tests.ts first`);
}

/** Build the shared work-stealing queue for a run: the full catalog, or the high-priority slice for
 *  a quick run. Nodes drain this on demand (see feedNode) instead of receiving fixed up-front slices. */
function buildQueue(mode: 'quick' | 'full', nodeCount: number): AppSpec[] {
  return mode === 'quick' ? CATALOG.filter((a) => a.priority === 'high').slice(0, 2 * nodeCount) : [...CATALOG];
}

// ─── State ──────────────────────────────────────────────────────────────────

type AppStatus =
  | 'idle'
  | 'queued'
  | 'pulling'
  | 'starting'
  | 'http'
  | 'screenshot'
  | 'benchmark'
  | 'pass'
  | 'warn'
  | 'fail'
  | 'error'
  | 'timeout'
  | 'skip';

interface AppState {
  id: string;
  name: string;
  categories: string[];
  status: AppStatus;
  node: string | null;
  phase: string;
  message: string;
  result: Record<string, unknown> | null;
  logs: string[];
  dispatchTs: number | null; // when the work-stealing dispatcher wrote this app's id to a node (deadline clock)
  startTs: number | null;
  endTs: number | null;
}

interface NodeState {
  name: string;
  ip: string;
  status: 'idle' | 'checking' | 'syncing' | 'running' | 'done' | 'error' | 'offline';
  total: number;
  done: number;
  currentApp: string | null;
  error: string | null;
  preflight: Record<string, unknown> | null;
  storeDir: string | null; // resolved during preflight: CI-Marketplace or CI-App-Store
}

const appStates = new Map<string, AppState>(
  CATALOG.map((a) => [
    a.id,
    {
      id: a.id,
      name: a.name,
      categories: a.categories,
      status: 'idle',
      node: null,
      phase: '',
      message: '',
      result: null,
      logs: [],
      dispatchTs: null,
      startTs: null,
      endTs: null,
    },
  ]),
);

const nodeStates = new Map<string, NodeState>(
  FLEET.map((n) => [
    n.name,
    {
      name: n.name,
      ip: n.ip,
      status: 'idle',
      total: 0,
      done: 0,
      currentApp: null,
      error: null,
      preflight: null,
      storeDir: null,
    },
  ]),
);

let runMode: 'quick' | 'full' = DEFAULT_MODE;
let runStartTs: number | null = null;
const sshProcesses = new Map<string, ChildProcess>();

// ─── Durable run results ──────────────────────────────────────────────────────
// Each app_result the fleet receives is appended to ~/qa-results/fleet-run-<ts>.ndjson (one JSON
// object per line — survives a server restart / browser disconnect) and held in `currentResults`
// (keyed by node+app, so a re-run of an app overwrites its earlier row) so GET /api/results.json
// can return the consolidated current run at any time.
let runNdjsonPath: string | null = null;
const currentResults = new Map<string, Record<string, unknown>>();

/** Append one app_result row to the current run's ndjson file and the in-memory consolidation. */
function recordResult(nodeName: string, appId: string, result: Record<string, unknown>) {
  const row = { node: nodeName, appId, ...result };
  currentResults.set(`${nodeName}:${appId}`, row);
  if (runNdjsonPath) {
    try {
      appendFileSync(runNdjsonPath, `${JSON.stringify(row)}\n`);
    } catch (e) {
      console.error(`[fleet] failed to persist result for ${appId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// ─── SSE ────────────────────────────────────────────────────────────────────

const sseClients = new Set<ServerResponse>();

function broadcast(event: Record<string, unknown>) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(line);
    } catch {
      sseClients.delete(res);
    }
  }
}

function broadcastFleetStatus() {
  const states = Array.from(appStates.values());
  broadcast({
    event: 'fleet_status',
    total: states.length,
    idle: states.filter((s) => s.status === 'idle').length,
    queued: states.filter((s) => s.status === 'queued').length,
    running: states.filter((s) => ['pulling', 'starting', 'http', 'screenshot', 'benchmark'].includes(s.status)).length,
    pass: states.filter((s) => s.status === 'pass').length,
    warn: states.filter((s) => s.status === 'warn').length,
    fail: states.filter((s) => s.status === 'fail').length,
    error: states.filter((s) => s.status === 'error').length,
    skip: states.filter((s) => s.status === 'skip').length,
    runStartTs,
  });
}

// ─── SSH + Stream Orchestration ─────────────────────────────────────────────

// Source tool managers before running commands — handles NVM, ASDF, Bun without login-shell noise
const REMOTE_TOOL_INIT =
  'source ~/.nvm/nvm.sh 2>/dev/null; source ~/.asdf/asdf.sh 2>/dev/null; ' +
  'source ~/.bun/env 2>/dev/null; ' +
  'export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node/ 2>/dev/null | sort -V | tail -1)/bin:$HOME/.bun/bin:$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/bin:$PATH"';

function sshSpawn(node: FleetNode, cmd: string, opts?: { stdin?: boolean }): ChildProcess {
  const user = node.user ?? SSH_USER;
  return spawn(
    'ssh',
    [
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'ServerAliveInterval=30',
      `${user}@${node.ip}`,
      `${REMOTE_TOOL_INIT}; ${cmd}`,
    ],
    // stdin is a pipe only for the work-stealing runner (we feed it app ids); other callers ignore it.
    { stdio: [opts?.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] },
  );
}

function summarizeError(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

function logNode(nodeName: string, message: string) {
  console.log(`[fleet:${nodeName}] ${message}`);
}

function sshCapture(node: FleetNode, cmd: string, timeoutMs = 20_000): Promise<{ ok: boolean; out: string; err: string; code: number | null }> {
  return new Promise((resolve) => {
    const proc = sshSpawn(node, cmd);
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({ ok: false, out, err: `${err}\nTimed out after ${timeoutMs}ms`, code: null });
    }, timeoutMs);

    proc.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out, err, code });
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, out, err: `${err}\n${e.message}`, code: null });
    });
  });
}

function scpScreenshot(node: FleetNode, appId: string) {
  const remoteResultsDir = '~/qa-results-fleet';
  spawn(
    'scp',
    [
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'ConnectTimeout=5',
      `${node.user ?? SSH_USER}@${node.ip}:${remoteResultsDir}/screenshots/${appId}.png`,
      join(SCREENSHOTS_DIR, `${node.name}_${appId}.png`),
    ],
    { stdio: 'ignore' },
  );
}

async function scpScript(node: FleetNode): Promise<{ ok: boolean; error: string | null }> {
  return new Promise((resolve) => {
    // Ship both qa-stream.ts AND its qa-mcp.ts sibling (dynamic-imported for MCP apps) in one
    // transfer to the /tmp directory, preserving basenames → /tmp/qa-stream.ts + /tmp/qa-mcp.ts.
    const proc = spawn(
      'scp',
      ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10', STREAM_SCRIPT, MCP_SCRIPT, `${node.user ?? SSH_USER}@${node.ip}:/tmp/`],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let err = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    proc.on('exit', (code) => resolve({ ok: code === 0, error: code === 0 ? null : summarizeError(err) || `scp exited with code ${code}` }));
    proc.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

async function preflightNode(node: FleetNode): Promise<boolean> {
  const ns = nodeStates.get(node.name);
  if (!ns) return false;

  ns.status = 'checking';
  ns.error = null;
  ns.preflight = null;
  broadcast({ event: 'node_status', node: node.name, ...ns });

  const cmd = [
    'set -e',
    'echo host=$(hostname)',
    'echo user=$(whoami)',
    'command -v docker >/dev/null 2>&1',
    'docker info >/dev/null 2>&1',
    // Require a tsx the runner can actually use: a global tsx, or the repo-local
    // binary the per-app command falls back to. (pnpm presence alone is not enough.)
    `(command -v tsx >/dev/null 2>&1 || test -x ${HUB_ROOT_SH}/node_modules/.bin/tsx)`,
    // Try CI-Marketplace, CI-App-Store (legacy), and /tmp fallback
    `(test -d ${STORE_ROOT}/apps || test -d ~/devel/CI-App-Store/apps || test -d /tmp/CI-Marketplace/apps)`,
    `(test -f ${STORE_ROOT}/apps/code-server/config.json || test -f ~/devel/CI-App-Store/apps/code-server/config.json || test -f /tmp/CI-Marketplace/apps/code-server/config.json)`,
    // Emit which store dir was found so the run command can use it
    `echo storeDir=$(test -d ${STORE_ROOT}/apps && echo ${STORE_ROOT} || test -d ~/devel/CI-App-Store/apps && echo ~/devel/CI-App-Store || echo /tmp/CI-Marketplace)`,
    // Non-blocking: report this node's Docker registry mirror(s) so we can assert the pull-through
    // cache is wired (||true keeps it from tripping `set -e` when no mirror is configured).
    `echo "mirror=$(docker info 2>/dev/null | awk '/Registry Mirrors:/{f=1;next} f&&/^  /{print $1;next} {f=0}' | tr '\\n' ' ' || true)"`,
    'echo ok',
  ].join(' && ');

  const result = await sshCapture(node, cmd, 30_000);
  const ok = result.ok && result.out.includes('ok');
  // Parse storeDir from preflight output: "storeDir=~/devel/CI-App-Store" or similar
  const storeDirMatch = result.out.match(/storeDir=(\S+)/);
  ns.storeDir = storeDirMatch?.[1] ?? null;
  // Assert the Docker Hub pull-through cache mirror is wired (NON-BLOCKING — a missing mirror only
  // risks rate-limit `error`s, it doesn't break the node, so it must not fail preflight).
  const mirrorMatch = result.out.match(/mirror=([^\n]*)/);
  const mirrors = mirrorMatch?.[1]?.trim() ?? '';
  const mirrorOk = !CACHE_MIRROR_HOSTPORT || mirrors.includes(CACHE_MIRROR_HOSTPORT);
  ns.status = ok ? 'idle' : 'offline';
  ns.error = ok ? null : summarizeError(result.err || result.out) || 'Preflight failed';
  ns.preflight = {
    ok,
    output: summarizeError(result.out),
    error: summarizeError(result.err),
    checkedAt: Date.now(),
    storeDir: ns.storeDir,
    mirrors,
    mirrorOk,
  };

  if (ok) {
    logNode(node.name, `preflight OK (storeDir=${ns.storeDir ?? 'unknown'})`);
    if (!mirrorOk) {
      logNode(
        node.name,
        `⚠ docker registry-mirror NOT wired to ${CACHE_MIRROR_HOSTPORT} (pulls go direct to Hub → rate-limit risk). Fix: node .claude/skills/run-fleet-qa/provision-docker-cache.mjs --execute`,
      );
    }
  } else {
    logNode(node.name, `preflight FAILED: ${ns.error ?? 'unknown error'}`);
    if (result.out) logNode(node.name, `  stdout: ${summarizeError(result.out)}`);
    if (result.err) logNode(node.name, `  stderr: ${summarizeError(result.err)}`);
  }

  broadcast({ event: 'node_status', node: node.name, ...ns });
  return ok;
}

async function preflightNodes(nodes: FleetNode[]): Promise<FleetNode[]> {
  const results = await Promise.all(nodes.map(async (node) => ({ node, ok: await preflightNode(node) })));
  const ready = results.filter((r) => r.ok).map((r) => r.node);
  console.log(`[fleet] preflight complete: ${ready.length}/${nodes.length} ready`);
  if (ready.length > 0) {
    console.log(`[fleet] ready nodes: ${ready.map((n) => n.name).join(', ')}`);
  }
  broadcast({ event: 'preflight_complete', ready: ready.map((n) => n.name), total: nodes.length });
  return ready;
}

async function runNodeTests(node: FleetNode) {
  const ns = nodeStates.get(node.name);
  if (!ns) return;
  ns.total = 0; // grows as the work-stealing dispatcher assigns apps to this node (see feedNode)
  ns.done = 0;
  ns.status = 'syncing';
  logNode(node.name, 'joining work-stealing pool');
  broadcast({ event: 'node_status', node: node.name, ...ns });

  // SCP the streaming script to the node
  const scpResult = await scpScript(node);
  if (!scpResult.ok) {
    ns.status = 'offline';
    ns.error = scpResult.error ?? 'Could not SCP qa-stream.ts';
    logNode(node.name, `SCP failed: ${ns.error}`);
    broadcast({ event: 'node_status', node: node.name, ...ns });
    broadcastFleetStatus();
    return;
  }

  ns.status = 'running';
  logNode(node.name, 'starting remote qa-stream runner');
  broadcast({ event: 'node_status', node: node.name, ...ns });

  const remoteResultsDir = '~/qa-results-fleet';
  // Use the storeDir resolved at preflight (CI-Marketplace or CI-App-Store)
  const resolvedStore = ns.storeDir ?? STORE_ROOT;
  // Work-stealing: run qa-stream in stdin mode (no fixed app list) and feed it ids on demand.
  // QA_CONCURRENCY matches the server's FEED_DEPTH so the node's pool size tracks how many apps we
  // keep in flight per node.
  const envPrefix = `QA_STDIN=1 QA_CONCURRENCY=${FEED_DEPTH} APP_STORE_DIR=${resolvedStore}/apps RESULTS_DIR=${remoteResultsDir}`;
  const cmd = [
    `mkdir -p ${remoteResultsDir}/screenshots`,
    // Resolve tsx: prefer a global tsx, else the repo-local binary that provisioning installs
    // (preflight verifies one of these exists). qa-stream.ts only imports Node built-ins, so
    // the repo's tsx runs it standalone. (`pnpm exec tsx` from $HOME failed: no package.json.)
    `TSX_BIN="$(command -v tsx || echo ${HUB_ROOT_SH}/node_modules/.bin/tsx)"`,
    `${envPrefix} "$TSX_BIN" /tmp/qa-stream.ts --stdin`,
  ].join(' && ');

  await new Promise<void>((resolve) => {
    const proc = sshSpawn(node, cmd, { stdin: true });
    sshProcesses.set(node.name, proc);
    // Prime the node with FEED_DEPTH apps from the shared queue; handleStreamEvent feeds one more
    // per app_result the node returns.
    for (let i = 0; i < FEED_DEPTH; i++) feedNode(node);
    let buf = '';

    proc.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          handleStreamEvent(node, JSON.parse(line));
        } catch {
          // Print non-JSON lines so remote runtime/setup failures are visible.
          logNode(node.name, `stdout: ${summarizeError(line)}`);
        }
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.error(`[${node.name}] ${text}`);
    });

    proc.on('exit', (code) => {
      sshProcesses.delete(node.name);
      resolve();
      // finalizeRun killed us as part of completing the run — leave the node's terminal state alone.
      if (runComplete) return;
      ns.status = code === 0 ? 'done' : 'error';
      if (code !== 0) ns.error = `SSH exited with code ${code}`;
      logNode(node.name, code === 0 ? 'completed successfully' : `failed (${ns.error})`);
      ns.currentApp = null;
      broadcast({ event: 'node_status', node: node.name, ...ns });
      // The node's qa-stream is gone — any app still assigned to it will never report. Force-fail
      // them now (don't wait out the deadline) so dispatch/completion isn't blocked by a dead node.
      failNodeInflight(node.name, `node SSH exited (code ${code}) with app still in flight`);
      broadcastFleetStatus();
      maybeCompleteRun();
    });

    proc.on('error', (err) => {
      sshProcesses.delete(node.name);
      resolve();
      if (runComplete) return;
      ns.status = 'error';
      ns.error = err.message;
      logNode(node.name, `runner process error: ${err.message}`);
      broadcast({ event: 'node_status', node: node.name, ...ns });
      failNodeInflight(node.name, `node SSH errored (${err.message}) with app still in flight`);
      broadcastFleetStatus();
      maybeCompleteRun();
    });
  });
}

// ─── Work-stealing dispatch ───────────────────────────────────────────────────
// One shared queue drained on-demand over each node's SSH stdin pipe. A node is primed with
// FEED_DEPTH ids and fed one more on each app_result it returns, so faster nodes consume more of
// the queue and none sit idle at the tail. FEED_DEPTH matches the node's QA_CONCURRENCY (set in env).
const FEED_DEPTH = Math.max(1, Number(process.env.QA_CONCURRENCY) || 2);
let pendingQueue: AppSpec[] = [];

/**
 * Dispatch the next queued app to a node by writing its id to the remote qa-stream's stdin. When
 * the queue is empty, close the node's stdin so its qa-stream drains its in-flight apps and exits.
 * Increments the node's `total` as work is assigned so per-node done/total stays meaningful under
 * dynamic dispatch (it ends equal to what the node actually ran). Returns true if an app was sent.
 */
function feedNode(node: FleetNode): boolean {
  const stdin = sshProcesses.get(node.name)?.stdin;
  if (!stdin || stdin.destroyed) return false;
  const app = pendingQueue.shift();
  if (!app) {
    try {
      stdin.end(); // queue drained — let this node finish its in-flight apps and exit
    } catch {
      /* already closed */
    }
    return false;
  }
  const ns = nodeStates.get(node.name);
  if (ns) ns.total += 1;
  const s = appStates.get(app.id);
  if (s) {
    s.status = 'queued';
    s.node = node.name;
    s.dispatchTs = Date.now(); // start the per-app deadline clock the moment work is assigned
  }
  stdin.write(`${app.id}\n`);
  return true;
}

function handleStreamEvent(node: FleetNode, raw: Record<string, unknown>) {
  const ns = nodeStates.get(node.name);
  if (!ns) return;
  const { event, appId } = raw as { event: string; appId?: string };

  if (event === 'app_start' && appId) {
    const s = appStates.get(appId);
    if (s) {
      s.status = 'pulling';
      s.startTs = Date.now();
      s.logs = [];
    }
    ns.currentApp = appId;
    logNode(node.name, `app_start ${appId}`);
    broadcast({ event: 'app_start', node: node.name, appId, ts: raw.ts });
    broadcast({ event: 'node_status', node: node.name, ...ns });
  } else if (event === 'app_phase' && appId) {
    const s = appStates.get(appId);
    if (s) {
      s.status = raw.phase as AppStatus;
      s.phase = String(raw.phase ?? '');
      s.message = String(raw.message ?? '');
      s.logs.push(`[${s.phase}] ${s.message}`);
    }
    broadcast({ event: 'app_phase', node: node.name, appId, phase: raw.phase, message: raw.message });
  } else if (event === 'app_result' && appId) {
    const res = raw.result as Record<string, unknown>;
    // A result that arrives after the watchdog already force-failed this app is a duplicate — count
    // it once. Ignore it AND don't feed the node (the force-fail already fed it), or we over-feed.
    if (finalizedApps.has(appId)) {
      logNode(node.name, `late app_result ${appId} (already force-failed) — ignored`);
      return;
    }
    finalizedApps.add(appId);
    const s = appStates.get(appId);
    if (s) {
      s.status = (res?.score as AppStatus) ?? 'fail';
      s.result = res;
      s.endTs = Date.now();
      s.message = String(res?.notes ?? '');
    }
    ns.done++;
    // Persist the result durably (ndjson + in-memory) so the run survives a disconnect and
    // GET /api/results.json reflects it.
    recordResult(node.name, appId, res ?? {});
    // Work-stealing: this node just freed a slot — hand it the next app off the shared queue
    // (or close its stdin if the queue is drained). Fast nodes naturally pull more.
    feedNode(node);
    logNode(node.name, `app_result ${appId}: ${String(res?.score ?? 'unknown')}${res?.notes ? ` (${summarizeError(String(res.notes))})` : ''}`);
    broadcast({ event: 'app_result', node: node.name, appId, result: res });
    broadcast({ event: 'node_status', node: node.name, ...ns });
    if (res?.hasScreenshot) scpScreenshot(node, appId);
    broadcastFleetStatus();
    // Run may now be done — the last verdict landing completes the run without waiting on SSH exit.
    maybeCompleteRun();
  } else if (event === 'batch_done') {
    broadcast({ event: 'node_batch_done', node: node.name, ...raw });
  }
}

// ─── Per-app deadline watchdog + state-based completion ───────────────────────
// The run used to end ONLY when every node's SSH process exited (Promise.all). A node whose
// qa-stream wedged on a single app never exited, so the whole run hung at N/total with apps still
// "in flight" that never resolved (had to be killed by hand). These guards make completion driven by
// APP STATE: any in-flight app that outlives its deadline — or whose node's SSH dies mid-app — is
// force-failed as `timeout`, and the run completes the instant the queue is drained and nothing is
// in flight, regardless of whether a node's SSH ever exits.

const IN_FLIGHT_STATUSES = new Set<AppStatus>(['queued', 'pulling', 'starting', 'http', 'screenshot', 'benchmark']);

// Apps we've already produced a verdict for. A real app_result that lands AFTER a force-fail is
// ignored (otherwise it double-counts ns.done and over-feeds the node).
const finalizedApps = new Set<string>();

// Hard ceiling for one app's start→verdict. Generous on purpose: the node self-reports a verdict
// (pass/fail/its own readiness-timeout/its own per-app watchdog) well inside this, so the server
// deadline only ever fires for a node that has gone fully silent (SSH dropped, daemon dead) and will
// never report. The faster, common signal is the SSH-exit force-fail below; this is the backstop.
const APP_DEADLINE_MS = Math.max(60_000, Number(process.env.QA_APP_DEADLINE_MS) || 40 * 60_000);
const WATCHDOG_INTERVAL_MS = Math.max(5_000, Number(process.env.QA_WATCHDOG_INTERVAL_MS) || 15_000);
// Absolute backstop for an entire run — force-completes no matter what.
const RUN_MAX_MS = Math.max(60_000, Number(process.env.QA_RUN_MAX_MS) || 6 * 60 * 60_000);

let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let runMaxTimer: ReturnType<typeof setTimeout> | null = null;
let runComplete = false;

function clearWatchdogs() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  if (runMaxTimer) {
    clearTimeout(runMaxTimer);
    runMaxTimer = null;
  }
}

/**
 * Force a verdict on an in-flight app that will never report on its own (deadline exceeded, or its
 * node's SSH died mid-app). Synthesises a `timeout` result, advances the owning node's done count,
 * frees the slot by feeding that node its next app (no-op if the node is dead), and re-checks run
 * completion. Idempotent via finalizedApps — a later real result for the same app is ignored.
 */
function forceFailApp(appId: string, reason: string): void {
  if (!runStartTs || runComplete || finalizedApps.has(appId)) return;
  const s = appStates.get(appId);
  if (!s || !IN_FLIGHT_STATUSES.has(s.status)) return;
  finalizedApps.add(appId);
  const result: Record<string, unknown> = { appId, score: 'timeout', failKind: 'watchdog', notes: reason, watchdog: true, ts: Date.now() };
  s.status = 'timeout';
  s.result = result;
  s.endTs = Date.now();
  s.message = reason;
  const nodeName = s.node;
  const ns = nodeName ? nodeStates.get(nodeName) : null;
  if (ns) ns.done++;
  recordResult(nodeName ?? 'unknown', appId, result);
  logNode(nodeName ?? 'server', `watchdog force-fail ${appId}: ${reason}`);
  broadcast({ event: 'app_result', node: nodeName, appId, result });
  if (ns) broadcast({ event: 'node_status', node: ns.name, ...ns });
  // Keep the freed slot working if the node is alive; a no-op (stdin destroyed) if it's dead.
  const node = nodeName ? FLEET.find((n) => n.name === nodeName) : undefined;
  if (node) feedNode(node);
  broadcastFleetStatus();
  maybeCompleteRun();
}

/** Force-fail every still-in-flight app owned by a node — used when its SSH process exits mid-run. */
function failNodeInflight(nodeName: string, reason: string): void {
  for (const s of appStates.values()) {
    if (s.node === nodeName && IN_FLIGHT_STATUSES.has(s.status) && !finalizedApps.has(s.id)) {
      forceFailApp(s.id, reason);
    }
  }
}

/** Periodic sweep: force-fail any in-flight app whose dispatch→now exceeds APP_DEADLINE_MS. */
function sweepWatchdog(): void {
  if (!runStartTs || runComplete) return;
  const now = Date.now();
  for (const s of appStates.values()) {
    if (!IN_FLIGHT_STATUSES.has(s.status) || finalizedApps.has(s.id)) continue;
    const since = s.startTs ?? s.dispatchTs;
    if (since && now - since > APP_DEADLINE_MS) {
      forceFailApp(s.id, `no verdict within ${Math.round(APP_DEADLINE_MS / 1000)}s — server watchdog force-failed (node silent/wedged)`);
    }
  }
}

/** Complete the run the instant the queue is drained and nothing is in flight (state-driven). */
function maybeCompleteRun(): void {
  if (!runStartTs || runComplete || pendingQueue.length > 0) return;
  for (const s of appStates.values()) {
    if (IN_FLIGHT_STATUSES.has(s.status)) return;
  }
  finalizeRun();
}

/** Single idempotent run-completion path (used by state-completion, Promise.all, and the run watchdog). */
function finalizeRun(): void {
  if (runComplete) return;
  runComplete = true;
  clearWatchdogs();
  // Tear down any SSH process still attached — a wedged node's qa-stream may never exit on its own.
  for (const [name, proc] of sshProcesses) {
    try {
      proc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    sshProcesses.delete(name);
  }
  const states = Array.from(appStates.values());
  const durationMs = runStartTs ? Date.now() - runStartTs : 0;
  const tally = (st: AppStatus) => states.filter((s) => s.status === st).length;
  console.log(
    `[fleet] run_complete total=${states.length} pass=${tally('pass')} warn=${tally('warn')} fail=${tally('fail')} timeout=${tally('timeout')} error=${tally('error')} skip=${tally('skip')} duration=${Math.round(durationMs / 1000)}s`,
  );
  broadcast({
    event: 'run_complete',
    total: states.length,
    pass: tally('pass'),
    warn: tally('warn'),
    fail: tally('fail'),
    error: tally('error'),
    timeout: tally('timeout'),
    skip: tally('skip'),
    durationMs,
  });
  runStartTs = null;
}

// ─── Run Control ────────────────────────────────────────────────────────────

function stopRun() {
  clearWatchdogs();
  runComplete = true; // suppress watchdog/state-completion after a manual stop (reset re-arms it)
  for (const [name, proc] of sshProcesses) {
    try {
      proc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    sshProcesses.delete(name);
  }
  for (const ns of nodeStates.values()) {
    if (ns.status === 'running' || ns.status === 'syncing') {
      ns.status = 'idle';
      ns.currentApp = null;
      broadcast({ event: 'node_status', node: ns.name, ...ns });
    }
  }
  broadcast({ event: 'run_stopped' });
}

function resetState() {
  stopRun();
  runStartTs = null;
  runComplete = false; // re-arm watchdog + state-completion for the next run (stopRun set it true)
  finalizedApps.clear();
  // Drop the consolidated view of the previous run; a new run opens a fresh ndjson file.
  currentResults.clear();
  runNdjsonPath = null;
  for (const s of appStates.values()) {
    s.status = 'idle';
    s.node = null;
    s.result = null;
    s.logs = [];
    s.dispatchTs = null;
    s.startTs = null;
    s.endTs = null;
    s.message = '';
  }
  for (const ns of nodeStates.values()) {
    ns.status = 'idle';
    ns.done = 0;
    ns.total = 0;
    ns.currentApp = null;
    ns.error = null;
    ns.preflight = null;
  }
  broadcast({ event: 'reset' });
  broadcastFleetStatus();
}

async function startRun(mode: 'quick' | 'full', selectedNodes?: string[]) {
  resetState();
  runMode = mode;
  runStartTs = Date.now();
  // Start a fresh durable result log for this run. Results stream in via handleStreamEvent →
  // recordResult and are exposed at GET /api/results.json.
  runNdjsonPath = join(RESULTS_DIR, `fleet-run-${runStartTs}.ndjson`);
  currentResults.clear();
  console.log(`[fleet] run_start mode=${mode}${selectedNodes?.length ? ` nodes=${selectedNodes.join(',')}` : ' nodes=all'} results=${runNdjsonPath}`);
  broadcast({ event: 'run_start', mode, ts: runStartTs });

  const requestedNodes = selectedNodes ? FLEET.filter((n) => selectedNodes.includes(n.name)) : FLEET;
  const nodes = await preflightNodes(requestedNodes);

  if (nodes.length === 0) {
    console.warn('[fleet] run aborted: preflight returned 0 ready nodes');
    broadcast({
      event: 'run_complete',
      total: CATALOG.length,
      pass: 0,
      warn: 0,
      fail: 0,
      durationMs: runStartTs ? Date.now() - runStartTs : 0,
    });
    runStartTs = null;
    return;
  }

  pendingQueue = buildQueue(mode, nodes.length);
  console.log(`[fleet] dispatch=work-stealing queue=${pendingQueue.length} apps across ${nodes.length} node(s) feed-depth=${FEED_DEPTH}`);

  // Arm the deadline watchdog (force-fail silent in-flight apps) and the absolute run backstop.
  clearWatchdogs();
  watchdogTimer = setInterval(sweepWatchdog, WATCHDOG_INTERVAL_MS);
  runMaxTimer = setTimeout(() => {
    console.warn(`[fleet] run watchdog: hit QA_RUN_MAX_MS (${Math.round(RUN_MAX_MS / 1000)}s) — force-completing`);
    for (const s of appStates.values()) {
      if (IN_FLIGHT_STATUSES.has(s.status)) forceFailApp(s.id, `run exceeded ${Math.round(RUN_MAX_MS / 1000)}s — run watchdog force-failed`);
    }
    finalizeRun();
  }, RUN_MAX_MS);

  const nodePromises: Promise<void>[] = [];
  for (const node of nodes) {
    nodePromises.push(runNodeTests(node));
  }

  // Completion is normally state-driven (the last verdict landing calls maybeCompleteRun). This is
  // the belt-and-suspenders path: once every node's SSH has exited, finalize if not already done.
  Promise.all(nodePromises).then(() => {
    maybeCompleteRun();
    finalizeRun();
  });
}

// ─── HTTP Handler ────────────────────────────────────────────────────────────

function getLocalIp(): string {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return 'localhost';
}

async function handler(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  // ── CORS for LAN access
  res.setHeader('Access-Control-Allow-Origin', '*');

  // ── SSE
  if (path === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    sseClients.add(res);

    // Send snapshot immediately on connect
    const snapshot = {
      event: 'snapshot',
      apps: Object.fromEntries(appStates),
      nodes: Object.fromEntries(nodeStates),
      fleet: FLEET,
      catalog: CATALOG,
      runMode,
      runStartTs,
    };
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);

    req.on('close', () => sseClients.delete(res));
    return;
  }

  // ── Start
  if (path === '/api/start' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => {
      body += d;
    });
    req.on('end', () => {
      const { mode, nodes } = JSON.parse(body || '{}');
      startRun(mode ?? 'quick', nodes);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // ── Preflight
  if (path === '/api/preflight' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => {
      body += d;
    });
    req.on('end', () => {
      const { nodes } = JSON.parse(body || '{}');
      const requestedNodes = nodes ? FLEET.filter((n) => nodes.includes(n.name)) : FLEET;
      preflightNodes(requestedNodes);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // ── Stop
  if (path === '/api/stop' && req.method === 'POST') {
    stopRun();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Reset
  if (path === '/api/reset' && req.method === 'POST') {
    resetState();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Screenshot
  if (path.startsWith('/screenshots/')) {
    const file = path.slice('/screenshots/'.length);
    const fp = join(SCREENSHOTS_DIR, file);
    if (existsSync(fp)) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      createReadStream(fp).pipe(res);
    } else {
      res.writeHead(404);
      res.end();
    }
    return;
  }

  // ── Status JSON
  if (path === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ apps: Object.fromEntries(appStates), nodes: Object.fromEntries(nodeStates), runStartTs }));
    return;
  }

  // ── Consolidated current-run results (every app_result received so far this run)
  if (path === '/api/results.json') {
    const results = Array.from(currentResults.values());
    const tally = (score: string) => results.filter((r) => r.score === score).length;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify(
        {
          runStartTs,
          runNdjson: runNdjsonPath,
          total: results.length,
          pass: tally('pass'),
          warn: tally('warn'),
          fail: tally('fail'),
          error: tally('error'),
          timeout: tally('timeout'),
          skip: tally('skip'),
          results,
        },
        null,
        2,
      ),
    );
    return;
  }

  // ── Dashboard
  if (path === '/' || path === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getDashboardHtml());
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

// ─── Dashboard HTML ──────────────────────────────────────────────────────────

function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CI-Hub · Fleet QA</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
/* CI brand palette — "earth & green" dark appliance look, aligned to ci.computer + the
   CI-Hub/CI-Portal globals.css design tokens: deep earth-forest canvas, emerald/mint-green
   accents, Montserrat, Portal's semantic status colors warmed toward earth tones. */
:root {
  --bg: #051710;            /* deep earth-forest (CI navy, green-shifted) */
  --surface: #0a2118;       /* earthy surface */
  --surface2: #0e2c21;      /* raised surface */
  --border: #1e4a3a;        /* moss-green border */
  --border2: #2a604c;
  --accent: #2bd4a0;        /* CI emerald-mint (interactive) */
  --accent-bright: #5fead0; /* CI bright mint (brand --ring / --chart-1) */
  --accent-dim: #2bd4a026;
  --grad-a: #22b87e; --grad-b: #0c6f56;  /* CI green → deep teal gradient */
  --pass: #3b9eff; --pass-dim: #3b9eff2b;        /* distinct azure BLUE — passed */
  --warn: #e8a33a; --warn-dim: #e8a33a2b;        /* earth amber */
  --fail: #ef4d5e; --fail-dim: #ef4d5e2b;        /* red */
  --error: #f07a2a; --error-dim: #f07a2a2b;      /* earth orange — infra/harness fault */
  --timeout: #b08cff; --timeout-dim: #b08cff2b;  /* violet — never became ready */
  --skip: #7e8a76; --skip-dim: #7e8a7624;         /* sage — non-web / not applicable */
  --muted: #6f8076; --text: #eafef4; --text2: #8ba898;  /* sage-tinted text */
  --radius: 10px;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: var(--bg); color: var(--text);
  font: 13px/1.5 'Montserrat', system-ui, -apple-system, sans-serif; min-height: 100vh;
  background-image:
    radial-gradient(900px 520px at 88% -12%, #114a3366, transparent 70%),
    radial-gradient(720px 420px at -6% -4%, #0b6e5a33, transparent 70%);
  background-attachment: fixed; -webkit-font-smoothing: antialiased;
}

/* ── Header ── */
header {
  position: sticky; top: 0; z-index: 100;
  background: var(--surface); border-bottom: 1px solid var(--border);
  display: flex; align-items: center; gap: 10px 14px; padding: 8px 20px; flex-wrap: wrap;
}
.hdr-controls { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; flex: 1; min-width: 0; }
.hdr-right { display: flex; align-items: center; gap: 10px; margin-left: auto; }
.logo { display: flex; align-items: center; gap: 9px; }
.logo .mark {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border-radius: 8px;
  background: linear-gradient(135deg, var(--grad-a), var(--grad-b));
  color: #eafdfd; font-weight: 700; font-size: 12px; letter-spacing: .5px;
  box-shadow: 0 0 0 1px var(--border2), 0 6px 16px -6px #2bd4a055;
}
.logo .name { font-weight: 700; font-size: 15px; letter-spacing: -.2px; color: var(--text); }
.logo .sub {
  font-weight: 600; font-size: 11px; color: var(--accent-bright);
  text-transform: uppercase; letter-spacing: 1px;
  padding-left: 9px; margin-left: 2px; border-left: 1px solid var(--border);
}
.conn { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.conn.live { background: var(--pass); box-shadow: 0 0 6px var(--pass); animation: pulse 2s infinite; }
.elapsed { color: var(--text2); font-size: 12px; white-space: nowrap; }

/* ── Summary bar: stat chips double as status FILTERS — click to filter the grid ── */
.summary {
  display: flex; gap: 10px; padding: 10px 20px; align-items: center;
  border-bottom: 1px solid var(--border); flex-wrap: wrap;
}
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip {
  background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  padding: 5px 12px; display: flex; align-items: baseline; gap: 6px; cursor: pointer;
  font: inherit; color: var(--text); transition: border-color .15s, background .15s; user-select: none;
}
.chip:hover { border-color: var(--border2); background: var(--surface2); }
.chip-n { font-size: 17px; font-weight: 700; line-height: 1; }
.chip-l { font-size: 10px; color: var(--text2); text-transform: uppercase; letter-spacing: .5px; }
.chip.pass .chip-n { color: var(--pass); }
.chip.warn .chip-n { color: var(--warn); }
.chip.fail .chip-n { color: var(--fail); }
.chip.error .chip-n { color: var(--error); }
.chip.timeout .chip-n { color: var(--timeout); }
.chip.skip .chip-n { color: var(--skip); }
.chip.running .chip-n { color: var(--accent); }
.chip.on { border-color: var(--accent); background: var(--accent-dim); box-shadow: 0 0 0 1px var(--accent-dim); }
.chip.on .chip-l { color: var(--accent-bright); }
.shown-note { font-size: 11px; color: var(--text2); white-space: nowrap; }
.progress-outer { flex: 1; min-width: 200px; display: flex; flex-direction: column; justify-content: center; gap: 4px; }
.progress-bar { height: 8px; background: var(--surface2); border-radius: 4px; overflow: hidden; }
.progress-fill { height: 100%; background: linear-gradient(90deg, var(--grad-a), var(--accent-bright)); border-radius: 4px; transition: width .4s; }
.progress-label { font-size: 11px; color: var(--text2); }

/* ── Controls (inline in the header) ── */
.btn {
  padding: 6px 14px; border-radius: 6px; border: 1px solid var(--border);
  background: var(--surface2); color: var(--text); font-size: 12px; cursor: pointer;
  font-weight: 500; transition: all .15s;
}
.btn:hover { border-color: var(--accent); color: var(--accent); }
.btn.primary { background: linear-gradient(135deg, var(--grad-a), var(--grad-b)); border-color: var(--grad-b); color: #eafdfd; box-shadow: 0 2px 12px -4px #22b87e77; }
.btn.primary:hover { filter: brightness(1.08); color: #eafdfd; }
.btn.danger { border-color: var(--fail); color: var(--fail); }
.btn.active { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }
.btn:disabled { opacity: .4; cursor: not-allowed; }
.mode-sep { width: 1px; height: 24px; background: var(--border); margin: 0 4px; }
.node-sel { display: flex; gap: 4px; flex-wrap: wrap; }
.node-badge {
  padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;
  border: 1px solid var(--border); background: var(--surface2); cursor: pointer;
  transition: all .15s; user-select: none;
}
.node-badge.selected { border-color: var(--accent); background: var(--accent-dim); color: var(--accent); }
.node-badge.online { border-color: var(--pass); }
.node-badge.checking { border-color: var(--warn); color: var(--warn); animation: pulse 1.5s infinite; }
.node-badge.running { border-color: var(--accent); animation: pulse 1.5s infinite; }
.node-badge.done { border-color: var(--pass); background: var(--pass-dim); color: var(--pass); }
.node-badge.error { border-color: var(--fail); color: var(--fail); }
.node-badge.offline { opacity: .4; }

/* ── Grid ── */
.filter-input {
  margin-left: auto; padding: 6px 12px; border-radius: 6px;
  border: 1px solid var(--border); background: var(--surface2);
  color: var(--text); font-size: 12px; width: 190px;
}
.filter-input:focus { outline: none; border-color: var(--accent); }
/* time/size mini bar graphs (cards + drawer) — 4px in cards, slightly taller in the drawer */
.bar-row { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
.bar-ico { font-size: 9px; color: var(--text2); text-transform: uppercase; letter-spacing: .4px; width: 26px; flex-shrink: 0; }
.bar-track { flex: 1; height: 4px; background: var(--surface2); border-radius: 3px; overflow: hidden; }
.drawer .bar-track { height: 6px; }
.bar-fill { height: 100%; border-radius: 3px; background: linear-gradient(90deg, var(--grad-a), var(--accent-bright)); transition: width .3s; }
.bar-fill.mem { background: linear-gradient(90deg, #7a5cff, var(--timeout)); }
.bar-val { font-size: 10px; color: var(--text2); min-width: 52px; text-align: right; flex-shrink: 0; font-variant-numeric: tabular-nums; }
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px; padding: 8px 20px 80px;
}

/* ── App Card ── */
.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 12px; cursor: pointer;
  transition: border-color .15s, box-shadow .15s; position: relative;
  overflow: hidden;
}
.card:hover { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent-dim); }
/* Per-app screenshot thumbnail (hidden until a screenshot exists for that node+app). */
.card-thumb {
  width: 100%; height: 84px; object-fit: cover; object-position: top center;
  border-radius: 7px; border: 1px solid var(--border); background: var(--surface2);
  margin-bottom: 9px; display: block;
}
/* Whole-cell status coloring: tinted background + status border + a bold left bar,
   so the grid reads as an at-a-glance status map. */
.card.pass    { background: var(--pass-dim);    border-color: var(--pass);    border-left: 5px solid var(--pass);    }
.card.warn    { background: var(--warn-dim);    border-color: var(--warn);    border-left: 5px solid var(--warn);    }
.card.fail    { background: var(--fail-dim);    border-color: var(--fail);    border-left: 5px solid var(--fail);    }
.card.error   { background: var(--error-dim);   border-color: var(--error);   border-left: 5px solid var(--error);   }
.card.timeout { background: var(--timeout-dim); border-color: var(--timeout); border-left: 5px solid var(--timeout); }
.card.skip    { background: var(--skip-dim);    border-color: var(--border);  border-left: 5px solid var(--skip); opacity: .72; }
.card.running, .card.pulling, .card.starting, .card.http, .card.screenshot, .card.benchmark {
  background: var(--accent-dim); border-color: var(--accent); border-left: 5px solid var(--accent);
  box-shadow: 0 0 0 1px var(--accent-dim), 0 4px 18px -8px var(--accent);
}
/* Pass/fail cells get a slightly stronger glow so done states pop against in-flight. */
.card.pass  { box-shadow: 0 4px 18px -10px var(--pass); }
.card.fail  { box-shadow: 0 4px 18px -10px var(--fail); }
.card-status { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: var(--muted); }
.dot.pass { background: var(--pass); }
.dot.warn { background: var(--warn); }
.dot.fail { background: var(--fail); }
.dot.error { background: var(--error); }
.dot.timeout { background: var(--timeout); }
.dot.skip { background: var(--skip); }
.dot.running, .dot.pulling, .dot.starting, .dot.http, .dot.screenshot, .dot.benchmark {
  background: var(--accent); animation: spin-dot .8s linear infinite;
}
.dot.queued { background: var(--muted); opacity: .6; }
.card-name { font-weight: 600; font-size: 13px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card-node { font-size: 10px; color: var(--accent); font-weight: 600; padding: 1px 5px; background: var(--accent-dim); border-radius: 3px; flex-shrink: 0; }
.card-cats { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 6px; }
.cat-tag { font-size: 10px; color: var(--text2); background: var(--surface2); padding: 1px 5px; border-radius: 3px; }
.mcp-badge { font-size: 9px; font-weight: 700; letter-spacing: .04em; color: var(--accent-bright, var(--accent)); border: 1px solid var(--accent); padding: 0 4px; border-radius: 3px; flex-shrink: 0; }
.card-phase { font-size: 11px; color: var(--text2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card-meta { display: flex; gap: 4px 8px; flex-wrap: wrap; font-size: 11px; color: var(--text2); margin-top: 4px; }
.card-score { font-size: 11px; font-weight: 600; }
.card-score.pass { color: var(--pass); }
.card-score.warn { color: var(--warn); }
.card-score.fail { color: var(--fail); }
.card-score.error { color: var(--error); }
.card-score.timeout { color: var(--timeout); }
.card-score.skip { color: var(--skip); }

/* ── Detail Drawer ── */
.drawer {
  position: fixed; top: 0; right: 0; width: 560px; max-width: 94vw; height: 100vh;
  background: var(--surface); border-left: 1px solid var(--border);
  transform: translateX(100%); transition: transform .25s; z-index: 200;
  display: flex; flex-direction: column; overflow: hidden;
  box-shadow: -18px 0 48px -24px #000c;
}
.drawer.open { transform: translateX(0); }
/* click-away scrim: covers the page while the drawer is open; clicking it closes the drawer */
.drawer-backdrop {
  position: fixed; inset: 0; background: #020805a8; z-index: 150;
  opacity: 0; pointer-events: none; transition: opacity .2s;
}
.drawer-backdrop.open { opacity: 1; pointer-events: auto; }
.drawer-header {
  padding: 14px 16px; border-bottom: 1px solid var(--border);
  display: flex; align-items: center; gap: 8px;
}
.drawer-title { font-weight: 700; font-size: 15px; flex: 1; }
.drawer-close { cursor: pointer; color: var(--text2); font-size: 18px; padding: 2px 6px; }
.drawer-close:hover { color: var(--text); }
.drawer-body { flex: 1; overflow-y: auto; padding: 14px 16px; }
.screenshot-img { width: 100%; border-radius: 8px; border: 1px solid var(--border2); margin-bottom: 12px; cursor: zoom-in; display: block; }
.meta-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px 14px; margin-bottom: 12px; }
.meta-item { display: flex; flex-direction: column; min-width: 0; }
.meta-item.wide { grid-column: 1 / -1; }
.meta-key { font-size: 10px; color: var(--text2); text-transform: uppercase; letter-spacing: .5px; }
.meta-val { font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.drawer-score { font-size: 12px; font-weight: 700; padding: 2px 10px; border-radius: 5px; text-transform: uppercase; letter-spacing: .5px; }
.drawer-score.pass { color: var(--pass); background: var(--pass-dim); }
.drawer-score.warn { color: var(--warn); background: var(--warn-dim); }
.drawer-score.fail { color: var(--fail); background: var(--fail-dim); }
.drawer-score.error { color: var(--error); background: var(--error-dim); }
.drawer-score.timeout { color: var(--timeout); background: var(--timeout-dim); }
.drawer-score.skip { color: var(--skip); background: var(--skip-dim); }
.logs { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 8px; max-height: 320px; overflow-y: auto; }
.log-line { font-size: 11px; color: var(--text2); font-family: monospace; white-space: pre-wrap; line-height: 1.6; }
.section-label { font-size: 11px; font-weight: 600; color: var(--text2); text-transform: uppercase; letter-spacing: .5px; margin-bottom: 6px; }

/* ── Animations ── */
@keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:.4; } }
@keyframes spin-dot { 0% { box-shadow: 0 0 0 0 var(--accent); } 70% { box-shadow: 0 0 0 5px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
</style>
</head>
<body>
<header>
  <div class="logo"><span class="mark">CI</span><span class="name">Hub</span><span class="sub">Fleet&nbsp;QA</span></div>
  <div class="hdr-controls">
    <button class="btn active" id="mode-quick" onclick="setMode('quick')">Quick</button>
    <button class="btn" id="mode-full" onclick="setMode('full')">Full (${CATALOG.length})</button>
    <div class="mode-sep"></div>
    <div class="node-sel" id="node-sel"></div>
    <div class="mode-sep"></div>
    <button class="btn" id="btn-preflight" onclick="preflight()">Preflight</button>
    <button class="btn primary" id="btn-start" onclick="startRun()">&#9654; Start</button>
    <button class="btn danger" id="btn-stop" onclick="stopRun()" disabled>&#9632; Stop</button>
    <button class="btn" onclick="resetRun()">&#8635; Reset</button>
  </div>
  <div class="hdr-right">
    <div class="conn" id="conn"></div>
    <div id="elapsed" class="elapsed">Not running</div>
  </div>
</header>

<div class="summary">
  <div class="chips" id="chips">
    <button class="chip on" id="chip-total" onclick="setStatFilter('')" title="Show all apps"><span class="chip-n" id="s-total">0</span><span class="chip-l">Total</span></button>
    <button class="chip running" id="chip-running" onclick="setStatFilter('running')" title="Filter: in-flight"><span class="chip-n" id="s-running">0</span><span class="chip-l">Running</span></button>
    <button class="chip pass" id="chip-pass" onclick="setStatFilter('pass')" title="Filter: pass"><span class="chip-n" id="s-pass">0</span><span class="chip-l">Pass</span></button>
    <button class="chip warn" id="chip-warn" onclick="setStatFilter('warn')" title="Filter: warn"><span class="chip-n" id="s-warn">0</span><span class="chip-l">Warn</span></button>
    <button class="chip fail" id="chip-fail" onclick="setStatFilter('fail')" title="Filter: fail"><span class="chip-n" id="s-fail">0</span><span class="chip-l">Fail</span></button>
    <button class="chip error" id="chip-error" onclick="setStatFilter('error')" title="Filter: error"><span class="chip-n" id="s-error">0</span><span class="chip-l">Error</span></button>
    <button class="chip timeout" id="chip-timeout" onclick="setStatFilter('timeout')" title="Filter: timeout"><span class="chip-n" id="s-timeout">0</span><span class="chip-l">Timeout</span></button>
    <button class="chip skip" id="chip-skip" onclick="setStatFilter('skip')" title="Filter: skip"><span class="chip-n" id="s-skip">0</span><span class="chip-l">Skip</span></button>
  </div>
  <div class="progress-outer">
    <div class="progress-bar"><div class="progress-fill" id="progress-fill" style="width:0%"></div></div>
    <div class="progress-label" id="progress-label">0 / 0 apps tested</div>
  </div>
  <span class="shown-note" id="shown-note"></span>
  <input class="filter-input" id="filter-text" placeholder="Search apps..." oninput="applyFilters()">
</div>

<div class="grid" id="grid"></div>

<div class="drawer-backdrop" id="drawer-backdrop" onclick="closeDrawer()"></div>
<div class="drawer" id="drawer">
  <div class="drawer-header">
    <span class="drawer-title" id="drawer-title">App Details</span>
    <span class="drawer-score" id="drawer-score" style="display:none"></span>
    <span class="drawer-close" onclick="closeDrawer()">&times;</span>
  </div>
  <div class="drawer-body" id="drawer-body"></div>
</div>

<script>
var state = { apps: {}, nodes: {}, fleet: [], catalog: [], runMode: 'quick', runStartTs: null };
var selectedNodes = new Set();
var currentMode = 'quick';
var drawerApp = null;
var elapsedTimer = null;
var statFilter = '';                      // active stat-chip filter ('' = all)
var maxima = { maxStart: 1, maxMem: 1 };  // run-wide maxima for the time/size bar graphs

// Stat chips double as filters: click toggles; clicking the active chip (or Total) clears.
function setStatFilter(f) {
  statFilter = (statFilter === f) ? '' : f;
  document.querySelectorAll('.chip').forEach(function(c) { c.classList.remove('on'); });
  var el = document.getElementById('chip-' + (statFilter || 'total'));
  if (el) el.classList.add('on');
  applyFilters();
}

// One horizontal mini bar: label | track | value. pct is relative to the run-wide max.
function barRow(lab, txt, val, max, cls) {
  var pct = Math.max(3, Math.min(100, Math.round((val / Math.max(1, max)) * 100)));
  return '<div class="bar-row"><span class="bar-ico">' + lab + '</span>'
    + '<div class="bar-track"><div class="bar-fill ' + (cls || '') + '" style="width:' + pct + '%"></div></div>'
    + '<span class="bar-val">' + txt + '</span></div>';
}

function setMode(m) {
  currentMode = m;
  document.getElementById('mode-quick').className = 'btn' + (m === 'quick' ? ' active' : '');
  document.getElementById('mode-full').className = 'btn' + (m === 'full' ? ' active' : '');
}

function startRun() {
  var nodes = selectedNodes.size > 0 ? Array.from(selectedNodes) : null;
  fetch('/api/start', { method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ mode: currentMode, nodes: nodes }) });
  document.getElementById('btn-start').disabled = true;
  document.getElementById('btn-stop').disabled = false;
}

function preflight() {
  var nodes = selectedNodes.size > 0 ? Array.from(selectedNodes) : null;
  fetch('/api/preflight', { method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ nodes: nodes }) });
}

function stopRun() {
  fetch('/api/stop', { method: 'POST' });
  document.getElementById('btn-start').disabled = false;
  document.getElementById('btn-stop').disabled = true;
}

function resetRun() {
  fetch('/api/reset', { method: 'POST' });
  document.getElementById('btn-start').disabled = false;
  document.getElementById('btn-stop').disabled = true;
  clearInterval(elapsedTimer);
  document.getElementById('elapsed').textContent = 'Not running';
}

function fmtMs(ms) {
  if (!ms || ms < 0) return '—';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms/1000).toFixed(1) + 's';
  return Math.floor(ms/60000) + 'm ' + Math.floor((ms%60000)/1000) + 's';
}

function fmtElapsed(startTs) {
  var sec = Math.floor((Date.now() - startTs) / 1000);
  var m = Math.floor(sec/60), s = sec % 60;
  return (m > 0 ? m + 'm ' : '') + s + 's elapsed';
}

function buildNodeSel(fleet) {
  var el = document.getElementById('node-sel');
  el.innerHTML = '';
  fleet.forEach(function(n) {
    var b = document.createElement('span');
    b.className = 'node-badge';
    b.textContent = n.name;
    b.dataset.node = n.name;
    b.onclick = function() {
      if (selectedNodes.has(n.name)) { selectedNodes.delete(n.name); b.classList.remove('selected'); }
      else { selectedNodes.add(n.name); b.classList.add('selected'); }
    };
    el.appendChild(b);
  });
}

function updateNodeBadge(ns) {
  var b = document.querySelector('[data-node="' + ns.name + '"]');
  if (!b) return;
  b.className = 'node-badge ' + ns.status + (selectedNodes.has(ns.name) ? ' selected' : '');
  var pct = ns.total > 0 ? Math.round(ns.done / ns.total * 100) : 0;
  b.title = ns.name + ': ' + ns.done + '/' + ns.total + ' (' + pct + '%)'
    + (ns.currentApp ? ' — ' + ns.currentApp : '')
    + (ns.error ? ' ERROR: ' + ns.error : '')
    + (ns.preflight && ns.preflight.output ? ' PREFLIGHT: ' + ns.preflight.output : '');
}

function buildGrid(catalog) {
  var grid = document.getElementById('grid');
  grid.innerHTML = '';
  catalog.forEach(function(app) {
    var card = document.createElement('div');
    card.className = 'card idle';
    card.id = 'card-' + app.id;
    card.onclick = function() { openDrawer(app.id); };
    card.innerHTML = cardHtml(app, state.apps[app.id] || { id: app.id, name: app.name, status: 'idle', categories: app.categories || [], phase: '', message: '', result: null });
    grid.appendChild(card);
  });
  applyFilters();
}

function cardHtml(app, s) {
  var status = s ? s.status : 'idle';
  var node = s && s.node ? s.node : '';
  var cats = (s ? s.categories : app.categories || []).slice(0, 2).map(function(c) {
    return '<span class="cat-tag">' + c + '</span>';
  }).join('');
  var phase = s ? (s.message || s.phase || '') : '';
  // Expanded result data: boot time + RAM as bar graphs (relative to the run-wide max),
  // plus a compact footer with pull time, readiness signal, attempts and HTTP status.
  var bars = '';
  var meta = '';
  if (s && s.result) {
    var r = s.result;
    if (r.startupMs > 0) bars += barRow('boot', fmtMs(r.startupMs), r.startupMs, maxima.maxStart, '');
    if (r.memMb > 0) bars += barRow('ram', r.memMb + 'MB', r.memMb, maxima.maxMem, 'mem');
    var parts = [];
    if (r.pullMs > 0) parts.push('pull ' + fmtMs(r.pullMs));
    if (r.readyVia) parts.push('via ' + r.readyVia);
    if (r.httpStatus) parts.push('HTTP ' + r.httpStatus);
    if (r.attempts > 1 || r.retried) parts.push((r.attempts || 2) + ' tries');
    if (r.imageMb > 0) parts.push(Math.round(r.imageMb) + 'MB img');
    meta = parts.join(' &middot; ');
  }
  var scoreHtml = '';
  var SCORE_LABELS = { pass:'PASS', warn:'WARN', fail:'FAIL', error:'ERROR', timeout:'TIMEOUT', skip:'SKIP' };
  if (SCORE_LABELS[status]) scoreHtml = '<span class="card-score ' + status + '">' + SCORE_LABELS[status] + '</span>';
  var ssFile = (node ? node + '_' : '') + app.id + '.png';
  // Cache-bust by the app's end time so a re-run's fresh capture replaces the cached thumbnail
  // (same filename otherwise pins the browser to the stale image — the "screenshots not updating" bug).
  var ssBust = (s && s.endTs) ? ('?t=' + s.endTs) : '';
  var thumb = '<img class="card-thumb" loading="lazy" src="/screenshots/' + ssFile + ssBust + '" onerror="this.remove()">';
  return thumb
    + '<div class="card-status">'
    + '<div class="dot ' + status + '"></div>'
    + '<div class="card-name">' + (s ? s.name : app.name) + '</div>'
    + (app.mcp ? '<span class="mcp-badge" title="MCP server — verified via protocol smoke">MCP</span>' : '')
    + (node ? '<div class="card-node">' + node + '</div>' : '')
    + '</div>'
    + '<div class="card-cats">' + cats + '</div>'
    + (phase ? '<div class="card-phase">' + phase + '</div>' : '')
    + bars
    + (meta ? '<div class="card-meta">' + meta + '</div>' : '')
    + scoreHtml;
}

function updateCard(appId) {
  var card = document.getElementById('card-' + appId);
  if (!card) return;
  var s = state.apps[appId];
  if (!s) return;
  var app = state.catalog.find(function(a) { return a.id === appId; }) || { id: appId, name: appId, categories: [] };
  card.className = 'card ' + s.status;
  card.innerHTML = cardHtml(app, s);
  card.onclick = function() { openDrawer(appId); };
  if (drawerApp === appId) renderDrawer(appId);
  applyFilters();
}

function setStat(id, v) { var e = document.getElementById(id); if (e) e.textContent = v; }
function updateSummary(fleet) {
  var apps = Object.values(state.apps);
  var done = apps.filter(function(a) { return ['pass','warn','fail','error','timeout','skip'].includes(a.status); }).length;
  var total = apps.length;
  var running = apps.filter(function(a) { return ['pulling','starting','http','screenshot','benchmark','queued'].includes(a.status); }).length;
  var pass = apps.filter(function(a) { return a.status === 'pass'; }).length;
  var warn = apps.filter(function(a) { return a.status === 'warn'; }).length;
  var fail = apps.filter(function(a) { return a.status === 'fail'; }).length;
  var error = apps.filter(function(a) { return a.status === 'error'; }).length;
  var timeout = apps.filter(function(a) { return a.status === 'timeout'; }).length;
  var skip = apps.filter(function(a) { return a.status === 'skip'; }).length;
  setStat('s-total', total); setStat('s-running', running); setStat('s-pass', pass);
  setStat('s-warn', warn); setStat('s-fail', fail); setStat('s-error', error);
  setStat('s-timeout', timeout); setStat('s-skip', skip);
  var pct = total > 0 ? (done / total * 100).toFixed(1) : 0;
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('progress-label').textContent = done + ' / ' + total + ' tested' + (skip ? ' (' + skip + ' skipped)' : '');
  // Refresh run-wide maxima for the card/drawer bar graphs (outlier-damped).
  var starts = [], mems = [];
  apps.forEach(function(a) {
    var r = a.result;
    if (r) {
      if (r.startupMs > 0) starts.push(r.startupMs);
      if (r.memMb > 0) mems.push(r.memMb);
    }
  });
  maxima = { maxStart: scaleMax(starts), maxMem: scaleMax(mems) };
}

// Bar-graph scale: the run-wide max, except a single extreme outlier doesn't get to
// flatten every other bar — with enough samples we scale to ~p95 and let the outlier
// clamp at 100% (barRow caps pct anyway).
function scaleMax(vals) {
  if (vals.length === 0) return 1;
  vals.sort(function(a, b) { return a - b; });
  var hi = vals[vals.length - 1];
  if (vals.length >= 5) {
    var p95 = vals[Math.floor((vals.length - 1) * 0.95)];
    if (p95 > 0 && hi > p95 * 1.5) return p95;
  }
  return hi;
}

function applyFilters() {
  var textFilter = document.getElementById('filter-text').value.toLowerCase();
  var cards = document.querySelectorAll('.card');
  var visible = 0;
  cards.forEach(function(card) {
    var appId = card.id.replace('card-', '');
    var s = state.apps[appId];
    var status = s ? s.status : 'idle';
    var name = (s ? s.name : appId).toLowerCase();
    var cats = (s ? s.categories : []).join(' ').toLowerCase();
    var showStatus = !statFilter || status === statFilter
      || (statFilter === 'running' && ['pulling','starting','http','screenshot','benchmark','queued'].includes(status));
    var showText = !textFilter || name.includes(textFilter) || appId.includes(textFilter) || cats.includes(textFilter);
    card.style.display = (showStatus && showText) ? '' : 'none';
    if (showStatus && showText) visible++;
  });
  var note = document.getElementById('shown-note');
  note.textContent = (statFilter || textFilter) ? (visible + ' of ' + state.catalog.length + ' shown') : '';
}

function openDrawer(appId) {
  drawerApp = appId;
  renderDrawer(appId);
  document.getElementById('drawer').classList.add('open');
  document.getElementById('drawer-backdrop').classList.add('open');
}

function closeDrawer() {
  drawerApp = null;
  document.getElementById('drawer').classList.remove('open');
  document.getElementById('drawer-backdrop').classList.remove('open');
}

// Esc also closes the drawer (in addition to the click-away backdrop and the × button).
document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeDrawer(); });

function renderDrawer(appId) {
  var s = state.apps[appId];
  var app = state.catalog.find(function(a) { return a.id === appId; }) || { id: appId, name: appId };
  document.getElementById('drawer-title').textContent = (s ? s.name : appId);
  var scoreEl = document.getElementById('drawer-score');
  var SCORES = ['pass','warn','fail','error','timeout','skip'];
  if (s && SCORES.includes(s.status)) {
    scoreEl.textContent = s.status;
    scoreEl.className = 'drawer-score ' + s.status;
    scoreEl.style.display = '';
  } else {
    scoreEl.style.display = 'none';
  }
  var body = document.getElementById('drawer-body');
  var html = '';
  // Screenshot — full drawer width; click opens the raw capture in a new tab.
  var ssFile = (s && s.node ? s.node + '_' : '') + appId + '.png';
  var ssBust = (s && s.endTs) ? ('?t=' + s.endTs) : '';
  var ssUrl = '/screenshots/' + ssFile + ssBust;
  html += '<img class="screenshot-img" src="' + ssUrl + '" onerror="this.hidden=true" onclick="window.open(this.src, \\'_blank\\')" title="Open full-size capture">';
  var r = s && s.result ? s.result : {};
  function metaGrid(items) {
    var g = '<div class="meta-grid">';
    items.forEach(function(item) {
      g += '<div class="meta-item' + (item[2] ? ' wide' : '') + '"><span class="meta-key">' + item[0] + '</span><span class="meta-val">' + item[1] + '</span></div>';
    });
    return g + '</div>';
  }
  // ── Status — score + readiness/health signals
  var backendVal = r.backendHealthy === true ? 'healthy' : r.backendHealthy === false ? 'DEGRADED' : '—';
  html += '<div class="section-label">Status</div>';
  html += metaGrid([
    ['Status', (s && s.status) || 'idle'],
    ['Node', (s && s.node) || '—'],
    ['Fail kind', r.failKind || '—'],
    ['Ready via', r.readyVia || '—'],
    ['HTTP', r.httpStatus ? 'HTTP ' + r.httpStatus : '—'],
    ['Backend', backendVal],
    ['Attempts', r.attempts ? (r.attempts + (r.retried ? ' (retried)' : '')) : '—'],
    ['Finished', (s && s.endTs) ? new Date(s.endTs).toLocaleTimeString() : '—'],
  ]);
  // ── Performance — same bar-graph treatment as the cards, scaled to the run-wide maxima.
  var bars = '';
  if (r.pullMs > 0) bars += barRow('pull', fmtMs(r.pullMs), r.pullMs, Math.max(maxima.maxStart, r.pullMs), '');
  if (r.startupMs > 0) bars += barRow('boot', fmtMs(r.startupMs), r.startupMs, maxima.maxStart, '');
  if (r.memMb > 0) bars += barRow('ram', r.memMb + ' MB', r.memMb, maxima.maxMem, 'mem');
  if (r.memPeakMb > 0) bars += barRow('peak', r.memPeakMb + ' MB', r.memPeakMb, maxima.maxMem, 'mem');
  if (r.cpuPct > 0) bars += barRow('cpu', r.cpuPct + '%', r.cpuPct, 100, '');
  if (bars) {
    html += '<div class="section-label" style="margin-top:12px">Performance</div>';
    html += '<div style="margin-bottom:12px">' + bars + '</div>';
  }
  // ── Container — image / port / catalog identity
  html += '<div class="section-label" style="margin-top:12px">Container</div>';
  html += metaGrid([
    ['Image size', r.imageMb > 0 ? Math.round(r.imageMb) + ' MB' : '—'],
    ['Port', r.port || app.port || '—'],
    ['Categories', ((s && s.categories) || app.categories || []).join(', ') || '—'],
    ['Image', (r.image || app.image) || '—', true],
  ]);
  // Notes
  if (r.notes || (s && s.message)) {
    html += '<div class="section-label" style="margin-top:10px">Notes</div>';
    html += '<div class="log-line" style="background:var(--bg);padding:8px;border-radius:6px;margin-bottom:10px">' + (r.notes || s.message) + '</div>';
  }
  // Backend service errors (captured when a stack is degraded)
  if (r.backendErrors) {
    html += '<div class="section-label">Backend Errors</div>';
    html += '<div class="log-line" style="background:var(--bg);padding:8px;border-radius:6px;margin-bottom:10px">' + r.backendErrors + '</div>';
  }
  // Logs
  if (s && s.logs && s.logs.length > 0) {
    html += '<div class="section-label">Log</div>';
    html += '<div class="logs">';
    s.logs.forEach(function(l) { html += '<div class="log-line">' + l + '</div>'; });
    html += '</div>';
  }
  body.innerHTML = html;
  // Scroll logs to bottom
  var logs = body.querySelector('.logs');
  if (logs) logs.scrollTop = logs.scrollHeight;
}

// ── SSE ──────────────────────────────────────────────────────────────────────
var es;
function connect() {
  es = new EventSource('/api/events');
  es.onopen = function() { document.getElementById('conn').className = 'conn live'; };
  es.onerror = function() {
    document.getElementById('conn').className = 'conn';
    setTimeout(connect, 3000);
  };
  es.onmessage = function(e) {
    var msg = JSON.parse(e.data);
    handleEvent(msg);
  };
}

function handleEvent(msg) {
  var ev = msg.event;
  if (ev === 'snapshot') {
    state = { apps: msg.apps || {}, nodes: msg.nodes || {}, fleet: msg.fleet || [], catalog: msg.catalog || [], runMode: msg.runMode, runStartTs: msg.runStartTs };
    buildNodeSel(state.fleet);
    buildGrid(state.catalog);
    Object.values(state.nodes).forEach(function(ns) { updateNodeBadge(ns); });
    updateSummary();
    setMode(state.runMode || 'quick');
    if (state.runStartTs) startElapsedTimer(state.runStartTs);
  } else if (ev === 'node_status') {
    state.nodes[msg.node] = msg;
    updateNodeBadge(msg);
  } else if (ev === 'apps_queued') {
    msg.appIds.forEach(function(id) {
      if (state.apps[id]) { state.apps[id].status = 'queued'; state.apps[id].node = msg.node; }
      updateCard(id);
    });
    updateSummary();
  } else if (ev === 'app_start') {
    if (!state.apps[msg.appId]) state.apps[msg.appId] = { id: msg.appId, name: msg.appId, status: 'pulling', node: msg.node, categories: [], logs: [], phase: '', message: '', result: null, startTs: msg.ts, endTs: null };
    else { state.apps[msg.appId].status = 'pulling'; state.apps[msg.appId].node = msg.node; state.apps[msg.appId].startTs = msg.ts; state.apps[msg.appId].logs = []; }
    updateCard(msg.appId);
    updateSummary();
  } else if (ev === 'app_phase') {
    var s = state.apps[msg.appId];
    if (s) { s.status = msg.phase; s.phase = msg.phase; s.message = msg.message; s.logs.push('[' + msg.phase + '] ' + msg.message); }
    updateCard(msg.appId);
  } else if (ev === 'app_result') {
    var s = state.apps[msg.appId];
    if (s) { s.status = (msg.result && msg.result.score) || 'fail'; s.result = msg.result; s.endTs = Date.now(); s.message = (msg.result && msg.result.notes) || ''; }
    updateCard(msg.appId);
    updateSummary();
  } else if (ev === 'fleet_status') {
    updateSummary();
  } else if (ev === 'run_start') {
    startElapsedTimer(msg.ts);
    document.getElementById('btn-start').disabled = true;
    document.getElementById('btn-stop').disabled = false;
  } else if (ev === 'run_complete' || ev === 'run_stopped') {
    clearInterval(elapsedTimer);
    if (ev === 'run_complete') document.getElementById('elapsed').textContent = fmtMs(msg.durationMs) + ' total';
    document.getElementById('btn-start').disabled = false;
    document.getElementById('btn-stop').disabled = true;
  } else if (ev === 'reset') {
    buildGrid(state.catalog);
    updateSummary();
    clearInterval(elapsedTimer);
    document.getElementById('elapsed').textContent = 'Not running';
    document.getElementById('btn-start').disabled = false;
    document.getElementById('btn-stop').disabled = true;
  }
}

function startElapsedTimer(startTs) {
  clearInterval(elapsedTimer);
  elapsedTimer = setInterval(function() {
    document.getElementById('elapsed').textContent = fmtElapsed(startTs);
  }, 1000);
}

connect();
</script>
</body>
</html>`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

const server = createServer(handler);
server.listen(PORT, '0.0.0.0', () => {
  const localIp = getLocalIp();
  console.log('');
  console.log('  CI-Hub Fleet QA Server');
  console.log('  ─────────────────────────────────────────');
  console.log(`  Local:     http://localhost:${PORT}`);
  console.log(`  Network:   http://${localIp}:${PORT}  ← open this on any Tailscale device`);
  console.log(`  Fleet:     ${FLEET.length} nodes configured`);
  console.log(`  Catalog:   ${CATALOG.length} apps`);
  if (!process.env.FLEET_CONFIG_JSON) {
    console.log('');
    console.log('  ⚠  Using built-in fleet IPs. Set FLEET_CONFIG_JSON to override.');
  }
  console.log('');
  for (const n of FLEET) console.log(`  · ${n.name.padEnd(12)} ${n.ip}`);
  console.log('');
});

server.on('error', (err) => {
  console.error('Server error:', err);
  process.exit(1);
});
