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
 *   STORE_ROOT_REMOTE   Path to CI-Marketplace on fleet nodes   (default: ~/devel/CI-Marketplace)
 *   QA_PORT             HTTP port to listen on                  (default: 4242)
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, mkdirSync, createReadStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { homedir, networkInterfaces } from 'node:os';

const __dir = dirname(fileURLToPath(import.meta.url));

// ─── Config ────────────────────────────────────────────────────────────────

const PORT = Number(process.env.QA_PORT ?? process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] ?? 4242);
const DEFAULT_MODE = (process.argv.find((a) => a.startsWith('--mode='))?.split('=')[1] ?? 'quick') as 'quick' | 'full';
const SSH_USER = process.env.FLEET_SSH_USER ?? 'ci';
const STORE_ROOT = process.env.STORE_ROOT_REMOTE ?? '~/devel/CI-Marketplace';
const SCREENSHOTS_DIR = join(homedir(), 'qa-results', 'fleet-screenshots');
const STREAM_SCRIPT = join(__dir, 'qa-stream.ts');
const CATALOG_FILE = join(__dir, '..', 'e2e', 'generated', 'catalog.json');

if (!existsSync(SCREENSHOTS_DIR)) mkdirSync(SCREENSHOTS_DIR, { recursive: true });

interface FleetNode {
  name: string;
  ip: string;
  batch: number;
  user?: string; // overrides SSH_USER for this node
}

const BUILTIN_FLEET: FleetNode[] = [
  // core-5: ci user has permission error — skip until fixed
  // core-8/9: Docker not in PATH — skip until provisioned
  { name: 'core-1', ip: '100.108.17.53', batch: 0 },
  { name: 'core-2', ip: '100.101.156.33', batch: 1 },
  { name: 'core-6', ip: '100.95.23.128', batch: 2 },
  // core-10: no Node.js installed — skip until provisioned
  // { name: 'core-10',  ip: '100.87.68.116',  batch: 3 },
  { name: 'core-13', ip: '100.76.114.122', batch: 4 },
  { name: 'beta-1', ip: '100.124.211.75', batch: 5 },
  { name: 'beta-red', ip: '100.86.79.25', batch: 6 },
];

const FLEET: FleetNode[] = process.env.FLEET_CONFIG_JSON ? JSON.parse(process.env.FLEET_CONFIG_JSON) : BUILTIN_FLEET;

// ─── App Catalog ────────────────────────────────────────────────────────────

interface AppSpec {
  id: string;
  name: string;
  categories: string[];
  priority: 'high' | 'medium' | 'low';
  expectedPort: number;
  storeSlug: string;
  hasGui: boolean;
}

let CATALOG: AppSpec[] = [];
if (existsSync(CATALOG_FILE)) {
  CATALOG = JSON.parse(readFileSync(CATALOG_FILE, 'utf-8'));
} else {
  console.warn(`⚠  Catalog not found at ${CATALOG_FILE} — run generate-catalog-tests.ts first`);
}

function distributeApps(nodes: FleetNode[], mode: 'quick' | 'full'): Map<string, AppSpec[]> {
  const dist = new Map<string, AppSpec[]>(nodes.map((n) => [n.name, []]));
  const apps = mode === 'quick' ? CATALOG.filter((a) => a.priority === 'high').slice(0, 2 * nodes.length) : CATALOG;

  apps.forEach((app, i) => {
    const node = nodes[i % nodes.length];
    dist.get(node.name)?.push(app);
  });
  return dist;
}

// ─── State ──────────────────────────────────────────────────────────────────

type AppStatus = 'idle' | 'queued' | 'pulling' | 'starting' | 'http' | 'screenshot' | 'benchmark' | 'pass' | 'warn' | 'fail' | 'error';

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
    runStartTs,
  });
}

// ─── SSH + Stream Orchestration ─────────────────────────────────────────────

