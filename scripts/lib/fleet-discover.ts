/**
 * Finding machines: the tailnet, the LAN, and what each one will actually let you do.
 *
 * THE POINT OF THIS FILE is that "reachable" is three independent questions, and every fleet tool
 * that has collapsed them into one has been wrong in the same direction:
 *
 *   · does it serve inference?   (`:11434` and friends answer)
 *   · does it run a Hub?         (`:5002/api/inference/health` answers)
 *   · can you administer it?     (SSH succeeds)
 *
 * A node can answer the first two perfectly and refuse the third forever. That is not hypothetical:
 * two machines on this fleet have carried no tailnet SSH grant for an unknown period, serving models
 * the whole time, and no tool noticed because every tool asked only the first question. A scan that
 * prints one "online" column recreates that blind spot, so this one never merges the three.
 *
 * Everything here is READ-ONLY. Discovery probes GET endpoints and runs `true` over SSH; it installs
 * nothing, writes nothing to a node, and the roster is only touched when the operator passes
 * `--write-roster`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import type { FleetNode } from './fleet-roster.js';
import { classifySshFailure, sshCapture, type SshFailure } from './fleet-ssh.js';

/** Where a candidate came from. Kept on the row so a listing can say why it is being shown. */
export type DiscoverySource = 'tailnet' | 'lan' | 'roster';

export interface ProbeAxes {
  /** SSH succeeded — the machine is administrable. */
  ssh: boolean;
  sshFailure: SshFailure;
  /** A CI-Hub API answered on :5002. */
  hub: boolean;
  hubDetail?: string;
  /**
   * Whether Portal knows this Hub — the axis a healthy-looking Hub hides. On 2026-09-18 twelve of
   * fifteen Hubs answered `/api/inference/health` with a tier and six backends while seven were
   * unregistered and five had a device key Portal rejected; nothing in the table said so.
   * Undefined when no Hub answered.
   */
  portal?: PortalAxis;
  /** At least one inference engine answered. */
  engines: string[];
}

/** Read from `GET /api/registration/phase`, the route that reports without sending a check-in. */
export interface PortalAxis {
  /** `unregistered`, `locally_ready`, `publicly_ready`, `degraded`, … as the Hub names its phase. */
  phase: string;
  registered: boolean;
  /** HTTP status of the Hub's last check-in with Portal, or null when it has not made one. */
  checkIn: number | null;
  /** The Hub's own wording for a failed check-in or a degraded phase. */
  error?: string;
}

export type PortalStanding = 'ok' | 'rejected' | 'unregistered' | 'pending' | 'none';

/** One word for the column, from the phase and the last check-in together. */
export function portalStanding(axis: PortalAxis | undefined): PortalStanding {
  if (!axis) return 'none';
  if (!axis.registered || axis.phase === 'unregistered') return 'unregistered';
  if (axis.checkIn === null) return 'pending';
  return axis.checkIn >= 200 && axis.checkIn < 300 ? 'ok' : 'rejected';
}

export function renderPortalCell(axis: PortalAxis | undefined): { text: string; tone: 'green' | 'yellow' | 'dim' } {
  switch (portalStanding(axis)) {
    case 'ok':
      return { text: `ok ${axis?.checkIn}`, tone: 'green' };
    case 'rejected':
      return { text: `${axis?.checkIn} rejected`, tone: 'yellow' };
    case 'unregistered':
      return { text: 'unregistered', tone: 'yellow' };
    case 'pending':
      return { text: `${axis?.phase}, no check-in yet`, tone: 'dim' };
    case 'none':
      return { text: '—', tone: 'dim' };
  }
}

export function parsePortalPhase(body: unknown): PortalAxis | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const doc = body as {
    phase?: unknown;
    registered?: unknown;
    lastCheckIn?: { httpStatus?: unknown; error?: unknown } | null;
    degradedReasons?: unknown;
  };
  if (typeof doc.phase !== 'string') return undefined;
  const checkIn = typeof doc.lastCheckIn?.httpStatus === 'number' ? doc.lastCheckIn.httpStatus : null;
  const reasons = Array.isArray(doc.degradedReasons) ? doc.degradedReasons.filter((r): r is string => typeof r === 'string') : [];
  const error = typeof doc.lastCheckIn?.error === 'string' ? doc.lastCheckIn.error : reasons.length ? reasons.join(', ') : undefined;
  return { phase: doc.phase, registered: doc.registered === true, checkIn, error };
}

export interface DiscoveredNode extends FleetNode {
  source: DiscoverySource;
  probe: ProbeAxes;
}

export const HUB_API_PORT = Number(process.env.CI_HUB_API_PORT) || 5002;
export const OLLAMA_PORT = 11434;

