#!/usr/bin/env tsx
/**
 * `fleet-router` — prompt every inference node on the tailnet from one CLI.
 *
 * Stands in for the Hub's own pool proxy (`packages/backend/src/modules/hub-pool/`) on a machine that
 * has no Docker: that proxy is a NestJS service needing Postgres and RabbitMQ, so it cannot be run
 * from source. The *routing* it implements is pure logic, so this file mirrors it deliberately —
 * one ranked candidate list, the same local-affinity head start, the same neutral-when-stale load
 * penalty, the same failover classes — against live tailnet nodes instead of paired `hub_pool_peer`
 * rows. Where a value has no tailnet equivalent (a peer's self-reported hardware tier, which only
 * arrives over an authenticated `/capabilities` poll) the difference is called out at the constant
 * rather than papered over.
 *
 * This is a test harness, not a second implementation to maintain: when the Hub can run here, the
 * same prompts should route the same way through `cihub pool`, and any divergence is the finding.
 *
 * Usage:
 *   pnpm exec tsx scripts/fleet-router.ts discover
 *   pnpm exec tsx scripts/fleet-router.ts prompt "why is the sky blue?" [--model M] [--json]
 *   pnpm exec tsx scripts/fleet-router.ts route   "why is the sky blue?" [--model M]
 *   pnpm exec tsx scripts/fleet-router.ts serve   [--port 5099]
 */
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';

/** Ollama's port on every fleet node. The Hub reaches its own engines the same way. */
const OLLAMA_PORT = 11434;
/** Hub API port — `API_PORT` in a node's env file, 5002 on every appliance in this tailnet. */
const HUB_API_PORT = 5002;

/**
 * Queued-request head start the local node gets over a remote one, mirroring `poolLocalAffinity`
 * (`DEFAULT_POOL_LOCAL_AFFINITY` = 1). A follow-up turn served here reuses the prompt prefix and KV
 * cache the previous turn left resident; the same turn sent to a peer re-processes it cold.
 */
const LOCAL_AFFINITY = Number(process.env.FLEET_LOCAL_AFFINITY ?? 1);
/**
 * Load assumed for a node whose load probe failed — deliberately not 0, matching the Hub's
 * `UNKNOWN_PEER_LOAD`. An unmeasured node must never be mistaken for an idle one.
 */
const UNKNOWN_LOAD = 1;
/**
 * Whole-request budget for a routed request. This is where the harness genuinely differs from the
 * Hub: its `CONNECT_TIMEOUT_MS` is a *header-wait* timeout, cleared the moment the upstream responds,
 * so it never caps how long a streamed generation may run. `fetch` here awaits the full body, so one
 * budget covers both — generous by default, and the reason a slow node reads as slow rather than dead.
 */
const REQUEST_TIMEOUT_MS = Number(process.env.FLEET_PROMPT_TIMEOUT_MS ?? 120_000);
/** Budget for the cheap read-only probes that build the candidate list. */
const PROBE_TIMEOUT_MS = 4_000;
/** 4xx that describes the hop rather than the request, so it is retryable elsewhere. Mirrors `TRANSPORT_4XX`. */
const TRANSPORT_4XX = new Set([408, 429]);
/** How many nodes to probe at once during discovery. The tailnet here is ~58 devices. */
const PROBE_CONCURRENCY = 16;

export interface FleetNode {
  name: string;
  ip: string;
  os: string;
  online: boolean;
  isSelf: boolean;
  /** Populated when the node answers `GET /api/tags` — the models it holds on disk. */
  models: string[];
  /** Models currently resident in VRAM (`GET /api/ps`), the closest thing Ollama gives to a queue depth. */
  running: number;
  /** null when the load probe itself failed, which ranks as {@link UNKNOWN_LOAD} rather than idle. */
  loadKnown: boolean;
  /** `GET /api/health` on the Hub API answered 200. */
  hubReachable: boolean;
  /** The Hub build on this node carries `/api/inference/pool/identify`, i.e. it can join a pool at all. */
  poolCapable: boolean;
}