// Source tool managers before running commands — handles NVM, ASDF, Bun without login-shell noise
const REMOTE_TOOL_INIT =
  'source ~/.nvm/nvm.sh 2>/dev/null; source ~/.asdf/asdf.sh 2>/dev/null; ' +
  'source ~/.bun/env 2>/dev/null; ' +
  'export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node/ 2>/dev/null | sort -V | tail -1)/bin:$HOME/.bun/bin:$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/bin:$PATH"';

function sshSpawn(node: FleetNode, cmd: string): ChildProcess {
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
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function summarizeError(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

function shellEscapeArg(value: string): string {
  // Single-quote shell escaping: 'foo' -> 'foo', a'b -> 'a'"'"'b'
  return `'${value.replace(/'/g, `'"'"'`)}'`;
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
    const proc = spawn(
      'scp',
      ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10', STREAM_SCRIPT, `${node.user ?? SSH_USER}@${node.ip}:/tmp/qa-stream.ts`],
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
    '(command -v tsx >/dev/null 2>&1 || command -v pnpm >/dev/null 2>&1)',
    // Try CI-Marketplace, CI-App-Store (legacy), and /tmp fallback
    `(test -d ${STORE_ROOT}/apps || test -d ~/devel/CI-App-Store/apps || test -d /tmp/CI-Marketplace/apps)`,
    `(test -f ${STORE_ROOT}/apps/code-server/config.json || test -f ~/devel/CI-App-Store/apps/code-server/config.json || test -f /tmp/CI-Marketplace/apps/code-server/config.json)`,
    // Emit which store dir was found so the run command can use it
    `echo storeDir=$(test -d ${STORE_ROOT}/apps && echo ${STORE_ROOT} || test -d ~/devel/CI-App-Store/apps && echo ~/devel/CI-App-Store || echo /tmp/CI-Marketplace)`,
    'echo ok',
  ].join(' && ');

  const result = await sshCapture(node, cmd, 30_000);
  const ok = result.ok && result.out.includes('ok');
  // Parse storeDir from preflight output: "storeDir=~/devel/CI-App-Store" or similar
  const storeDirMatch = result.out.match(/storeDir=(\S+)/);
  ns.storeDir = storeDirMatch?.[1] ?? null;
  ns.status = ok ? 'idle' : 'offline';
  ns.error = ok ? null : summarizeError(result.err || result.out) || 'Preflight failed';
  ns.preflight = {
    ok,
    output: summarizeError(result.out),
    error: summarizeError(result.err),
    checkedAt: Date.now(),
    storeDir: ns.storeDir,
  };

  if (ok) {
    logNode(node.name, `preflight OK (storeDir=${ns.storeDir ?? 'unknown'})`);
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

async function runNodeTests(node: FleetNode, apps: AppSpec[]) {
  const ns = nodeStates.get(node.name);
  if (!ns) return;
  ns.total = apps.length;
  ns.done = 0;
  ns.status = 'syncing';
  logNode(node.name, `assigned ${apps.length} app(s)`);
  broadcast({ event: 'node_status', node: node.name, ...ns });

  // Mark apps as queued
  for (const app of apps) {
    const s = appStates.get(app.id);
    if (s) {
      s.status = 'queued';
      s.node = node.name;
    }
  }
  broadcast({ event: 'apps_queued', node: node.name, appIds: apps.map((a) => a.id) });

  // SCP the streaming script to the node
  const scpResult = await scpScript(node);
  if (!scpResult.ok) {
    ns.status = 'offline';
    ns.error = scpResult.error ?? 'Could not SCP qa-stream.ts';
    logNode(node.name, `SCP failed: ${ns.error}`);
    broadcast({ event: 'node_status', node: node.name, ...ns });
    for (const app of apps) {
      const s = appStates.get(app.id);
      if (s) {
        s.status = 'error';
        s.message = 'Node offline';
      }
    }
    broadcastFleetStatus();
    return;
  }

  ns.status = 'running';
  logNode(node.name, 'starting remote qa-stream runner');
  broadcast({ event: 'node_status', node: node.name, ...ns });

  const remoteResultsDir = '~/qa-results-fleet';
  const appList = apps.map((a) => shellEscapeArg(a.id)).join(' ');
  const TSX_DLX_VERSION = '4.21.0';
  // Use the storeDir resolved at preflight (CI-Marketplace or CI-App-Store)
  const resolvedStore = ns.storeDir ?? STORE_ROOT;
  const cmd = [
    `mkdir -p ${remoteResultsDir}/screenshots`,
    `(command -v tsx >/dev/null 2>&1 && APP_STORE_DIR=${resolvedStore}/apps RESULTS_DIR=${remoteResultsDir} tsx /tmp/qa-stream.ts ${appList}` +
      ` || APP_STORE_DIR=${resolvedStore}/apps RESULTS_DIR=${remoteResultsDir} pnpm dlx tsx@${TSX_DLX_VERSION} /tmp/qa-stream.ts ${appList})`,
  ].join(' && ');

  await new Promise<void>((resolve) => {
    const proc = sshSpawn(node, cmd);
    sshProcesses.set(node.name, proc);
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
      ns.status = code === 0 ? 'done' : 'error';
      if (code !== 0) ns.error = `SSH exited with code ${code}`;
      logNode(node.name, code === 0 ? 'completed successfully' : `failed (${ns.error})`);
      ns.currentApp = null;
      broadcast({ event: 'node_status', node: node.name, ...ns });
      sshProcesses.delete(node.name);
      broadcastFleetStatus();
      resolve();
    });

    proc.on('error', (err) => {
      ns.status = 'error';
      ns.error = err.message;
      logNode(node.name, `runner process error: ${err.message}`);
      broadcast({ event: 'node_status', node: node.name, ...ns });
      sshProcesses.delete(node.name);
      broadcastFleetStatus();
      resolve();
    });
  });
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
    const s = appStates.get(appId);
    if (s) {
      s.status = (res?.score as AppStatus) ?? 'fail';
      s.result = res;
      s.endTs = Date.now();
      s.message = String(res?.notes ?? '');
    }
    ns.done++;
    logNode(node.name, `app_result ${appId}: ${String(res?.score ?? 'unknown')}${res?.notes ? ` (${summarizeError(String(res.notes))})` : ''}`);
    broadcast({ event: 'app_result', node: node.name, appId, result: res });
    broadcast({ event: 'node_status', node: node.name, ...ns });
    if (res?.hasScreenshot) scpScreenshot(node, appId);
    broadcastFleetStatus();
  } else if (event === 'batch_done') {
    broadcast({ event: 'node_batch_done', node: node.name, ...raw });
  }
}

// ─── Run Control ────────────────────────────────────────────────────────────

function stopRun() {
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
  for (const s of appStates.values()) {
    s.status = 'idle';
    s.node = null;
    s.result = null;
    s.logs = [];
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
  console.log(`[fleet] run_start mode=${mode}${selectedNodes?.length ? ` nodes=${selectedNodes.join(',')}` : ' nodes=all'}`);
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

  const dist = distributeApps(nodes, mode);
  const nodePromises: Promise<void>[] = [];

  for (const node of nodes) {
    const apps = dist.get(node.name) ?? [];
    if (apps.length === 0) continue;
    nodePromises.push(runNodeTests(node, apps));
  }

  Promise.all(nodePromises).then(() => {
    const states = Array.from(appStates.values());
    const durationMs = runStartTs ? Date.now() - runStartTs : 0;
    console.log(
      `[fleet] run_complete total=${states.length} pass=${states.filter((s) => s.status === 'pass').length} warn=${states.filter((s) => s.status === 'warn').length} fail=${states.filter((s) => s.status === 'fail').length} duration=${Math.round(durationMs / 1000)}s`,
    );
    broadcast({
      event: 'run_complete',
      total: states.length,
      pass: states.filter((s) => s.status === 'pass').length,
      warn: states.filter((s) => s.status === 'warn').length,
      fail: states.filter((s) => s.status === 'fail').length,
      durationMs,
    });
    runStartTs = null;
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
<style>
:root {
  --bg: #0c0c0f;
  --surface: #16161d;
  --surface2: #1e1e28;
  --border: #2a2a38;
  --accent: #6366f1;
  --accent-dim: #6366f130;
  --pass: #22c55e; --pass-dim: #22c55e20;
  --warn: #f59e0b; --warn-dim: #f59e0b20;
  --fail: #ef4444; --fail-dim: #ef444420;
  --muted: #64748b; --text: #e2e8f0; --text2: #94a3b8;
  --radius: 8px;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--bg); color: var(--text); font: 13px/1.5 system-ui,sans-serif; min-height: 100vh; }

/* ── Header ── */
header {
  position: sticky; top: 0; z-index: 100;
  background: var(--surface); border-bottom: 1px solid var(--border);
  display: flex; align-items: center; gap: 16px; padding: 10px 20px;
}
.logo { font-weight: 700; font-size: 15px; letter-spacing: -.3px; }
.logo span { color: var(--accent); }
.conn { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.conn.live { background: var(--pass); box-shadow: 0 0 6px var(--pass); animation: pulse 2s infinite; }
.elapsed { color: var(--text2); font-size: 12px; margin-left: auto; }

/* ── Summary bar ── */
.summary {
  display: flex; gap: 12px; padding: 12px 20px;
  border-bottom: 1px solid var(--border); flex-wrap: wrap;
}
.stat { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 8px 16px; display: flex; flex-direction: column; align-items: center; min-width: 80px; }
.stat-n { font-size: 22px; font-weight: 700; line-height: 1; }
.stat-l { font-size: 11px; color: var(--text2); margin-top: 2px; text-transform: uppercase; letter-spacing: .5px; }
.stat.pass .stat-n { color: var(--pass); }
.stat.warn .stat-n { color: var(--warn); }
.stat.fail .stat-n { color: var(--fail); }
.stat.running .stat-n { color: var(--accent); }
.progress-outer { flex: 1; min-width: 200px; display: flex; flex-direction: column; justify-content: center; gap: 4px; }
.progress-bar { height: 8px; background: var(--surface2); border-radius: 4px; overflow: hidden; }
.progress-fill { height: 100%; background: var(--accent); border-radius: 4px; transition: width .4s; }
.progress-label { font-size: 11px; color: var(--text2); }

/* ── Controls ── */
.controls {
  display: flex; gap: 8px; padding: 10px 20px; align-items: center;
  border-bottom: 1px solid var(--border); flex-wrap: wrap;
}
.btn {
  padding: 6px 14px; border-radius: 6px; border: 1px solid var(--border);
  background: var(--surface2); color: var(--text); font-size: 12px; cursor: pointer;
  font-weight: 500; transition: all .15s;
}
.btn:hover { border-color: var(--accent); color: var(--accent); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn.primary:hover { opacity: .85; }
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
.grid-header { padding: 8px 20px; display: flex; align-items: center; gap: 8px; }
.grid-header h2 { font-size: 13px; font-weight: 600; }
.filter-input {
  margin-left: auto; padding: 4px 10px; border-radius: 6px;
  border: 1px solid var(--border); background: var(--surface2);
  color: var(--text); font-size: 12px; width: 160px;
}
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
.card.pass { border-left: 3px solid var(--pass); }
.card.warn { border-left: 3px solid var(--warn); }
.card.fail { border-left: 3px solid var(--fail); }
.card.error { border-left: 3px solid var(--fail); opacity: .8; }
.card.running, .card.pulling, .card.starting, .card.http, .card.screenshot, .card.benchmark {
  border-left: 3px solid var(--accent);
}
.card-status { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: var(--muted); }
.dot.pass { background: var(--pass); }
.dot.warn { background: var(--warn); }
.dot.fail, .dot.error { background: var(--fail); }
.dot.running, .dot.pulling, .dot.starting, .dot.http, .dot.screenshot, .dot.benchmark {
  background: var(--accent); animation: spin-dot .8s linear infinite;
}
.dot.queued { background: var(--muted); opacity: .6; }
.card-name { font-weight: 600; font-size: 13px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card-node { font-size: 10px; color: var(--accent); font-weight: 600; padding: 1px 5px; background: var(--accent-dim); border-radius: 3px; flex-shrink: 0; }
.card-cats { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 6px; }
.cat-tag { font-size: 10px; color: var(--text2); background: var(--surface2); padding: 1px 5px; border-radius: 3px; }
.card-phase { font-size: 11px; color: var(--text2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card-meta { display: flex; gap: 8px; font-size: 11px; color: var(--text2); margin-top: 4px; }
.card-score { font-size: 11px; font-weight: 600; }
.card-score.pass { color: var(--pass); }
.card-score.warn { color: var(--warn); }
.card-score.fail { color: var(--fail); }

/* ── Detail Drawer ── */
.drawer {
  position: fixed; top: 0; right: 0; width: 400px; height: 100vh;
  background: var(--surface); border-left: 1px solid var(--border);
  transform: translateX(100%); transition: transform .25s; z-index: 200;
  display: flex; flex-direction: column; overflow: hidden;
}
.drawer.open { transform: translateX(0); }
.drawer-header {
  padding: 14px 16px; border-bottom: 1px solid var(--border);
  display: flex; align-items: center; gap: 8px;
}
.drawer-title { font-weight: 700; font-size: 15px; flex: 1; }
.drawer-close { cursor: pointer; color: var(--text2); font-size: 18px; padding: 2px 6px; }
.drawer-close:hover { color: var(--text); }
.drawer-body { flex: 1; overflow-y: auto; padding: 14px 16px; }
.screenshot-img { width: 100%; border-radius: 6px; border: 1px solid var(--border); margin-bottom: 12px; }
.meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 16px; margin-bottom: 12px; }
.meta-item { display: flex; flex-direction: column; }
.meta-key { font-size: 10px; color: var(--text2); text-transform: uppercase; letter-spacing: .5px; }
.meta-val { font-size: 13px; font-weight: 600; }
.logs { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 8px; max-height: 200px; overflow-y: auto; }
.log-line { font-size: 11px; color: var(--text2); font-family: monospace; white-space: pre-wrap; line-height: 1.6; }
.section-label { font-size: 11px; font-weight: 600; color: var(--text2); text-transform: uppercase; letter-spacing: .5px; margin-bottom: 6px; }

/* ── Animations ── */
@keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:.4; } }
@keyframes spin-dot { 0% { box-shadow: 0 0 0 0 var(--accent); } 70% { box-shadow: 0 0 0 5px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
</style>
</head>
<body>
<header>
  <div class="logo">CI&#8209;Hub &nbsp;<span>Fleet QA</span></div>
  <div class="conn" id="conn"></div>
  <div id="elapsed" class="elapsed">Not running</div>
</header>

<div class="summary">
  <div class="stat"><span class="stat-n" id="s-total">0</span><span class="stat-l">Total</span></div>
  <div class="stat running"><span class="stat-n" id="s-running">0</span><span class="stat-l">Running</span></div>
  <div class="stat pass"><span class="stat-n" id="s-pass">0</span><span class="stat-l">Pass</span></div>
  <div class="stat warn"><span class="stat-n" id="s-warn">0</span><span class="stat-l">Warn</span></div>
  <div class="stat fail"><span class="stat-n" id="s-fail">0</span><span class="stat-l">Fail</span></div>
  <div class="progress-outer">
    <div class="progress-bar"><div class="progress-fill" id="progress-fill" style="width:0%"></div></div>
    <div class="progress-label" id="progress-label">0 / 0 apps tested</div>
  </div>
</div>

<div class="controls">
  <button class="btn active" id="mode-quick" onclick="setMode('quick')">Quick (high-priority)</button>
  <button class="btn" id="mode-full" onclick="setMode('full')">Full (${CATALOG.length} apps)</button>
  <div class="mode-sep"></div>
  <div class="node-sel" id="node-sel"></div>
  <div class="mode-sep"></div>
  <button class="btn" id="btn-preflight" onclick="preflight()">Preflight</button>
  <button class="btn primary" id="btn-start" onclick="startRun()">&#9654; Start</button>
  <button class="btn danger" id="btn-stop" onclick="stopRun()" disabled>&#9632; Stop</button>
  <button class="btn" onclick="resetRun()">&#8635; Reset</button>
</div>

<div class="grid-header">
  <h2 id="grid-label">App Catalog</h2>
  <select class="filter-input" id="filter-status" onchange="applyFilters()">
    <option value="">All statuses</option>
    <option value="running">Running</option>
    <option value="pass">Pass</option>
    <option value="warn">Warn</option>
    <option value="fail">Fail</option>
    <option value="error">Error</option>
    <option value="queued">Queued</option>
    <option value="idle">Idle</option>
  </select>
  <input class="filter-input" id="filter-text" placeholder="Search apps..." oninput="applyFilters()" style="margin-left:8px">
</div>
<div class="grid" id="grid"></div>

<div class="drawer" id="drawer">
  <div class="drawer-header">
    <span class="drawer-title" id="drawer-title">App Details</span>
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
  document.getElementById('grid-label').textContent = 'App Catalog (' + catalog.length + ' apps)';
}

function cardHtml(app, s) {
  var status = s ? s.status : 'idle';
  var node = s && s.node ? s.node : '';
  var cats = (s ? s.categories : app.categories || []).slice(0, 2).map(function(c) {
    return '<span class="cat-tag">' + c + '</span>';
  }).join('');
  var phase = s ? (s.message || s.phase || '') : '';
  var meta = '';
  if (s && s.result) {
    var r = s.result;
    var parts = [];
    if (r.startupMs > 0) parts.push(fmtMs(r.startupMs));
    if (r.memMb > 0) parts.push(r.memMb + 'MB');
    if (r.httpStatus) parts.push('HTTP ' + r.httpStatus);
    meta = parts.join(' &middot; ');
  }
  var scoreHtml = '';
  if (status === 'pass') scoreHtml = '<span class="card-score pass">PASS</span>';
  else if (status === 'warn') scoreHtml = '<span class="card-score warn">WARN</span>';
  else if (status === 'fail') scoreHtml = '<span class="card-score fail">FAIL</span>';
  return '<div class="card-status">'
    + '<div class="dot ' + status + '"></div>'
    + '<div class="card-name">' + (s ? s.name : app.name) + '</div>'
    + (node ? '<div class="card-node">' + node + '</div>' : '')
    + '</div>'
    + '<div class="card-cats">' + cats + '</div>'
    + (phase ? '<div class="card-phase">' + phase + '</div>' : '')
    + (meta ? '<div class="card-meta">' + meta + '</div>' : '')
    + scoreHtml;
}

function updateCard(appId) {
  var card = document.getElementById('card-' + appId);
  if (!card) return;
  var s = state.apps[appId];
  if (!s) return;
  var app = state.catalog.find(function(a) { return a.id === appId; }) || { id: appId, name: appId, categories: [] };
  var wasHidden = card.style.display === 'none';
  card.className = 'card ' + s.status;
  card.innerHTML = cardHtml(app, s);
  card.onclick = function() { openDrawer(appId); };
  if (drawerApp === appId) renderDrawer(appId);
  applyFilters();
}

function updateSummary(fleet) {
  var apps = Object.values(state.apps);
  var done = apps.filter(function(a) { return ['pass','warn','fail','error'].includes(a.status); }).length;
  var total = apps.length;
  var running = apps.filter(function(a) { return ['pulling','starting','http','screenshot','benchmark','queued'].includes(a.status); }).length;
  var pass = apps.filter(function(a) { return a.status === 'pass'; }).length;
  var warn = apps.filter(function(a) { return a.status === 'warn'; }).length;
  var fail = apps.filter(function(a) { return ['fail','error'].includes(a.status); }).length;
  document.getElementById('s-total').textContent = total;
  document.getElementById('s-running').textContent = running;
  document.getElementById('s-pass').textContent = pass;
  document.getElementById('s-warn').textContent = warn;
  document.getElementById('s-fail').textContent = fail;
  var pct = total > 0 ? (done / total * 100).toFixed(1) : 0;
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('progress-label').textContent = done + ' / ' + total + ' apps tested';
}

function applyFilters() {
  var statusFilter = document.getElementById('filter-status').value;
  var textFilter = document.getElementById('filter-text').value.toLowerCase();
  var cards = document.querySelectorAll('.card');
  var visible = 0;
  cards.forEach(function(card) {
    var appId = card.id.replace('card-', '');
    var s = state.apps[appId];
    var status = s ? s.status : 'idle';
    var name = (s ? s.name : appId).toLowerCase();
    var cats = (s ? s.categories : []).join(' ').toLowerCase();
    var showStatus = !statusFilter || status === statusFilter
      || (statusFilter === 'running' && ['pulling','starting','http','screenshot','benchmark'].includes(status));
    var showText = !textFilter || name.includes(textFilter) || appId.includes(textFilter) || cats.includes(textFilter);
    card.style.display = (showStatus && showText) ? '' : 'none';
    if (showStatus && showText) visible++;
  });
  document.getElementById('grid-label').textContent = 'App Catalog (' + visible + ' of ' + state.catalog.length + ')';
}

function openDrawer(appId) {
  drawerApp = appId;
  renderDrawer(appId);
  document.getElementById('drawer').classList.add('open');
}

function closeDrawer() {
  drawerApp = null;
  document.getElementById('drawer').classList.remove('open');
}

function renderDrawer(appId) {
  var s = state.apps[appId];
  var app = state.catalog.find(function(a) { return a.id === appId; }) || { id: appId, name: appId };
  document.getElementById('drawer-title').textContent = (s ? s.name : appId);
  var body = document.getElementById('drawer-body');
  var html = '';
  // Screenshot
  var ssFile = (s && s.node ? s.node + '_' : '') + appId + '.png';
  html += '<img class="screenshot-img" src="/screenshots/' + ssFile + '" onerror="this.hidden=true">';
  // Meta grid
  var r = s && s.result ? s.result : {};
  html += '<div class="section-label">Metrics</div>';
  html += '<div class="meta-grid">';
  var metaItems = [
    ['Status', (s && s.status) || 'idle'],
    ['Node', (s && s.node) || '—'],
    ['Startup', fmtMs(r.startupMs)],
    ['Pull', fmtMs(r.pullMs)],
    ['HTTP', r.httpStatus ? 'HTTP ' + r.httpStatus : '—'],
    ['Memory', r.memMb > 0 ? r.memMb + ' MB' : '—'],
    ['Peak RAM', r.memPeakMb > 0 ? r.memPeakMb + ' MB' : '—'],
    ['CPU', r.cpuPct > 0 ? r.cpuPct + '%' : '—'],
    ['Image', r.imageMb > 0 ? r.imageMb + ' MB' : '—'],
  ];
  metaItems.forEach(function(item) {
    html += '<div class="meta-item"><span class="meta-key">' + item[0] + '</span><span class="meta-val">' + item[1] + '</span></div>';
  });
  html += '</div>';
  // Notes
  if (r.notes || (s && s.message)) {
    html += '<div class="section-label" style="margin-top:10px">Notes</div>';
    html += '<div class="log-line" style="background:var(--bg);padding:8px;border-radius:6px;margin-bottom:10px">' + (r.notes || s.message) + '</div>';
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