/** Ports worth a GET when looking for an engine. Matches the six backends CI-Hub can front. */
const ENGINE_PROBES: { backend: string; port: number; path: string }[] = [
  { backend: 'ollama', port: 11434, path: '/api/tags' },
  { backend: 'lemonade', port: 13305, path: '/v1/models' },
  { backend: 'dspark', port: 8080, path: '/health' },
  // vllm / mtplx / lucebox share a port space; the fingerprint needs a live body to tell them apart,
  // so discovery reports the port answered and leaves naming to the richer probes in the QA harness.
  { backend: 'openai-compatible', port: 8000, path: '/v1/models' },
  { backend: 'openai-compatible', port: 8216, path: '/v1/models' },
  { backend: 'openai-compatible', port: 8020, path: '/v1/models' },
];

async function getOk(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url: string, timeoutMs: number): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Tailnet ─────────────────────────────────────────────────────────────────

/**
 * Locate the Tailscale CLI.
 *
 * The macOS app bundle is the case worth handling explicitly: Tailscale installed from the App Store
 * puts its CLI inside `Tailscale.app` and never on PATH, so a plain `which tailscale` reports "not
 * installed" on a machine that is plainly on the tailnet.
 */
export function resolveTailscaleCli(): string | null {
  const candidates = [
    process.env.TAILSCALE_CLI,
    'tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/tailscale',
    '/usr/bin/tailscale',
    '/usr/local/bin/tailscale',
  ].filter((c): c is string => Boolean(c));

  for (const candidate of candidates) {
    if (candidate.includes('/')) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    const probe = spawnSync(candidate, ['version'], { stdio: 'ignore' });
    if (probe.status === 0) return candidate;
  }
  return null;
}

export interface TailnetPeer {
  name: string;
  ip: string;
  dnsName?: string;
  os?: string;
  online: boolean;
}

/**
 * Parse the document `tailscale status --json` prints into the peers it names.
 *
 * Pure, so a test can feed it a fixture. `Self` is deliberately not a peer: the machine running the
 * CLI is never a fleet target, and a scan that listed it would then try to SSH to itself.
 *
 * No ACL tag is read as fleet membership. The tailnet's `tag:ci-server` is an internal test tag, not
 * an inventory, and a peer list is not a fleet either way — see `cli-fleet.ts` for what is.
 */
export function parseTailnetStatus(stdout: string): { peers: TailnetPeer[]; error?: string } {
  let doc: { Peer?: Record<string, unknown>; Self?: Record<string, unknown>; BackendState?: string };
  try {
    doc = JSON.parse(stdout) as typeof doc;
  } catch (error) {
    return { peers: [], error: `tailscale status returned unparsable JSON: ${String(error)}` };
  }
  if (doc.BackendState && doc.BackendState !== 'Running') {
    return { peers: [], error: `tailscale is installed but not running (BackendState=${doc.BackendState})` };
  }

  const peers: TailnetPeer[] = [];
  const rows = Object.values(doc.Peer ?? {});
  for (const row of rows) {
    const p = row as { HostName?: string; DNSName?: string; TailscaleIPs?: string[]; OS?: string; Online?: boolean };
    const ip = p.TailscaleIPs?.find((a) => a.includes('.'));
    if (!ip) continue;
    peers.push({
      name: p.HostName ?? ip,
      ip,
      // MagicDNS names arrive with a trailing dot; pool pairing keys on the FQDN, so normalise here
      // rather than leaving every caller to remember.
      dnsName: p.DNSName ? p.DNSName.replace(/\.$/, '') : undefined,
      os: p.OS,
      online: p.Online === true,
    });
  }
  peers.sort((a, b) => a.name.localeCompare(b.name));
  return { peers };
}

/**
 * Enumerate tailnet peers.
 *
 * `tailscale status --json` carries the whole peer map. The nearest existing helper in the sibling
 * repo parses this same document and then only *counts* `j.Peer` — the enumeration below is the
 * thing that was missing, and it is the entire basis for "find my machines".
 */
export function tailnetPeers(cli: string = resolveTailscaleCli() ?? 'tailscale'): { peers: TailnetPeer[]; error?: string } {
  const res = spawnSync(cli, ['status', '--json'], { encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 });
  if (res.error) return { peers: [], error: `tailscale CLI not runnable: ${String(res.error)}` };
  if (res.status !== 0) return { peers: [], error: (res.stderr || 'tailscale status failed').trim() };
  return parseTailnetStatus(res.stdout);
}

// ─── LAN ─────────────────────────────────────────────────────────────────────

const LAN_SCAN_MAX_HOSTS = 1024;
const LAN_SCAN_CONCURRENCY = 48;
const LAN_SCAN_TIMEOUT_MS = 600;

function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}
function intToIp(n: number): string {
  return [24, 16, 8, 0].map((shift) => (n >>> shift) & 255).join('.');
}

/**
 * Every host address on this machine's own subnets.
 *
 * Bounded hard at a /20. A wider mask is almost always a misconfiguration or a VPN catch-all, and
 * enumerating it means tens of thousands of probes that will find nothing — the cap turns a hang
 * into a fast, honest "nothing found here".
 */