/** A node that holds the requested model, plus the key it was ranked on. Mirrors `RankedCandidate`. */
interface RankedNode {
  node: FleetNode;
  /** Queue depth, already carrying the local-affinity handicap for remote nodes. Lower is better. */
  score: number;
}

// --- discovery ---------------------------------------------------------------

/** `fetch` with a deadline, returning null on any failure — every probe here is best-effort by design. */
async function probe(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<Response | null> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return null;
  }
}

/**
 * Every device the local tailscaled knows about. Read from `tailscale status --json` rather than the
 * Tailscale Admin API on purpose: the Hub's own discovery needs `TAILSCALE_OAUTH_CLIENT_ID`/`SECRET`
 * for the Admin API, and this harness must work on a node that has no such credential.
 */
export function listTailnetDevices(): Array<{ name: string; ip: string; os: string; online: boolean; isSelf: boolean }> {
  const raw = execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const status = JSON.parse(raw) as {
    Self: { DNSName: string; TailscaleIPs: string[]; OS: string };
    Peer: Record<string, { DNSName: string; TailscaleIPs: string[]; OS: string; Online: boolean }>;
  };
  const shortName = (dns: string) => dns.replace(/\.$/, '').split('.')[0];
  const devices = [{ name: shortName(status.Self.DNSName), ip: status.Self.TailscaleIPs[0], os: status.Self.OS, online: true, isSelf: true }];
  for (const peer of Object.values(status.Peer ?? {})) {
    devices.push({ name: shortName(peer.DNSName), ip: peer.TailscaleIPs?.[0] ?? '', os: peer.OS, online: peer.Online, isSelf: false });
  }
  return devices.filter((d) => d.ip);
}

/** Classify one device: which models it holds, how loaded it is, and whether a Hub answers on it. */
async function inspectNode(device: { name: string; ip: string; os: string; online: boolean; isSelf: boolean }): Promise<FleetNode> {
  const node: FleetNode = { ...device, models: [], running: 0, loadKnown: false, hubReachable: false, poolCapable: false };
  if (!device.online) return node;

  const [tags, ps, health, identify] = await Promise.all([
    probe(`http://${device.ip}:${OLLAMA_PORT}/api/tags`),
    probe(`http://${device.ip}:${OLLAMA_PORT}/api/ps`),
    probe(`http://${device.ip}:${HUB_API_PORT}/api/health`),
    probe(`http://${device.ip}:${HUB_API_PORT}/api/inference/pool/identify`),
  ]);

  if (tags?.ok) {
    const body = (await tags.json().catch(() => null)) as { models?: Array<{ name: string }> } | null;
    node.models = (body?.models ?? []).map((m) => m.name);
  }
  if (ps?.ok) {
    const body = (await ps.json().catch(() => null)) as { models?: unknown[] } | null;
    node.running = body?.models?.length ?? 0;
    node.loadKnown = true;
  }
  node.hubReachable = health?.ok === true;
  if (identify?.ok) {
    const body = (await identify.json().catch(() => null)) as { isCiHub?: boolean } | null;
    node.poolCapable = body?.isCiHub === true;
  }
  return node;
}

/** Probe the whole tailnet, bounded concurrency, best-effort. */
export async function discoverFleet(): Promise<FleetNode[]> {
  const devices = listTailnetDevices();
  const results: FleetNode[] = [];
  for (let i = 0; i < devices.length; i += PROBE_CONCURRENCY) {
    results.push(...(await Promise.all(devices.slice(i, i + PROBE_CONCURRENCY).map(inspectNode))));
  }
  return results.sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || a.name.localeCompare(b.name));
}

// --- ranking (mirrors PoolProxyService.buildCandidateList) --------------------

