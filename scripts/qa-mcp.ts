#!/usr/bin/env tsx
/**
 * qa-mcp.ts — Layer-1 MCP protocol smoke for CI-Marketplace MCP apps.
 *
 * The HTTP harness (qa-stream.ts) skips MCP servers because they have no web surface — they
 * speak JSON-RPC over stdio. This boots an MCP app's container, performs the MCP handshake
 * (initialize → notifications/initialized → tools/list), and asserts the live tool set matches
 * the tools the app declares in `config.json .mcp.manifest.tools`. See docs/MCP_TESTING_STRATEGY.md.
 *
 * Scores with the SAME vocabulary as qa-stream so results flow through the same dashboard/triage:
 *   pass    initialize OK + tools/list non-empty + ⊇ declared manifest tools
 *   warn    handshake OK but tool DRIFT (missing declared tools / empty / renamed)
 *   fail    launched but never completed initialize / JSON-RPC error / crashed mid-handshake
 *   error   infra — image pull/run failed, command not found            (failKind: pull|run)
 *   timeout no handshake response within the deadline                   (failKind: timeout)
 *   skip    needs a real secret to boot · remote http · not an MCP app
 *
 * Usage:  APP_STORE_DIR=../CI-Marketplace/apps tsx scripts/qa-mcp.ts <app-id> [app-id...]
 * Env:    QA_MCP_TIMEOUT_MS (default 90000) · QA_MCP_SECRETS_JSON ({"KEY":"value"})
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const APP_STORE_DIR = process.env.APP_STORE_DIR ?? '../CI-Marketplace/apps';
const TIMEOUT_MS = Number(process.env.QA_MCP_TIMEOUT_MS) || 90_000;
const SECRETS: Record<string, string> = (() => {
  try {
    return process.env.QA_MCP_SECRETS_JSON ? JSON.parse(process.env.QA_MCP_SECRETS_JSON) : {};
  } catch {
    return {};
  }
})();
const PLACEHOLDER = 'ci-qa-placeholder';

type Score = 'pass' | 'warn' | 'fail' | 'error' | 'timeout' | 'skip';
interface McpEnv {
  key?: string;
  required?: boolean;
  secret?: boolean;
}
interface McpConfig {
  transport?: string;
  command?: string;
  args?: string[];
  env?: McpEnv[];
  manifest?: { tools?: { name?: string }[] };
}

function emit(o: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(o)}\n`);
}

/** Resolve a declared env var: real secret (env/QA_MCP_SECRETS_JSON) → that; non-secret path → a
 *  scratch dir/file; required secret with no value → placeholder; otherwise unset. Returns the
 *  value plus whether a scratch dir needs mounting into the container at that path. */
function resolveEnv(e: McpEnv, scratch: string): { value?: string; mount?: string } {
  const k = e.key ?? '';
  const provided = SECRETS[k] ?? process.env[k];
  if (provided) return { value: provided };
  if (!e.secret && /PATH|DIR|ROOT/i.test(k)) return { value: '/qa', mount: scratch }; // path-like arg
  if (e.required) return { value: PLACEHOLDER }; // boot it anyway; auth is enforced at tools/call
  return {};
}

/** Build the `docker run -i …` argv for a stdio MCP app from its config + compose. */
function buildDockerArgs(
  appId: string,
  mcp: McpConfig,
  compose: { services?: { image?: string; command?: string[] | string; isMain?: boolean }[] },
  scratch: string,
): { dockerArgs: string[]; env: Record<string, string>; needsSecret: string | null } {
  const name = `qa-mcp-${appId}`;
  const env: Record<string, string> = {};
  const envFlags: string[] = [];
  const mounts: string[] = [];
  let needsSecret: string | null = null;

  for (const e of mcp.env ?? []) {
    if (!e.key) continue;
    const r = resolveEnv(e, scratch);
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
    return { dockerArgs: [...head, ...ensure, '--name', name, ...tail], env, needsSecret };
  }
  // Otherwise wrap the compose main service's image + command in our own `docker run -i`.
  const main = compose.services?.find((s) => s.isMain) ?? compose.services?.[0];
  const image = main?.image ?? 'alpine:3.20';
  const cmd = (Array.isArray(main?.command) ? main?.command : mcp.args ? [mcp.command ?? '', ...mcp.args] : []) ?? [];
  const dockerArgs = ['run', '-i', '--rm', '--name', name, ...envFlags, ...mounts, image, ...cmd.map(subst)];
  return { dockerArgs, env, needsSecret };
}

/** Perform the MCP handshake over a child's stdio. Resolves with the live tool names, or rejects
 *  via the returned status. Sequential per spec: initialize → (on ack) initialized + tools/list. */