export function localSubnetHosts(): string[] {
  const hosts: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal || !addr.netmask) continue;
      const mask = ipToInt(addr.netmask);
      const hostBits =
        32 -
        mask
          .toString(2)
          .split('')
          .filter((b) => b === '1').length;
      if (hostBits <= 0 || hostBits > 12) continue;
      const base = ipToInt(addr.address) & mask;
      const count = 2 ** hostBits;
      for (let i = 1; i < count - 1 && hosts.length < LAN_SCAN_MAX_HOSTS; i++) hosts.push(intToIp(base + i));
    }
  }
  return hosts;
}

/** Addresses on the local subnets answering on an engine or Hub port. */
export async function scanLan(exclude: ReadonlySet<string> = new Set()): Promise<string[]> {
  const candidates = localSubnetHosts().filter((ip) => !exclude.has(ip));
  const hits: string[] = [];
  for (let i = 0; i < candidates.length; i += LAN_SCAN_CONCURRENCY) {
    const chunk = candidates.slice(i, i + LAN_SCAN_CONCURRENCY);
    const found = await Promise.all(
      chunk.map(async (ip) => {
        const ollama = await getOk(`http://${ip}:${OLLAMA_PORT}/api/tags`, LAN_SCAN_TIMEOUT_MS);
        if (ollama) return ip;
        const hub = await getOk(`http://${ip}:${HUB_API_PORT}/api/inference/health`, LAN_SCAN_TIMEOUT_MS);
        return hub ? ip : null;
      }),
    );
    hits.push(...found.filter((ip): ip is string => Boolean(ip)));
  }
  return hits;
}

// ─── Probing one candidate ───────────────────────────────────────────────────

/**
 * Ask all three questions of one machine, independently.
 *
 * The SSH probe runs `true` — the cheapest command that still proves a real session was established.
 * Its verdict is reported separately from the HTTP answers and neither is allowed to stand in for
 * the other.
 */
export async function probeNode(node: FleetNode, opts: { timeoutMs?: number; skipSsh?: boolean; user?: string } = {}): Promise<ProbeAxes> {
  const httpTimeout = opts.timeoutMs ?? 4_000;

  const enginePromise = Promise.all(
    ENGINE_PROBES.map(async (probe) =>
      (await getOk(`http://${node.ip}:${probe.port}${probe.path}`, httpTimeout)) ? `${probe.backend}:${probe.port}` : null,
    ),
  );
  const hubPromise = getJson(`http://${node.ip}:${HUB_API_PORT}/api/inference/health`, httpTimeout);
  const portalPromise = getJson(`http://${node.ip}:${HUB_API_PORT}/api/registration/phase`, httpTimeout);
  const sshPromise = opts.skipSsh
    ? Promise.resolve(null)
    : sshCapture({ host: node.ip, user: node.user ?? opts.user }, 'true', Math.max(httpTimeout, 8_000));

  const [engineHits, hubBody, portalBody, sshResult] = await Promise.all([enginePromise, hubPromise, portalPromise, sshPromise]);

  const engines = engineHits.filter((e): e is string => Boolean(e));
  const hub = hubBody !== null;
  const backends = (hubBody as { backends?: unknown[] } | null)?.backends;
  const tier = (hubBody as { hardwareTier?: string } | null)?.hardwareTier;

  return {
    ssh: sshResult ? sshResult.ok : false,
    sshFailure: sshResult ? classifySshFailure(sshResult) : 'ok',
    hub,
    hubDetail: hub
      ? [tier ? `tier ${tier}` : null, Array.isArray(backends) ? `${backends.length} backends` : null].filter(Boolean).join(', ')
      : undefined,
    portal: hub ? parsePortalPhase(portalBody) : undefined,
    engines,
  };
}

/**
 * The sentence a scan prints for one node.
 *
 * Named separately because this judgement is the product of the whole file: it is the one place that
 * says "serves models, cannot be administered" instead of a colour.
 */
export function summariseNode(node: DiscoveredNode): string {
  const { probe } = node;
  if (!probe.ssh && (probe.engines.length > 0 || probe.hub)) {
    if (probe.sshFailure === 'acl-wrong-user') return 'serves inference; SSH needs a different user — pass --user';
    if (probe.sshFailure === 'acl-denied') return 'serves inference but grants no SSH at all — unadministrable until the tailnet ACL is changed';
    return `serves inference but SSH failed (${probe.sshFailure}) — no fleet operation can reach it`;
  }
  if (probe.ssh && !probe.hub && probe.engines.length === 0) return 'reachable, no Hub and no engine yet — a candidate for install';
  if (probe.ssh && !probe.hub) return 'reachable and serving an engine, but no CI-Hub — a candidate for install';
  if (probe.ssh && probe.hub) {
    switch (portalStanding(probe.portal)) {
      case 'unregistered':
        return 'Hub reachable and administrable, but not registered with Portal';
      case 'rejected':
        return `Hub reachable and administrable, but Portal rejects it (${probe.portal?.checkIn})`;
      default:
        return 'Hub reachable and administrable';
    }
  }
  return `nothing answered (${probe.sshFailure})`;
}
