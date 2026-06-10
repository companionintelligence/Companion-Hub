#!/usr/bin/env tsx
/**
 * qa-mcp.ts — Layer-1 MCP protocol smoke for CI-Marketplace MCP apps.
 *
 * The HTTP harness (qa-stream.ts) skips MCP servers because they have no web surface — they
 * speak JSON-RPC over stdio. This boots an MCP app's container, performs the MCP handshake
 * (initialize → notifications/initialized → tools/list), asserts the live tool set matches the
 * tools the app declares in `config.json .mcp.manifest.tools`, and OPTIONALLY calls one curated
 * read-only tool to prove tools actually execute (not just advertise). See
 * docs/MCP_TESTING_STRATEGY.md.
 *
 * Used two ways:
 *   • Imported by qa-stream.ts — `qaMcpApp(appId, { emit, phase, containerName, result })` runs the
 *     smoke for one `no_gui` + `.mcp` app and RETURNS the result record (the caller emits app_result).
 *   • Standalone CLI — `APP_STORE_DIR=../CI-Marketplace/apps tsx scripts/qa-mcp.ts <app-id...>`,
 *     or `… qa-mcp.ts --all` to sweep every `.mcp` app discovered in the catalog.
 *
 * Scores with the SAME vocabulary as qa-stream so results flow through the same dashboard/triage:
 *   pass    initialize OK + tools/list non-empty + ⊇ declared manifest tools
 *   warn    handshake OK but tool DRIFT (missing declared tools / empty / renamed), or a curated
 *           read-only probe found the tool broken (method-not-found / internal error)
 *   fail    launched but never completed initialize / JSON-RPC error / crashed mid-handshake
 *   error   infra — image pull/run failed, command not found            (failKind: pull|run)
 *   timeout no handshake response within the deadline                   (failKind: timeout)
 *   skip    needs a real secret to boot · needs host software (Blender, Unity, a TV, …) ·
 *           remote http · not an MCP app
 *
 * Env: QA_MCP_TIMEOUT_MS (default 90000) · QA_MCP_SECRETS_JSON ({"KEY":"value"}) ·
 *      QA_MCP_PROBE (default 1; set 0 to disable the exec probe) · QA_MCP_PROBE_NET (default 0;
 *      set 1 to allow network-touching probes).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_STORE_DIR = process.env.APP_STORE_DIR ?? '../CI-Marketplace/apps';
const TIMEOUT_MS = Number(process.env.QA_MCP_TIMEOUT_MS) || 90_000;
const PROBE_TIMEOUT_MS = Number(process.env.QA_MCP_PROBE_TIMEOUT_MS) || 15_000;
const PROBE_NET = process.env.QA_MCP_PROBE_NET === '1';
const PLACEHOLDER = 'ci-qa-placeholder';

function parseSecrets(): Record<string, string> {
  try {
    return process.env.QA_MCP_SECRETS_JSON ? JSON.parse(process.env.QA_MCP_SECRETS_JSON) : {};
  } catch {
    return {};
  }
}

export type Score = 'pass' | 'warn' | 'fail' | 'error' | 'timeout' | 'skip';
export interface McpEnv {
  key?: string;
  required?: boolean;
  secret?: boolean;
}
export interface McpConfig {
  transport?: string;
  command?: string;
  args?: string[];
  env?: McpEnv[];
  requires?: { host_software?: string[] };
  manifest?: { tools?: { name?: string }[] };
}
export interface ComposeService {
  image?: string;
  command?: string[] | string;
  isMain?: boolean;
}
/** A tool as advertised by the LIVE server (tools/list) — carries inputSchema so the probe can
 *  self-guard against required args the manifest's stripped schema doesn't record. */
interface LiveTool {
  name: string;
  inputSchema?: { required?: string[] };
}

