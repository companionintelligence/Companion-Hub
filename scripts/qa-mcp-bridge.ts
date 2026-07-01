#!/usr/bin/env tsx
/**
 * qa-mcp-bridge.ts — Layer-2 MCP regression: drive the REAL Hub MCP endpoint end-to-end.
 *
 * Where Layer 1 (qa-mcp.ts) boots an app's own container and smokes its stdio protocol, Layer 2
 * exercises the product path: the Hub backend's MCP server at `/api/mcp` — the exact surface an
 * agent/client reaches tools through. It is the source of truth when Layer 1 and reality disagree.
 *
 * BUG-MCP-1: the Hub now speaks the spec's **Streamable HTTP** transport (single `/api/mcp`
 * endpoint, `Mcp-Session-Id` header issued at initialize, responses as `application/json` or an SSE
 * `text/event-stream`). This script speaks that transport with fetch only (no SDK dep, so it still
 * ships to fleet nodes unchanged).
 *
 * What it asserts (against a RUNNING Hub backend):
 *   1. POST /api/mcp initialize → result.protocolVersion + result.serverInfo, and an Mcp-Session-Id header
 *   2. POST /api/mcp tools/list (with the session header) → a non-empty tool set
 *   3. Namespacing: any bridged app tool is exposed as `<appName>_<storeSlug>__<tool>` — a
 *      `__`-containing name must match that shape.
 *
 * Auth: the Hub's McpAuthGuard requires `MCP_API_KEY` on the SERVER and an
 * `Authorization: Bearer <MCP_API_KEY>` header on every request. Provide the same key here.
 *
 * Scores with the harness vocabulary so it can ride the same NDJSON/dashboard/triage path:
 *   pass  initialize + session id + non-empty tools/list + valid namespacing
 *   warn  connected but tools/list empty, or a `__` tool name is malformed
 *   fail  initialize returned a JSON-RPC error / unexpected shape / no session id
 *   skip  no Hub reachable, or MCP_API_KEY not provided (can't auth) — never breaks a fleet run
 *   error transport/network fault talking to the Hub
 *
 * NOTE (the marketplace↔bridge gap — see docs/MCP_TESTING_STRATEGY.md): today NO catalog MCP app is
 * reachable through the Hub bridge, so tools/list here returns the Hub's OWN tools; bridged-app
 * namespacing is asserted only when such an app is present. Wiring catalog apps is future work (GAP-MCP-5).
 *
 * Usage:  HUB_URL=http://localhost:5002 MCP_API_KEY=… tsx scripts/qa-mcp-bridge.ts
 * Env:    HUB_URL (default http://localhost:5002) · MCP_API_KEY · QA_BRIDGE_TIMEOUT_MS (default 15000)
 */
const HUB_URL = (process.env.HUB_URL ?? 'http://localhost:5002').replace(/\/$/, '');
const MCP_ENDPOINT = `${HUB_URL}/api/mcp`;
const API_KEY = process.env.MCP_API_KEY ?? '';
const TIMEOUT_MS = Number(process.env.QA_BRIDGE_TIMEOUT_MS) || 15_000;
const APP_ID = 'hub-mcp-bridge';

type Score = 'pass' | 'warn' | 'fail' | 'error' | 'timeout' | 'skip';

function emit(o: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(o)}\n`);
}

/** Streamable HTTP requires the client to accept both a JSON and an SSE response to a POST. */
function rpcHeaders(sessionId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${API_KEY}`,
  };
  if (sessionId) {
    headers['mcp-session-id'] = sessionId;
  }
  return headers;
}

/** Fetch with a hard timeout via AbortController (never hang the regression). */
async function fetchT(url: string, init: RequestInit, timeoutMs = TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Extract the JSON-RPC payload from a Streamable HTTP response — either a plain JSON body or the
 *  last `data:` line of an SSE stream. */
async function readRpcBody(res: Response): Promise<Record<string, unknown>> {
  const contentType = res.headers.get('content-type') ?? '';
  const text = await res.text();
  if (contentType.includes('application/json')) {
    return JSON.parse(text) as Record<string, unknown>;
  }
  // SSE: concatenate `data:` lines and parse the last complete JSON object.
  const dataLines = text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter(Boolean);
  for (let i = dataLines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(dataLines[i] as string) as Record<string, unknown>;
    } catch {
      // keep scanning earlier data lines
    }
  }
  throw new Error(`no JSON-RPC payload in response (content-type ${contentType})`);
}

/** A `__`-containing tool name must be a bridged app tool: `<appName>_<storeSlug>__<tool>`. */
function namespacingOk(toolNames: string[]): { ok: boolean; bad: string[] } {
  const bridged = toolNames.filter((n) => n.includes('__'));
  const bad = bridged.filter((n) => !/^[a-z0-9-]+_[a-z0-9-]+__.+$/i.test(n));
  return { ok: bad.length === 0, bad };
}