function handshake(
  dockerArgs: string[],
  env: Record<string, string>,
): Promise<{ ok: boolean; tools: string[]; reason: string; serverInfo?: unknown; stderr: string; exited: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn('docker', dockerArgs, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let buf = '';
    let stderr = '';
    let done = false;
    let sawInit = false;
    let exited = false;
    const finish = (r: { ok: boolean; tools: string[]; reason: string; serverInfo?: unknown }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
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

    const timer = setTimeout(
      () => finish({ ok: false, tools: [], reason: sawInit ? 'no tools/list before deadline' : 'no initialize response before deadline' }),
      TIMEOUT_MS,
    );

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
          const result = (msg.result ?? {}) as { tools?: { name?: string }[] };
          if (msg.error) return finish({ ok: false, tools: [], reason: `tools/list error: ${JSON.stringify(msg.error).slice(0, 160)}` });
          const tools = (result.tools ?? []).map((x) => x.name ?? '').filter(Boolean);
          return finish({ ok: true, tools, reason: 'handshake complete' });
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

async function qaMcp(appId: string) {
  const result: Record<string, unknown> = { appId, score: 'fail' as Score, notes: '', ts: Date.now() };
  emit({ event: 'app_start', appId, ts: Date.now() });
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
    result.name = config.name ?? appId;
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
    const compose = existsSync(composePath) ? JSON.parse(readFileSync(composePath, 'utf-8')) : {};

    mkdirSync(scratch, { recursive: true });
    const { dockerArgs, env, needsSecret } = buildDockerArgs(appId, mcp, compose, scratch);
    const declared = (mcp.manifest?.tools ?? []).map((t) => t.name ?? '').filter(Boolean);

    emit({
      event: 'app_phase',
      appId,
      phase: 'starting',
      message: `docker ${dockerArgs.slice(0, 4).join(' ')} … (${declared.length} tools declared)`,
      ts: Date.now(),
    });
    const hs = await handshake(dockerArgs, env);
    result.tools = hs.tools;
    result.declaredTools = declared.length;

    if (!hs.ok) {
      const err = `${hs.reason} ${hs.stderr}`.toLowerCase();
      // Server refused to boot citing the required secret → skip(needs-secret), not a fail.
      if (needsSecret && new RegExp(`${needsSecret.toLowerCase()}|token|unauthorized|api[_ ]?key|credential|required`).test(err)) {
        result.score = 'skip';
        result.notes = `needs-secret: ${needsSecret} required to boot — ${hs.reason}`;
      } else if (/no such image|manifest unknown|not found|pull access denied|error response from daemon/.test(err)) {
        result.score = 'error';
        result.failKind = 'pull';
        result.notes = `image pull/run failed: ${hs.reason}`;
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

    // Handshake succeeded — assert the live tool set against the declared manifest.
    const missing = declared.filter((d) => !hs.tools.includes(d));
    if (hs.tools.length === 0) {
      result.score = 'warn';
      result.notes = 'handshake OK but tools/list is EMPTY (server advertises no tools)';
    } else if (declared.length > 0 && missing.length > 0) {
      result.score = 'warn';
      result.notes = `tool drift: ${missing.length}/${declared.length} declared tools missing from live list (${missing.slice(0, 6).join(', ')}${missing.length > 6 ? '…' : ''})`;
    } else {
      result.score = 'pass';
      result.notes = `${hs.tools.length} tools advertised${declared.length ? `, ⊇ ${declared.length} declared` : ''}`;
    }
    return result;
  } catch (err) {
    result.score = 'error';
    result.failKind = 'exception';
    result.notes = err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
    return result;
  } finally {
    // Synchronous teardown so the container is gone before we return (an async rm races process.exit).
    try {
      spawnSync('docker', ['rm', '-f', `qa-mcp-${appId}`], { stdio: 'ignore', timeout: 30_000 });
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

void (async () => {
  const appIds = process.argv.slice(2);
  if (appIds.length === 0) {
    process.stderr.write('Usage: qa-mcp.ts <app-id> [app-id...]\n');
    process.exit(1);
  }
  emit({ event: 'batch_start', apps: appIds, kind: 'mcp', ts: Date.now() });
  let worst = 0;
  const rank: Record<string, number> = { pass: 0, skip: 0, warn: 1, timeout: 2, error: 2, fail: 3 };
  for (const id of appIds) {
    const r = await qaMcp(id);
    emit({ event: 'app_result', appId: id, result: r });
    process.stderr.write(`  ${String(r.score).toUpperCase().padEnd(7)} ${id.padEnd(24)} ${r.notes}\n`);
    worst = Math.max(worst, rank[String(r.score)] ?? 0);
  }
  emit({ event: 'batch_done', total: appIds.length, ts: Date.now() });
  process.exit(worst >= 3 ? 1 : 0);
})().catch((err) => {
  process.stderr.write(`qa-mcp fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