function defaultEmit(o: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(o)}\n`);
}

/**
 * Curated read-only `tools/call` probes — one safe tool per app that proves execution without
 * mutating state, needing creds, or (unless QA_MCP_PROBE_NET) touching the network. The probe
 * self-guards at call time against the LIVE tool's `inputSchema.required`, so an entry whose args
 * don't satisfy the real schema is skipped, never failed. Extend conservatively: offline,
 * read-only, no-credential tools only.
 */
export const SAFE_PROBES: Record<string, { tool: string; args: Record<string, unknown>; net?: boolean }> = {
  // ── offline, read-only, no-credential — run in the default sweep ──
  'filesystem-mcp': { tool: 'list_directory', args: { path: '/qa' } }, // scratch mounted at /qa via ALLOWED_PATH
  'chess-mcp': { tool: 'new_game', args: {} }, // pure in-memory, returns a board
  'brewers-almanack-mcp': { tool: 'search_styles', args: { query: 'IPA' } }, // bundled reference data
  'git-mcp': { tool: 'git_status', args: { repo_path: '/qa' } }, // status of the scratch repo git init'd at boot
  'sqlite-mcp': { tool: 'list_tables', args: {} }, // lists user tables in the freshly-opened db (empty is fine)
  'n8n-mcp': { tool: 'tools_documentation', args: {} }, // bundled node docs, no n8n instance needed
  // ── network-touching execution proofs — only with QA_MCP_PROBE_NET=1 ──
  'fetch-mcp': { tool: 'fetch', args: { url: 'https://example.com/' }, net: true },
  'youtube-transcript-mcp': { tool: 'get_video_info', args: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }, net: true },
  // reddit-mcp deliberately has NO probe: every reddit tool requires Reddit API creds, so the only
  // verdict a no-cred call yields is tool-error — handshake + manifest assertion is its real ceiling.
  'lego-oracle-mcp': { tool: 'browse_themes', args: {}, net: true }, // API-backed catalog
  'smartest-tv-mcp': { tool: 'list_devices', args: {} }, // local discovery (app skips headless anyway)
};

/** A syntactically-valid dummy connection URL keyed by the env name's scheme, so a server that
 *  parses its `*_URL` at startup (e.g. server-postgres does `new URL(POSTGRES_URL)`) gets past the
 *  parse rather than crashing on the bare placeholder. The host is unreachable on purpose — auth/
 *  connection is still only attempted at tools/call, so the handshake validates the build. */
export function dummyUrl(key: string): string {
  if (/POSTGRES|PG_|PGURL/i.test(key)) return 'postgres://qa:qa@127.0.0.1:5432/qa';
  if (/MYSQL|MARIA/i.test(key)) return 'mysql://qa:qa@127.0.0.1:3306/qa';
  if (/MONGO/i.test(key)) return 'mongodb://127.0.0.1:27017/qa';
  if (/REDIS/i.test(key)) return 'redis://127.0.0.1:6379';
  return 'http://qa.invalid';
}

/** Resolve a declared env var: real secret (secrets/env) → that; non-secret path-like → a scratch
 *  dir/file mounted into the container; required URL-like → a valid dummy URL; required secret with
 *  no value → placeholder; else unset. Returns the value plus whether a scratch dir needs mounting. */
export function resolveEnv(e: McpEnv, scratch: string, secrets: Record<string, string>): { value?: string; mount?: string } {
  const k = e.key ?? '';
  const provided = secrets[k] ?? process.env[k];
  if (provided) return { value: provided };
  if (!e.secret && /PATH|DIR|ROOT/i.test(k)) return { value: '/qa', mount: scratch }; // path-like arg
  if (e.required && /URL|URI|DSN|CONNECTION/i.test(k)) return { value: dummyUrl(k) }; // parseable connection string
  if (e.required) return { value: PLACEHOLDER }; // boot it anyway; auth is enforced at tools/call
  return {};
}

/** Build the `docker run -i …` argv for a stdio MCP app from its config + compose. */
export function buildDockerArgs(
  appId: string,
  mcp: McpConfig,
  compose: { services?: ComposeService[] },
  scratch: string,
  secrets: Record<string, string>,
  containerName = `qa-mcp-${appId}`,
): { dockerArgs: string[]; env: Record<string, string>; needsSecret: string | null } {
  const env: Record<string, string> = {};
  const envFlags: string[] = [];
  const mounts: string[] = [];
  let needsSecret: string | null = null;

  for (const e of mcp.env ?? []) {
    if (!e.key) continue;
    const r = resolveEnv(e, scratch, secrets);
    if (r.value === undefined) continue;
    if (e.required && e.secret && r.value === PLACEHOLDER) needsSecret = e.key; // flag — may still boot
    env[e.key] = r.value;
    envFlags.push('-e', `${e.key}=${r.value}`);
    if (r.mount) mounts.push('-v', `${r.mount}:${r.value}`);
  }
  const subst = (s: string) => s.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => env[k] ?? '');

  // `command: "docker"` apps already encode a full `docker run …` invocation — reuse it, just
  // inject our --name and ensure -i/--rm are present. Env values flow via the spawn env, which the
  // manifest's `-e KEY` passthrough flags pick up.
  if (mcp.command === 'docker') {
    const a = (mcp.args ?? []).map(subst);
    const runIdx = a.indexOf('run');
    const head = runIdx >= 0 ? a.slice(0, runIdx + 1) : ['run'];
    const tail = runIdx >= 0 ? a.slice(runIdx + 1) : a;
    const ensure: string[] = [];
    if (!tail.includes('-i')) ensure.push('-i');
    if (!tail.includes('--rm')) ensure.push('--rm');
    return { dockerArgs: [...head, ...ensure, '--name', containerName, ...tail], env, needsSecret };
  }
  // Otherwise wrap the compose main service's image + command in our own `docker run -i`.
  const main = compose.services?.find((s) => s.isMain) ?? compose.services?.[0];
  const image = main?.image ?? 'alpine:3.20';
  const cmd = (Array.isArray(main?.command) ? main?.command : mcp.args ? [mcp.command ?? '', ...mcp.args] : []) ?? [];
  const dockerArgs = ['run', '-i', '--rm', '--name', containerName, ...envFlags, ...mounts, image, ...cmd.map(subst)];
  return { dockerArgs, env, needsSecret };
}

/** Host-software entries the headless fleet satisfies by itself — language runtimes the container
 *  image already ships. Anything else (a running Blender, a Unity editor, a TV on the LAN, …) is
 *  real host software the smoke can never stand up. */
const FLEET_RUNTIMES = ['node', 'npm', 'uv', 'python', 'docker'];

/** The declared `mcp.requires.host_software` entries the fleet CANNOT provide (case-insensitive
 *  substring check against FLEET_RUNTIMES). Non-empty means a boot failure or an empty tool list
 *  is the missing host software talking, not an app bug — score skip, not fail/error/warn. */
export function missingHostSoftware(mcp: McpConfig): string[] {
  return (mcp.requires?.host_software ?? []).filter((entry) => {
    const lower = entry.toLowerCase();
    return !FLEET_RUNTIMES.some((runtime) => lower.includes(runtime));
  });
}

/** Pure scoring of a SUCCESSFUL handshake: assert the live tool set against the declared manifest.
 *  pass = live ⊇ declared (and non-empty); warn = empty or drift (declared tools missing). */
export function scoreHandshake(declared: string[], live: string[]): { score: 'pass' | 'warn'; notes: string } {
  const missing = declared.filter((d) => !live.includes(d));
  if (live.length === 0) {
    return { score: 'warn', notes: 'handshake OK but tools/list is EMPTY (server advertises no tools)' };
  }
  if (declared.length > 0 && missing.length > 0) {
    return {
      score: 'warn',
      notes: `tool drift: ${missing.length}/${declared.length} declared tools missing from live list (${missing.slice(0, 6).join(', ')}${missing.length > 6 ? '…' : ''})`,
    };
  }
  return { score: 'pass', notes: `${live.length} tools advertised${declared.length ? `, ⊇ ${declared.length} declared` : ''}` };
}

interface ProbeResult {
  status: 'ok' | 'invalid-params' | 'tool-error' | 'method-error' | 'internal-error' | 'timeout' | 'skipped';
  detail: string;
}
interface SmokeResult {
  ok: boolean;
  tools: LiveTool[];
  reason: string;
  stderr: string;
  exited: boolean;
  probe?: ProbeResult;
}

/** Drive the MCP smoke over a child's stdio: initialize → notifications/initialized → tools/list →
 *  (optional) one read-only tools/call probe. Newline-delimited JSON-RPC per the stdio transport.
 *  The probe runs in the SAME process after tools/list, under its own short timer, so a hung probe
 *  never costs the (already-captured) handshake verdict. */
function runSmoke(
  dockerArgs: string[],
  env: Record<string, string>,
  probeSpec: { tool: string; args: Record<string, unknown> } | null,
): Promise<SmokeResult> {
  return new Promise((resolve) => {
    const proc = spawn('docker', dockerArgs, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let buf = '';
    let stderr = '';
    let done = false;
    let sawInit = false;
    let exited = false;
    let liveTools: LiveTool[] = [];
    let mainTimer: ReturnType<typeof setTimeout>;
    let probeTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (r: Omit<SmokeResult, 'stderr' | 'exited'>) => {
      if (done) return;
      done = true;
      clearTimeout(mainTimer);
      if (probeTimer) clearTimeout(probeTimer);
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve({ ...r, stderr: stderr.slice(-800), exited });
    };
    const send = (o: Record<string, unknown>) => {
      try {
        proc.stdin.write(`${JSON.stringify(o)}\n`);
      } catch {
        /* pipe closed */
      }
    };

    mainTimer = setTimeout(
      () => finish({ ok: false, tools: [], reason: sawInit ? 'no tools/list before deadline' : 'no initialize response before deadline' }),
      TIMEOUT_MS,
    );

    // Decide whether to probe once tools are known; returns true if a probe was dispatched.
    const maybeProbe = (): boolean => {
      if (!probeSpec) return false;
      const live = liveTools.find((t) => t.name === probeSpec.tool);
      if (!live) return false; // tool not advertised → no probe (drift already scored elsewhere)
      const required = live.inputSchema?.required ?? [];
      const haveArgs = Object.keys(probeSpec.args);
      if (required.some((req) => !haveArgs.includes(req))) return false; // can't satisfy real schema → skip
      clearTimeout(mainTimer);
      probeTimer = setTimeout(
        () =>
          finish({
            ok: true,
            tools: liveTools,
            reason: 'handshake complete',
            probe: { status: 'timeout', detail: `${probeSpec.tool} did not return in ${PROBE_TIMEOUT_MS}ms` },
          }),
        PROBE_TIMEOUT_MS,
      );
      send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: probeSpec.tool, arguments: probeSpec.args } });
      return true;
    };

    const classifyProbe = (msg: Record<string, unknown>): ProbeResult => {
      const err = msg.error as { code?: number; message?: string } | undefined;
      if (err) {
        const detail = `${err.code ?? ''} ${err.message ?? ''}`.trim().slice(0, 160);
        if (err.code === -32602) return { status: 'invalid-params', detail }; // our args wrong, not a tool bug
        if (err.code === -32601) return { status: 'method-error', detail }; // advertised but not found → bug
        if (err.code === -32603) return { status: 'internal-error', detail }; // server threw → bug
        return { status: 'tool-error', detail }; // other protocol error — informational
      }
      const result = (msg.result ?? {}) as { isError?: boolean; content?: unknown };
      if (result.isError === true) {
        const txt = JSON.stringify(result.content ?? '').slice(0, 160);
        return { status: 'tool-error', detail: txt }; // tool-level error (often auth/validation) — informational
      }
      return { status: 'ok', detail: `${probeSpec?.tool} returned a result` };
    };

    proc.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(t);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          if (msg.error) return finish({ ok: false, tools: [], reason: `initialize error: ${JSON.stringify(msg.error).slice(0, 160)}` });
          sawInit = true;
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (msg.id === 2) {
          if (msg.error) return finish({ ok: false, tools: [], reason: `tools/list error: ${JSON.stringify(msg.error).slice(0, 160)}` });
          const result = (msg.result ?? {}) as { tools?: LiveTool[] };
          liveTools = (result.tools ?? []).filter((x): x is LiveTool => Boolean(x?.name));
          if (!maybeProbe()) {
            return finish({
              ok: true,
              tools: liveTools,
              reason: 'handshake complete',
              probe: probeSpec ? { status: 'skipped', detail: 'curated tool absent or args unsatisfiable' } : undefined,
            });
          }
        } else if (msg.id === 3) {
          return finish({ ok: true, tools: liveTools, reason: 'handshake complete', probe: classifyProbe(msg) });
        }
      }
    });
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', (e) => finish({ ok: false, tools: [], reason: `docker spawn failed: ${e.message}` }));
    proc.on('exit', (code) => {
      exited = true;
      if (!sawInit && !done) {
        // exited before responding to initialize → infra (bad image/cmd) or crash
        setTimeout(() => finish({ ok: false, tools: [], reason: `container exited (code ${code}) before initialize` }), 300);
      }
    });

    // Kick off the handshake. Stdin buffers until the server (after any npx/uvx cold-fetch) reads it.
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ci-qa-mcp', version: '1.0' } },
    });
  });
}

export interface QaMcpOptions {
  /** Event sink (app_phase progress). Defaults to NDJSON on stdout. */
  emit?: (o: Record<string, unknown>) => void;
  /** Container name — pass qa-stream's `qa-stream-${appId}` so its watchdog/teardown cover us. */
  containerName?: string;
  /** Seed result (name/port/categories already filled by the caller). Mutated + returned. */
  result?: Record<string, unknown>;
  /** Extra secrets (merged over QA_MCP_SECRETS_JSON). */
  secrets?: Record<string, string>;
  /** Run the read-only tools/call exec probe (default true; QA_MCP_PROBE=0 disables globally). */
  probe?: boolean;
}

/**
 * Run the Layer-1 MCP smoke for one app and RETURN its result record (does NOT emit app_result —
 * the caller owns that channel, so a retry never double-counts). Reads config.json +
 * docker-compose.json itself; tears its container down idempotently in `finally`.
 */
export async function qaMcpApp(appId: string, options: QaMcpOptions = {}): Promise<Record<string, unknown>> {
  const emit = options.emit ?? defaultEmit;
  const containerName = options.containerName ?? `qa-mcp-${appId}`;
  const secrets = { ...parseSecrets(), ...(options.secrets ?? {}) };
  const probeEnabled = (options.probe ?? true) && process.env.QA_MCP_PROBE !== '0';
  const result: Record<string, unknown> = options.result ?? { appId, score: 'fail' as Score, notes: '', ts: Date.now() };
  result.appId = appId;
  result.mcp = true;
  const scratch = join(tmpdir(), `qa-mcp-${appId}`);

  try {
    const cfgPath = join(APP_STORE_DIR, appId, 'config.json');
    if (!existsSync(cfgPath)) {
      result.score = 'error';
      result.failKind = 'config';
      result.notes = `config.json not found at ${cfgPath}`;
      return result;
    }
    const config = JSON.parse(readFileSync(cfgPath, 'utf-8')) as { mcp?: McpConfig; name?: string };
    result.name = result.name ?? config.name ?? appId;
    const mcp = config.mcp;
    if (!mcp) {
      result.score = 'skip';
      result.notes = 'not an MCP app (no .mcp block)';
      return result;
    }
    if (mcp.transport && mcp.transport !== 'stdio') {
      result.score = 'skip';
      result.notes = `transport=${mcp.transport} — remote/non-stdio, Layer-1 smoke covers stdio only`;
      return result;
    }
    const composePath = join(APP_STORE_DIR, appId, 'docker-compose.json');
    const compose = existsSync(composePath) ? (JSON.parse(readFileSync(composePath, 'utf-8')) as { services?: ComposeService[] }) : {};

    mkdirSync(scratch, { recursive: true });
    const { dockerArgs, env, needsSecret } = buildDockerArgs(appId, mcp, compose, scratch, secrets, containerName);
    const declared = (mcp.manifest?.tools ?? []).map((t) => t.name ?? '').filter(Boolean);
    const hostSoftware = missingHostSoftware(mcp);

    const probeSpec = pickProbe(appId);
    emit({
      event: 'app_phase',
      appId,
      phase: 'starting',
      message: `mcp smoke: docker ${dockerArgs.slice(0, 4).join(' ')} … (${declared.length} tools declared${probeEnabled && probeSpec ? `, probe ${probeSpec.tool}` : ''})`,
      ts: Date.now(),
    });

    const hs = await runSmoke(dockerArgs, env, probeEnabled ? probeSpec : null);
    const liveNames = hs.tools.map((t) => t.name);
    result.tools = liveNames;
    result.declaredTools = declared.length;
    if (hs.probe) result.probe = hs.probe.status;

    if (!hs.ok) {
      const err = `${hs.reason} ${hs.stderr}`.toLowerCase();
      // The placeholder echoing back in the boot error means the server VALIDATED the credential
      // at startup (e.g. steam-mcp resolves STEAM_ID against the live Steam API) — needs-secret.
      if (
        needsSecret &&
        (err.includes(PLACEHOLDER) || new RegExp(`${needsSecret.toLowerCase()}|token|unauthorized|api[_ ]?key|credential|required`).test(err))
      ) {
        result.score = 'skip';
        result.notes = `needs-secret: ${needsSecret} required to boot — ${hs.reason}`;
      } else if (hostSoftware.length > 0) {
        // The app declares host software the headless fleet can never provide (a running Blender,
        // a Unity editor, a TV to pair) — the boot failure is that absence, not an app bug.
        result.score = 'skip';
        result.notes = `needs host software: ${hostSoftware.join(', ')} — ${hs.reason}`;
      } else if (/no such image|manifest unknown|not found|pull access denied|error response from daemon/.test(err)) {
        result.score = 'error';
        result.failKind = 'pull';
        result.notes = `image pull/run failed: ${hs.reason}`;
      } else if (/econnrefused|connection refused|could not connect|connection terminated|getaddrinfo|enotfound|:5432|:3306|:27017|:6379/.test(err)) {
        // The server boots only with a live backing service (DB/cache) the no-deps smoke can't
        // provide — not an app bug. Skip, like needs-secret. (Reached once a valid dummy URL gets
        // it past startup parsing into an actual connection attempt.)
        result.score = 'skip';
        result.notes = `needs-connection: requires a live backing service to boot — ${hs.reason}`;
      } else if (/before deadline/.test(hs.reason)) {
        result.score = 'timeout';
        result.failKind = 'timeout';
        result.notes = hs.reason;
      } else {
        result.score = 'fail';
        result.failKind = 'handshake';
        result.notes = `${hs.reason}${hs.stderr ? ` | ${hs.stderr.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`;
      }
      return result;
    }

    // Handshake succeeded but the server advertises NOTHING and declares host software the fleet
    // lacks (e.g. unity-mcp-ivanmurzak lists 0 tools until a Unity editor connects) — skip. A
    // server that boots AND lists tools still scores normally below, so a real pass stays possible.
    if (hostSoftware.length > 0 && liveNames.length === 0) {
      result.score = 'skip';
      result.notes = `needs host software: ${hostSoftware.join(', ')} — handshake OK but tools/list is empty`;
      return result;
    }

    // Handshake succeeded — score the manifest assertion, then fold in the probe verdict.
    const base = scoreHandshake(declared, liveNames);
    result.score = base.score;
    result.notes = base.notes;
    applyProbeVerdict(result, hs.probe, probeSpec);
    return result;
  } catch (err) {
    result.score = 'error';
    result.failKind = 'exception';
    result.notes = err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
    return result;
  } finally {
    // Synchronous teardown so the container is gone before we return (an async rm races process.exit).
    try {
      spawnSync('docker', ['rm', '-f', containerName], { stdio: 'ignore', timeout: 30_000 });
    } catch {
      /* best effort */
    }
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/** The curated probe for an app, honoring the network gate. */
function pickProbe(appId: string): { tool: string; args: Record<string, unknown> } | null {
  const p = SAFE_PROBES[appId];
  if (!p) return null;
  if (p.net && !PROBE_NET) return null;
  return { tool: p.tool, args: p.args };
}

/** Fold the exec-probe outcome into the result. Conservative: only a tool that's advertised yet
 *  broken (method-not-found / internal error) downgrades pass→warn. Wrong-args, auth/tool-level
 *  errors, timeouts, and skips are informational and never downgrade. */
function applyProbeVerdict(result: Record<string, unknown>, probe: ProbeResult | undefined, probeSpec: { tool: string } | null): void {
  if (!probe || !probeSpec) return;
  if (probe.status === 'ok') {
    result.notes = `${result.notes}; probe ${probeSpec.tool}→ok`;
  } else if ((probe.status === 'method-error' || probe.status === 'internal-error') && result.score === 'pass') {
    result.score = 'warn';
    result.notes = `${result.notes}; probe FAILED ${probeSpec.tool}: ${probe.detail}`;
  } else if (probe.status !== 'skipped') {
    result.notes = `${result.notes}; probe ${probeSpec.tool}→${probe.status}`;
  }
}

/** Every app under APP_STORE_DIR whose config.json declares an `.mcp` block, sorted. Powers the
 *  `--all` sweep so re-testing the whole catalog after a marketplace bump is one command, not a
 *  hand-maintained app list that silently misses newly-added MCP servers. */
export function discoverMcpApps(storeDir = APP_STORE_DIR): string[] {
  let entries: string[];
  try {
    entries = readdirSync(storeDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  return entries
    .filter((app) => {
      const cfg = join(storeDir, app, 'config.json');
      if (!existsSync(cfg)) return false;
      try {
        return Boolean((JSON.parse(readFileSync(cfg, 'utf-8')) as { mcp?: unknown }).mcp);
      } catch {
        return false;
      }
    })
    .sort();
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// Guard so importing this module (qa-stream's dynamic import) does NOT run argv parsing.
const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  void (async () => {
    const argv = process.argv.slice(2);
    const appIds = argv.includes('--all') ? discoverMcpApps() : argv;
    if (appIds.length === 0) {
      process.stderr.write(
        argv.includes('--all')
          ? `No MCP apps found under ${APP_STORE_DIR}\n`
          : 'Usage: qa-mcp.ts <app-id> [app-id...]  |  qa-mcp.ts --all  (every .mcp app in the catalog)\n',
      );
      process.exit(1);
    }
    defaultEmit({ event: 'batch_start', apps: appIds, kind: 'mcp', ts: Date.now() });
    let worst = 0;
    const rank: Record<string, number> = { pass: 0, skip: 0, warn: 1, timeout: 2, error: 2, fail: 3 };
    for (const id of appIds) {
      defaultEmit({ event: 'app_start', appId: id, ts: Date.now() });
      const r = await qaMcpApp(id);
      defaultEmit({ event: 'app_result', appId: id, result: r });
      process.stderr.write(`  ${String(r.score).toUpperCase().padEnd(7)} ${id.padEnd(24)} ${r.notes}\n`);
      worst = Math.max(worst, rank[String(r.score)] ?? 0);
    }
    defaultEmit({ event: 'batch_done', total: appIds.length, ts: Date.now() });
    process.exit(worst >= 3 ? 1 : 0);
  })().catch((err) => {
    process.stderr.write(`qa-mcp fatal: ${err?.stack || err}\n`);
    process.exit(1);
  });
}
