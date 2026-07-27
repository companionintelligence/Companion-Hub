import dns from 'node:dns/promises';
import os from 'node:os';
import type { HostFirewallInfo } from '@ci-hub/common/types';

export function isConnectionRefused(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('ECONNREFUSED') || msg.includes('connect ECONNREFUSED');
}

/**
 * How a bridge connection attempt failed. The distinction matters because the
 * remediation is completely different, and guessing wrong sends the operator
 * down a dead end:
 *
 * - `refused` — the packet reached the host and something sent back an RST.
 *   The bridge WORKS; the service is down or bound to loopback only.
 * - `filtered` — nothing came back at all and the attempt expired. A closed
 *   port on a reachable host refuses in milliseconds, so silence means a packet
 *   filter (ufw/firewalld/nftables) is dropping it. The service may be running
 *   perfectly and still be unreachable from the container.
 * - `dns` — `host.docker.internal` did not resolve, i.e. the compose
 *   `extra_hosts: host-gateway` mapping is missing.
 */
export type BridgeFailureMode = 'filtered' | 'refused' | 'dns' | 'none';

/** Name resolution never happened — the host-gateway mapping is missing. */
const DNS_PATTERNS = ['ENOTFOUND', 'EAI_AGAIN', 'getaddrinfo'];

/**
 * Silent drop: the connection attempt expired without an answer.
 *
 * `ECONNABORTED` + "timeout of Nms exceeded" is what axios reports on a
 * client-side timeout (its default `transitional.clarifyTimeoutError` is false,
 * so it does NOT surface as ETIMEDOUT). Undici/fetch report `ConnectTimeoutError`
 * or an abort. Missing these was why a firewalled bridge was reported as "not a
 * bridge problem" and the operator got no firewall guidance at all.
 */
const FILTERED_PATTERNS = [
  'ETIMEDOUT',
  'ECONNABORTED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'ConnectTimeoutError',
  'network unreachable',
  'timeout',
  'timed out',
  'aborted',
];

/** An RST came back (or the peer hung up) — the bridge itself is fine. */
const REFUSED_PATTERNS = ['ECONNREFUSED', 'socket hang up'];

function includesAny(error: string, patterns: string[]): boolean {
  return patterns.some((pattern) => error.includes(pattern));
}

/**
 * Only interpret a failure as bridge-related when it actually concerns the
 * host-gateway path — either the configured URL targets it, or the error text
 * names a Docker bridge address.
 */
function isBridgeScoped(error: string, configuredUrl?: string): boolean {
  if (configuredUrl?.includes('host.docker.internal')) return true;
  return error.includes('172.17.') || error.includes('172.18.') || error.includes('host.docker.internal');
}

/** Classify why the Hub container could not reach a host service over the Docker bridge. */
export function classifyBridgeFailure(error?: string, configuredUrl?: string): BridgeFailureMode {
  if (!error) return 'none';
  if (!isBridgeScoped(error, configuredUrl)) return 'none';

  // Order matters: ECONNREFUSED and the DNS codes are unambiguous, so they are
  // matched before the broader timeout patterns.
  if (includesAny(error, DNS_PATTERNS)) return 'dns';
  if (includesAny(error, REFUSED_PATTERNS)) return 'refused';
  if (includesAny(error, FILTERED_PATTERNS)) return 'filtered';
  return 'none';
}

/**
 * Returns true for network-layer failures that indicate the Hub container
 * could not reach host-side Ollama over the Docker bridge.
 *
 * Retained for callers that only need a boolean; prefer `classifyBridgeFailure`
 * when the remediation depends on which way it failed.
 */
export function isBridgeConnectionRefused(error?: string, configuredUrl?: string): boolean {
  return classifyBridgeFailure(error, configuredUrl) !== 'none';
}

export function resolveHostPlatform(): NodeJS.Platform {
  const override = process.env.CI_HUB_HOST_PLATFORM;
  if (override === 'darwin' || override === 'linux' || override === 'win32') {
    return override;
  }
  return os.platform();
}

/**
 * The concrete addresses involved in the failed hop, read from the running
 * process so the remediation command contains real values instead of
 * placeholders the operator has to work out for themselves.
 */
export interface BridgeTopology {
  /** Host-gateway address the container dials, e.g. `172.17.0.1`. */
  gatewayIp?: string;
  /** The container's own network in CIDR form, e.g. `172.18.0.0/16`. */
  containerCidr?: string;
  /** Destination port, e.g. `11434`. */
  port?: number;
}