async function run(): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = { appId: APP_ID, name: 'Hub MCP Bridge', score: 'fail' as Score, notes: '', mcp: true };

  // Reachability probe first — a down Hub is a clean skip, not a failure of the regression.
  try {
    await fetchT(MCP_ENDPOINT, { method: 'OPTIONS', headers: { 'Content-Type': 'application/json' } }, 4000);
  } catch (e) {
    result.score = 'skip';
    result.notes = `no Hub reachable at ${HUB_URL} (${e instanceof Error ? e.message : String(e)}) — start it with \`pnpm dev\` to run Layer 2`;
    return result;
  }
  if (!API_KEY) {
    result.score = 'skip';
    result.notes = 'MCP_API_KEY not set — the Hub endpoint is auth-gated (Bearer); provide the server key to run Layer 2';
    return result;
  }

  try {
    emit({ event: 'app_phase', appId: APP_ID, phase: 'initialize', message: `POST ${MCP_ENDPOINT} initialize`, ts: Date.now() });
    const initRes = await fetchT(MCP_ENDPOINT, {
      method: 'POST',
      headers: rpcHeaders(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'ci-qa-mcp-bridge', version: '1.0' } },
      }),
    });
    if (initRes.status === 401) {
      result.score = 'skip';
      result.notes = 'Hub returned 401 — MCP_API_KEY does not match the server key (or server MCP_API_KEY unset)';
      return result;
    }
    const sessionId = initRes.headers.get('mcp-session-id') ?? undefined;
    const init = await readRpcBody(initRes);
    if (init.error) {
      result.score = 'fail';
      result.notes = `initialize error: ${JSON.stringify(init.error).slice(0, 160)}`;
      return result;
    }
    const initResult = (init.result ?? {}) as { protocolVersion?: string; serverInfo?: unknown };
    if (!initResult.protocolVersion || !initResult.serverInfo) {
      result.score = 'fail';
      result.notes = `initialize result missing protocolVersion/serverInfo: ${JSON.stringify(initResult).slice(0, 160)}`;
      return result;
    }
    if (!sessionId) {
      result.score = 'fail';
      result.notes = 'initialize did not return an Mcp-Session-Id header (Streamable HTTP session not established)';
      return result;
    }
    result.protocolVersion = initResult.protocolVersion;

    emit({ event: 'app_phase', appId: APP_ID, phase: 'tools/list', message: 'POST /api/mcp tools/list', ts: Date.now() });
    const listRes = await fetchT(MCP_ENDPOINT, {
      method: 'POST',
      headers: rpcHeaders(sessionId),
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    // Handle non-OK HTTP before parsing: McpAuthGuard returns a Nest error body (not a JSON-RPC
    // envelope), which readRpcBody would otherwise parse into an object with no `error`/`result` and
    // mis-score as an EMPTY tool list (warn). A 401 here is an auth mismatch (skip), like initialize.
    if (listRes.status === 401) {
      result.score = 'skip';
      result.notes = 'Hub returned 401 on tools/list — MCP_API_KEY does not match the server key';
      return result;
    }
    if (!listRes.ok) {
      result.score = 'fail';
      result.notes = `tools/list HTTP ${listRes.status} ${listRes.statusText}`.trim();
      return result;
    }
    const list = await readRpcBody(listRes);
    if (list.error) {
      result.score = 'fail';
      result.notes = `tools/list error: ${JSON.stringify(list.error).slice(0, 160)}`;
      return result;
    }
    const tools = ((list.result ?? {}) as { tools?: { name?: string }[] }).tools ?? [];
    const names = tools.map((t) => t.name ?? '').filter(Boolean);
    result.toolCount = names.length;
    const ns = namespacingOk(names);
    const bridged = names.filter((n) => n.includes('__')).length;

    // Best-effort session teardown so we don't leak a session on the server.
    await fetchT(MCP_ENDPOINT, { method: 'DELETE', headers: rpcHeaders(sessionId) }, 4000).catch(() => undefined);

    if (names.length === 0) {
      result.score = 'warn';
      result.notes = 'endpoint connected + initialize OK, but tools/list is EMPTY';
    } else if (ns.ok) {
      result.score = 'pass';
      result.notes = `bridge OK — ${names.length} tools (protocol ${initResult.protocolVersion})${bridged ? `, ${bridged} bridged (<appName>_<storeSlug>__<tool>)` : ' (Hub-native; no catalog app bridged — see gap)'}`;
    } else {
      result.score = 'warn';
      result.notes = `tools/list OK (${names.length} tools) but malformed bridged-tool names: ${ns.bad.slice(0, 4).join(', ')}`;
    }
    return result;
  } catch (e) {
    result.score = 'error';
    result.failKind = 'transport';
    result.notes = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
    return result;
  }
}

void (async () => {
  emit({ event: 'batch_start', apps: [APP_ID], kind: 'mcp-bridge', ts: Date.now() });
  emit({ event: 'app_start', appId: APP_ID, ts: Date.now() });
  const r = await run();
  emit({ event: 'app_result', appId: APP_ID, result: r });
  process.stderr.write(`  ${String(r.score).toUpperCase().padEnd(7)} ${APP_ID.padEnd(24)} ${r.notes}\n`);
  emit({ event: 'batch_done', total: 1, ts: Date.now() });
  process.exit(r.score === 'fail' ? 1 : 0);
})().catch((err) => {
  process.stderr.write(`qa-mcp-bridge fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