/**
 * Every node that can serve `model`, best first — local and remote in ONE list, exactly as the Hub
 * ranks them. Concatenating instead (all local, then all remote) would make this a failover list
 * rather than a balancer, which is the bug the Hub's own comment calls out.
 */
export function rankCandidates(nodes: FleetNode[], model: string): RankedNode[] {
  const ranked: RankedNode[] = [];
  for (const node of nodes) {
    if (!node.models.includes(model)) continue;
    const load = node.loadKnown ? node.running : UNKNOWN_LOAD;
    ranked.push({ node, score: node.isSelf ? load : load + LOCAL_AFFINITY });
  }
  // Stable sort: nodes tying on score keep discovery order (self first, then alphabetical).
  return ranked.sort((a, b) => a.score - b.score);
}

/** Nodes holding any model at all — the fan-out set for `prompt`. */
export function inferenceNodes(nodes: FleetNode[]): FleetNode[] {
  return nodes.filter((n) => n.models.length > 0);
}

/** Should a failed attempt move to the next candidate, or is the request itself wrong? Mirrors the Hub's rule. */
function isRetryable(status: number | null): boolean {
  if (status === null) return true; // connection error or timeout
  return status >= 500 || TRANSPORT_4XX.has(status);
}

// --- prompting ---------------------------------------------------------------

export interface PromptResult {
  node: string;
  ip: string;
  model: string;
  ok: boolean;
  status: number | null;
  ms: number;
  response: string;
  error?: string;
}