function parseEndpointPort(configuredUrl?: string): number | undefined {
  if (!configuredUrl) return undefined;
  try {
    const url = new URL(configuredUrl);
    if (url.port) return Number(url.port);
    return url.protocol === 'https:' ? 443 : 80;
  } catch {
    return undefined;
  }
}

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Cap the lookup. This runs on a status path that is already failing, and a
 * stalled resolver must not turn a fast, useful error into another hang — that
 * is the exact failure this whole module exists to diagnose.
 */
const GATEWAY_LOOKUP_TIMEOUT_MS = 1500;

async function resolveGatewayIp(configuredUrl?: string): Promise<string | undefined> {
  if (!configuredUrl) return undefined;
  let hostname: string;
  try {
    hostname = new URL(configuredUrl).hostname;
  } catch {
    return undefined;
  }
  if (IPV4_LITERAL.test(hostname)) return hostname;

  let timer: NodeJS.Timeout | undefined;
  try {
    const lookup = dns.lookup(hostname, { family: 4 }).then(({ address }) => address);
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), GATEWAY_LOOKUP_TIMEOUT_MS);
      // Do not hold the event loop open on this timer alone.
      timer.unref?.();
    });
    return await Promise.race([lookup, timeout]);
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Convert an address + netmask pair into its network CIDR (e.g. 172.18.0.7/255.255.0.0 → 172.18.0.0/16). */
export function toNetworkCidr(address: string, netmask: string): string | undefined {
  const octets = address.split('.').map(Number);
  const mask = netmask.split('.').map(Number);
  const valid = (parts: number[]) => parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
  if (!valid(octets) || !valid(mask)) return undefined;

  const network = octets.map((octet, i) => octet & (mask[i] ?? 0)).join('.');
  const bits = mask.reduce((total, octet) => total + (octet.toString(2).match(/1/g)?.length ?? 0), 0);
  return `${network}/${bits}`;
}

/**
 * The container's own IPv4 network, used as the firewall rule's source range.
 *
 * Takes the first non-internal IPv4 interface. The Hub is attached to exactly
 * one compose network, so that is unambiguous today; if it is ever multi-homed
 * this would need to pick the interface that routes to the gateway instead.
 */
function resolveContainerCidr(): string | undefined {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || !entry.netmask) continue;
      const cidr = toNetworkCidr(entry.address, entry.netmask);
      if (cidr) return cidr;
    }
  }
  return undefined;
}

/** Gather the real addresses for the failed hop so guidance can name them. */
export async function resolveBridgeTopology(configuredUrl?: string): Promise<BridgeTopology> {
  return {
    gatewayIp: await resolveGatewayIp(configuredUrl),
    containerCidr: resolveContainerCidr(),
    port: parseEndpointPort(configuredUrl),
  };
}

function getOllamaRunningTip(hostPlatform?: string): string {
  switch (hostPlatform) {
    case 'darwin':
      return 'Ensure the Ollama app is running (check the menu bar), then re-check.';
    case 'win32':
      return 'Ensure Ollama is running (check the system tray or Start menu), then re-check.';
    case 'linux':
      return 'Ensure Ollama is running on the host (on systemd Linux: systemctl status ollama), then re-check.';
    default:
      return 'Ensure Ollama is running on the host, then re-check.';
  }
}

/**
 * User-facing guidance when host Ollama is reachable-in-principle but refused
 * the connection — i.e. the bridge works and the service is down or bound to
 * loopback only.
 */
export function buildBridgeConnectionHint(hostPlatform?: string): string {
  const runningTip = getOllamaRunningTip(hostPlatform);
  return (
    `Ollama may already be installed on this machine, but the Hub container could not connect to it. ${runningTip} ` +
    'If the Hub runs in Docker, configure Ollama to listen on all interfaces (OLLAMA_HOST=0.0.0.0:11434) so containers can reach it.'
  );
}

/**
 * Firewall rule that permits the container network to reach the host gateway on
 * one port.
 *
 * Returns undefined when the host probe affirmatively reported no packet filter
 * (`kind: 'none'`, which is also what a darwin/win32 host records) — emitting a
 * Linux rule there contradicts the probe and hands a macOS or Windows operator
 * a command their machine cannot run.
 */
