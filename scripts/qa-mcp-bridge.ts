#!/usr/bin/env tsx
/**
 * qa-mcp-bridge.ts — Layer-2 MCP regression: drive the REAL Hub MCP bridge end-to-end.
 *
 * Where Layer 1 (qa-mcp.ts) boots an app's own container and smokes its stdio protocol, Layer 2
 * exercises the product path: the Hub backend's MCP server at `/api/mcp` — the exact surface an
 * agent/client reaches tools through. It is the source of truth when Layer 1 and reality disagree.
 *
 * What it asserts (against a RUNNING Hub backend):
 *   1. GET  /api/mcp/sse       → emits `event: endpoint` (the transport discovery channel)
 *   2. POST /api/mcp/messages  initialize  → result.protocolVersion + result.serverInfo, no error
 *   3. POST /api/mcp/messages  tools/list  → a non-empty tool set
 *   4. Namespacing: any bridged app tool is exposed as `<appUrn-with-_>__<tool>` (S-AMB-1.2 /
 *      openapi-bridge buildToolName) — a `__`-containing name must match that shape.
 *
 * Auth: the Hub's McpAuthGuard requires `MCP_API_KEY` set on the SERVER and an
 * `Authorization: Bearer <MCP_API_KEY>` header on every request. Provide the same key here.
 *
 * Scores with the harness vocabulary so it can ride the same NDJSON/dashboard/triage path:
 *   pass  endpoint + initialize + non-empty tools/list + valid namespacing
 *   warn  connected but tools/list empty, or a `__` tool name is malformed
 *   fail  initialize returned a JSON-RPC error / unexpected shape
 *   skip  no Hub reachable, or MCP_API_KEY not provided (can't auth) — never breaks a fleet run
 *   error transport/network fault talking to the Hub
 *
 * NOTE (the marketplace↔bridge gap — see docs/MCP_TESTING_STRATEGY.md): today NO catalog MCP app is
 * reachable through this bridge. The bridge connects via an `agents.mcp` block + `docker exec` into a
 * running container, but the 24 catalog MCP apps declare a top-level `.mcp` block whose server is the
 * container's main process. So tools/list here returns the Hub's OWN tools; bridged-app namespacing
 * is asserted only when such an app is present. Wiring catalog apps through the bridge is future work.
 *
 * Usage:  HUB_URL=http://localhost:3000 MCP_API_KEY=… tsx scripts/qa-mcp-bridge.ts
 * Env:    HUB_URL (default http://localhost:3000) · MCP_API_KEY · QA_BRIDGE_TIMEOUT_MS (default 15000)
 */
const HUB_URL = (process.env.HUB_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const API_KEY = process.env.MCP_API_KEY ?? '';
const TIMEOUT_MS = Number(process.env.QA_BRIDGE_TIMEOUT_MS) || 15_000;
const APP_ID = 'hub-mcp-bridge';

type Score = 'pass' | 'warn' | 'fail' | 'error' | 'timeout' | 'skip';

function emit(o: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(o)}\n`);
}

function authHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` };
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

/** Open the SSE channel just long enough to read the `event: endpoint` line, then abort. Best-effort
 *  — a missing endpoint event downgrades to warn, it does not fail the run. */
async function readSseEndpoint(): Promise<{ ok: boolean; endpoint?: string; detail: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(TIMEOUT_MS, 8000));
  try {
    const res = await fetch(`${HUB_URL}/api/mcp/sse`, { headers: authHeaders(), signal: ctrl.signal });
    if (!res.ok || !res.body) return { ok: false, detail: `sse HTTP ${res.status}` };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (let i = 0; i < 20; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const m = buf.match(/event:\s*endpoint\s*\ndata:\s*(\S+)/);
      if (m) {
        ctrl.abort();
        return { ok: true, endpoint: m[1], detail: 'endpoint event received' };
      }
    }
    return { ok: false, detail: 'no endpoint event in the first SSE chunks' };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

async function rpc(method: string, params: Record<string, unknown>, id: number): Promise<Record<string, unknown>> {
  const res = await fetchT(`${HUB_URL}/api/mcp/messages`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (!res.ok) throw Object.assign(new Error(`messages HTTP ${res.status}`), { httpStatus: res.status });
  return (await res.json()) as Record<string, unknown>;
}

/** A `__`-containing tool name must be a bridged app tool: `<storeSlug>_<appName>__<tool>`. */
function namespacingOk(toolNames: string[]): { ok: boolean; bad: string[] } {
  const bridged = toolNames.filter((n) => n.includes('__'));
  const bad = bridged.filter((n) => !/^[a-z0-9-]+_[a-z0-9-]+__.+$/i.test(n));
  return { ok: bad.length === 0, bad };
}

async function run(): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = { appId: APP_ID, name: 'Hub MCP Bridge', score: 'fail' as Score, notes: '', mcp: true, ts: Date.now() };

  // Reachability probe first — a down Hub is a clean skip, not a failure of the regression.
  try {
    await fetchT(`${HUB_URL}/api/mcp/messages`, { method: 'OPTIONS', headers: { 'Content-Type': 'application/json' } }, 4000);
  } catch (e) {
    result.score = 'skip';
    result.notes = `no Hub reachable at ${HUB_URL} (${e instanceof Error ? e.message : String(e)}) — start it with \`pnpm dev\` to run Layer 2`;
    return result;
  }
  if (!API_KEY) {
    result.score = 'skip';
    result.notes = 'MCP_API_KEY not set — the Hub bridge is auth-gated (Bearer); provide the server key to run Layer 2';
    return result;
  }

  try {
    emit({ event: 'app_phase', appId: APP_ID, phase: 'sse', message: `GET ${HUB_URL}/api/mcp/sse`, ts: Date.now() });
    const sse = await readSseEndpoint();
    result.sseEndpoint = sse.ok ? sse.endpoint : null;

    emit({ event: 'app_phase', appId: APP_ID, phase: 'initialize', message: 'POST /api/mcp/messages initialize', ts: Date.now() });
    const init = await rpc(
      'initialize',
      { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ci-qa-mcp-bridge', version: '1.0' } },
      1,
    );
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

    emit({ event: 'app_phase', appId: APP_ID, phase: 'tools/list', message: 'POST /api/mcp/messages tools/list', ts: Date.now() });
    const list = await rpc('tools/list', {}, 2);
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

    if (names.length === 0) {
      result.score = 'warn';
      result.notes = 'bridge connected + initialize OK, but tools/list is EMPTY';
    } else if (ns.ok) {
      result.score = 'pass';
      result.notes = `bridge OK — ${names.length} tools${bridged ? `, ${bridged} bridged (<appUrn>__<tool>)` : ' (Hub-native; no catalog app bridged — see gap)'}${sse.ok ? '; sse endpoint OK' : '; no sse endpoint'}`;
    } else {
      result.score = 'warn';
      result.notes = `tools/list OK (${names.length} tools) but malformed bridged-tool names: ${ns.bad.slice(0, 4).join(', ')}`;
    }
    if (!sse.ok && result.score === 'pass') {
      result.score = 'warn';
      result.notes = `${result.notes} | sse: ${sse.detail}`;
    }
    return result;
  } catch (e) {
    const httpStatus = (e as { httpStatus?: number }).httpStatus;
    if (httpStatus === 401) {
      result.score = 'skip';
      result.notes = 'Hub returned 401 — MCP_API_KEY does not match the server key (or server MCP_API_KEY unset)';
      return result;
    }
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