/** One non-streaming chat completion against one node, over Ollama's OpenAI-compatible surface. */
async function promptNode(node: FleetNode, model: string, prompt: string): Promise<PromptResult> {
  const startedAt = Date.now();
  const base: PromptResult = { node: node.name, ip: node.ip, model, ok: false, status: null, ms: 0, response: '' };
  try {
    const res = await fetch(`http://${node.ip}:${OLLAMA_PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    base.status = res.status;
    base.ms = Date.now() - startedAt;
    if (!res.ok) {
      base.error = (await res.text().catch(() => '')).slice(0, 200);
      return base;
    }
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    base.ok = true;
    base.response = body.choices?.[0]?.message?.content?.trim() ?? '';
    return base;
  } catch (error) {
    base.ms = Date.now() - startedAt;
    base.error = error instanceof Error ? error.message : String(error);
    return base;
  }
}

/** Fan ONE prompt out to EVERY node holding the model — the "prompt all the fleet servers" case. */
export async function promptFleet(nodes: FleetNode[], model: string | null, prompt: string): Promise<PromptResult[]> {
  const targets = model ? nodes.filter((n) => n.models.includes(model)) : inferenceNodes(nodes);
  return Promise.all(targets.map((node) => promptNode(node, model ?? node.models[0], prompt)));
}

/** Route to the single best node, failing over down the ranked list the way the Hub's proxy does. */
export async function routePrompt(
  nodes: FleetNode[],
  model: string,
  prompt: string,
): Promise<{ result: PromptResult | null; failedOverFrom: string[]; candidates: number }> {
  const ranked = rankCandidates(nodes, model);
  const failedOverFrom: string[] = [];
  for (const { node } of ranked) {
    const result = await promptNode(node, model, prompt);
    if (result.ok) return { result, failedOverFrom, candidates: ranked.length };
    if (!isRetryable(result.status)) return { result, failedOverFrom, candidates: ranked.length };
    failedOverFrom.push(node.name);
  }
  return { result: null, failedOverFrom, candidates: ranked.length };
}

// --- OpenAI-compatible server ------------------------------------------------

/**
 * A local OpenAI-compatible endpoint that routes each request across the fleet. This is the seam an
 * agent plugs into: point OpenClaw (or anything else that speaks OpenAI) at it and every turn is
 * ranked and failed over across the tailnet, which is what the Hub's `/api/inference/pool/*` proxy
 * gives an installed app once peers are paired.
 *
 * Bound to loopback only. The Hub's equivalent is reachable from the appliance's Docker network and
 * guarded by `InternalNetworkGuard` + `PoolAppGuard`; there is no such boundary here, so the socket
 * itself is the boundary.
 */
/**
 * The paths the Hub's pool proxy routes across nodes, taken from `hub-pool.md` — body carries a
 * `model`, so a peer can serve it. Everything else there (`/v1/models`, `/api/tags`, `/api/ps`,
 * `/api/show`, `/api/version`) is answered by the node itself, and `/api/pull` is deliberately
 * absent: pulling a model is a node-local administrative act, not something a pool should silently
 * perform on whichever machine happened to answer.
 */
const ROUTED_PATHS = new Set([
  '/v1/chat/completions',
  '/v1/completions',
  '/v1/embeddings',
  '/api/generate',
  '/api/chat',
  '/api/embeddings',
  '/api/embed',
]);

/** Response headers naming the routing decision. Kept out of the body so the upstream schema is passed through untouched. */
interface RoutingHeaders {
  'x-ci-hub-fleet-served-by': string;
  'x-ci-hub-fleet-candidates': string;
  'x-ci-hub-fleet-failed-over-from': string;
}

/**
 * Forward one routed request down the ranked candidate list, failing over on the same classes the
 * Hub's proxy does. Returns the first committed response — once a candidate has answered with a
 * status, that answer stands, exactly as `proxyRequest` stops failing over once headers are sent.
 */
async function forwardRouted(
  nodes: FleetNode[],
  path: string,
  body: Record<string, unknown>,
): Promise<
  | { status: number; headers: RoutingHeaders; payload: string; contentType: string }
  | { error: string; status: number; candidates: number; failedOverFrom: string[] }
> {
  const model = typeof body.model === 'string' ? body.model : '';
  const ranked = rankCandidates(nodes, model);
  const failedOverFrom: string[] = [];
  if (ranked.length === 0) return { error: `no fleet node holds model '${model}'`, status: 503, candidates: 0, failedOverFrom };

  for (const { node } of ranked) {
    let status: number | null = null;
    try {
      const upstream = await fetch(`http://${node.ip}:${OLLAMA_PORT}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = upstream.status;
      if (upstream.ok) {
        return {
          status: upstream.status,
          contentType: upstream.headers.get('content-type') ?? 'application/json',
          headers: {
            'x-ci-hub-fleet-served-by': node.name,
            'x-ci-hub-fleet-candidates': String(ranked.length),
            'x-ci-hub-fleet-failed-over-from': failedOverFrom.join(',') || 'none',
          },
          payload: await upstream.text(),
        };
      }
    } catch {
      status = null; // connection error or header-wait timeout — always retryable
    }
    if (!isRetryable(status)) return { error: `upstream ${status}`, status: status ?? 502, candidates: ranked.length, failedOverFrom };
    failedOverFrom.push(node.name);
  }
  return { error: 'every candidate failed', status: 502, candidates: ranked.length, failedOverFrom };
}

/**
 * A local endpoint that routes each request across the fleet, speaking both protocols the Hub's pool
 * proxy answers (OpenAI `/v1/*` and Ollama-native `/api/*`). This is the seam an agent plugs into:
 * point OpenClaw at it and every turn — chat and embeddings alike — is ranked and failed over across
 * the tailnet, which is what an installed app gets from `/api/inference/pool/*` once peers are paired.
 *
 * Bound to loopback only. The Hub's equivalent is reachable from the appliance's Docker network and
 * guarded by `InternalNetworkGuard` + `PoolAppGuard`; there is no such boundary here, so the socket is.
 */
export function serveFleet(port: number, refreshMs = 30_000): void {
  let fleet: FleetNode[] = [];
  /** Resolves once the first sweep lands, so an early request waits for a fleet instead of seeing none. */
  let firstSweep: Promise<void> | null = null;

  /**
   * Refresh on a timer, never on the request path. Discovery probes every tailnet device — ~16s for
   * a 58-device tailnet — so doing it lazily made the first request after each expiry pay for the
   * sweep and time out. The Hub has the same shape for the same reason: peers are polled on
   * `poolHealthPollSeconds`, and a request reads the last snapshot. The cost is the same staleness
   * window the Hub carries, which per-request failover already covers.
   */
  const sweep = async (): Promise<void> => {
    try {
      fleet = await discoverFleet();
    } catch (error) {
      // Keep serving the previous snapshot: a failed sweep must not empty the fleet.
      console.error(`[discover] sweep failed, keeping ${fleet.length} known node(s): ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  firstSweep = sweep();
  setInterval(() => void sweep(), refreshMs).unref();

  const currentFleet = async (): Promise<FleetNode[]> => {
    if (firstSweep) {
      await firstSweep;
      firstSweep = null;
    }
    return fleet;
  };

  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    try {
      const nodes = await currentFleet();
      const url = (req.url ?? '/').split('?')[0];

      if (req.method === 'GET' && (url === '/v1/models' || url === '/api/tags')) {
        // Unlike the Hub's v1 proxy — whose listing endpoints are local-only for now — this merges
        // the whole fleet, because a merged catalog is the point of pointing an agent at it.
        const models = [...new Set(nodes.flatMap((n) => n.models))].sort();
        if (url === '/api/tags') return send(200, { models: models.map((name) => ({ name, model: name })) });
        return send(200, { object: 'list', data: models.map((id) => ({ id, object: 'model', owned_by: 'ci-hub-fleet' })) });
      }

      if (req.method === 'GET' && url === '/fleet/status') {
        return send(200, {
          nodes: nodes
            .filter((n) => n.models.length > 0)
            .map((n) => ({ name: n.name, ip: n.ip, models: n.models.length, running: n.running, hub: n.hubReachable, poolCapable: n.poolCapable })),
        });
      }

      if (req.method === 'POST' && ROUTED_PATHS.has(url)) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
        const startedAt = Date.now();
        const routed = await forwardRouted(nodes, url, body);
        if ('error' in routed) {
          console.log(
            `[route] ${url} ${String(body.model)} -> FAILED (${routed.candidates} candidates, tried ${routed.failedOverFrom.join(', ') || 'none'})`,
          );
          return send(routed.status, { error: { message: routed.error, candidates: routed.candidates, failedOverFrom: routed.failedOverFrom } });
        }
        const over = routed.headers['x-ci-hub-fleet-failed-over-from'];
        console.log(
          `[route] ${url} ${String(body.model)} -> ${routed.headers['x-ci-hub-fleet-served-by']} (${Date.now() - startedAt}ms, ${routed.headers['x-ci-hub-fleet-candidates']} candidates${over === 'none' ? '' : `, failed over from ${over}`})`,
        );
        return send(routed.status, routed.payload, { ...routed.headers, 'content-type': routed.contentType });
      }

      return send(404, { error: { message: `no route for ${req.method} ${url}` } });
    } catch (error) {
      send(500, { error: { message: error instanceof Error ? error.message : String(error) } });
    }
  });

  server.listen(port, '127.0.0.1', () => console.log(`fleet-router listening on http://127.0.0.1:${port} (OpenAI + Ollama compatible)`));
}
// --- formatters --------------------------------------------------------------

export function formatDiscovery(nodes: FleetNode[]): string[] {
  const inference = inferenceNodes(nodes);
  const hubs = nodes.filter((n) => n.hubReachable);
  const lines = [
    `Tailnet devices probed : ${nodes.length}  (online: ${nodes.filter((n) => n.online).length})`,
    `Inference nodes        : ${inference.length}`,
    `Hub API reachable      : ${hubs.length}  (pool-capable: ${hubs.filter((n) => n.poolCapable).length})`,
    '',
    'NODE                      ADDRESS           LOAD  HUB   POOL  MODELS',
  ];
  for (const n of inference) {
    const load = n.loadKnown ? String(n.running) : '?';
    lines.push(
      `${(n.name + (n.isSelf ? ' (self)' : '')).padEnd(25)} ${n.ip.padEnd(17)} ${load.padStart(4)}  ${(n.hubReachable ? 'yes' : '-').padEnd(5)} ${(n.poolCapable ? 'yes' : '-').padEnd(5)} ${n.models.join(', ')}`,
    );
  }
  const hubOnly = hubs.filter((n) => n.models.length === 0);
  if (hubOnly.length > 0) {
    lines.push('', 'Hub API but no local inference engine:');
    for (const n of hubOnly) lines.push(`  ${n.name.padEnd(23)} ${n.ip.padEnd(17)} pool-capable: ${n.poolCapable ? 'yes' : 'no'}`);
  }
  return lines;
}

export function formatPromptResults(results: PromptResult[]): string[] {
  const ok = results.filter((r) => r.ok);
  const lines = [`Fanned out to ${results.length} node(s) — ${ok.length} answered, ${results.length - ok.length} failed`, ''];
  for (const r of [...results].sort((a, b) => a.ms - b.ms)) {
    lines.push(`── ${r.node}  [${r.model}]  ${r.ok ? `${r.ms}ms` : `FAILED ${r.status ?? 'conn'}`}`);
    lines.push(`   ${r.ok ? r.response.replace(/\n/g, '\n   ').slice(0, 600) : (r.error ?? '').slice(0, 200)}`);
    lines.push('');
  }
  return lines;
}

// --- CLI ---------------------------------------------------------------------

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));

  if (!command || command === 'help' || command === '--help') {
    console.log(
      [
        'fleet-router — prompt every inference node on the tailnet',
        '',
        '  discover                      probe the tailnet and classify every reachable node',
        '  prompt <text> [--model M]     fan ONE prompt out to EVERY node holding the model',
        '  route <text> --model M        route to the single best node, with failover',
        '  serve [--port 5099]           OpenAI-compatible endpoint that routes across the fleet',
        '',
        '  --json                        machine-readable output (discover, prompt)',
      ].join('\n'),
    );
    return;
  }

  if (command === 'serve') {
    serveFleet(Number(flag(args, 'port') ?? 5099));
    return;
  }

  const nodes = await discoverFleet();
  const asJson = args.includes('--json');

  if (command === 'discover') {
    console.log(asJson ? JSON.stringify(nodes, null, 2) : formatDiscovery(nodes).join('\n'));
    return;
  }

  const text = positional.join(' ');
  if (!text) {
    console.error(`${command} needs a prompt.`);
    process.exitCode = 1;
    return;
  }

  if (command === 'prompt') {
    const results = await promptFleet(nodes, flag(args, 'model') ?? null, text);
    console.log(asJson ? JSON.stringify(results, null, 2) : formatPromptResults(results).join('\n'));
    process.exitCode = results.some((r) => r.ok) ? 0 : 1;
    return;
  }

  if (command === 'route') {
    const model = flag(args, 'model');
    if (!model) {
      console.error('route needs --model.');
      process.exitCode = 1;
      return;
    }
    const routed = await routePrompt(nodes, model, text);
    if (!routed.result?.ok) {
      console.error(`No candidate served ${model} (${routed.candidates} ranked, failed over from: ${routed.failedOverFrom.join(', ') || 'none'})`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `served by ${routed.result.node} in ${routed.result.ms}ms  (${routed.candidates} candidates${routed.failedOverFrom.length ? `, failed over from ${routed.failedOverFrom.join(', ')}` : ''})\n`,
    );
    console.log(routed.result.response);
    return;
  }

  console.error(`Unknown command '${command}'. Try: discover | prompt | route | serve`);
  process.exitCode = 1;
}

if (process.argv[1]?.endsWith('fleet-router.ts')) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