export function buildFirewallAllowCommand(topology: BridgeTopology, firewall?: HostFirewallInfo): string | undefined {
  const { containerCidr, gatewayIp, port } = topology;
  if (!containerCidr || !gatewayIp || !port) return undefined;
  if (firewall?.kind === 'none') return undefined;

  switch (firewall?.kind) {
    case 'firewalld':
      return (
        `sudo firewall-cmd --permanent --add-rich-rule='rule family=ipv4 ` +
        `source address=${containerCidr} destination address=${gatewayIp} ` +
        `port port=${port} protocol=tcp accept' && sudo firewall-cmd --reload`
      );
    case 'nftables':
      // `insert` rather than `add`: `add` appends past the existing drop rule,
      // which already matched, so the accept would never be reached.
      return `sudo nft insert rule inet filter input ip saddr ${containerCidr} ip daddr ${gatewayIp} tcp dport ${port} accept`;
    case 'iptables':
      // -I inserts at the top of INPUT. Not persisted across reboot — the host
      // needs iptables-persistent (or equivalent) to keep it.
      return `sudo iptables -I INPUT -s ${containerCidr} -d ${gatewayIp} -p tcp --dport ${port} -j ACCEPT`;
    default:
      // ufw is the common case on Ubuntu hosts, and is the safe default to show
      // when the host probe could not identify the firewall.
      return `sudo ufw allow from ${containerCidr} to ${gatewayIp} port ${port} proto tcp`;
  }
}

export interface BridgeRemediation {
  mode: BridgeFailureMode;
  /** Prose explaining what failed and why. */
  hint: string;
  /** Copy-pasteable command, run ON THE HOST. Only set when we know enough to be specific. */
  command?: string;
}

export interface BridgeRemediationInput {
  mode: BridgeFailureMode;
  hostPlatform?: string;
  topology?: BridgeTopology;
  firewall?: HostFirewallInfo;
  /** Human-readable service name for the messages. */
  service?: string;
}

/**
 * Turn a classified failure into guidance that names the actual cause.
 *
 * The `filtered` branch exists because the previous single message told the
 * operator to check that the service was running and listening on all
 * interfaces — both of which are already true when a firewall is dropping the
 * packets, so following it led nowhere.
 */
export function buildBridgeRemediation(input: BridgeRemediationInput): BridgeRemediation {
  const { mode, hostPlatform, topology, firewall, service = 'Ollama' } = input;

  if (mode === 'dns') {
    return {
      mode,
      hint:
        `The Hub container could not resolve host.docker.internal, so it never reached ${service}. ` +
        'This usually means the container is missing the `extra_hosts: ["host.docker.internal:host-gateway"]` mapping. ' +
        'Recreate the Hub stack so compose reapplies it.',
    };
  }

  if (mode === 'filtered') {
    const target = topology?.gatewayIp && topology.port ? `${topology.gatewayIp}:${topology.port}` : 'the host gateway';
    // A packet-filter rule is Linux-only. Docker Desktop on macOS/Windows routes
    // through a VM whose gateway address means nothing to the host's own tooling,
    // so never hand those operators a ufw/nft/iptables line.
    const isLinuxHost = hostPlatform !== 'darwin' && hostPlatform !== 'win32';
    const command = isLinuxHost ? buildFirewallAllowCommand(topology ?? {}, firewall) : undefined;
    const firewallName = firewall?.kind && firewall.kind !== 'none' && firewall.kind !== 'unknown' ? firewall.kind : 'a host firewall';

    const detail =
      `The Hub container's packets to ${target} are being dropped by ${firewallName} — ` +
      `this is a host firewall problem, not a problem with ${service}. ` +
      `${service} can be running and listening correctly and still be unreachable from the container: ` +
      'a stopped service refuses the connection instantly, whereas a firewall DROP produces the silent timeout seen here.';
    // The probe times the whole request, not just the connect, so a service that
    // accepted the connection and then took too long to answer looks identical.
    // Say so rather than asserting the firewall with certainty.
    const caveat = `If ${service} is up but was merely slow to answer (a large model loading, for example), the same timeout appears — re-check once it is idle.`;

    if (!command) {
      return {
        mode,
        hint: `${detail} Allow the Hub's container network to reach the host gateway on this port, then re-check. ${caveat}`,
      };
    }

    return {
      mode,
      hint: `${detail} Run this on the host (not inside the container), then re-check. ${caveat}`,
      command,
    };
  }

  if (mode === 'refused') {
    return { mode, hint: buildBridgeConnectionHint(hostPlatform) };
  }

  return { mode, hint: '' };
}
