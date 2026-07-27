/**
 * Docker-bridge reachability checks for `cihub doctor`.
 *
 * The Hub container reaches host services (Ollama, and its own API when
 * cloudflared dials back in) over the host-gateway bridge. On a host with a
 * default-deny firewall those packets are dropped silently, which is invisible
 * from the host itself — the service answers fine on 127.0.0.1 while every
 * container-side call times out.
 *
 * The discriminator used here is exactly that asymmetry: a service that answers
 * from the host but not from inside the container is firewalled. Reporting it at
 * `cihub up` time is far better than letting it surface as a spinner during
 * onboarding.
 */
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { parseEnvFile } from './env-file';

/** Hub stack container that shares the network the checks must run from. */
const HUB_CONTAINER = 'ci-os-hub';
const PROBE_TIMEOUT_MS = 3000;

export interface BridgeServiceSpec {
  label: string;
  port: number;
}

export type BridgeVerdict = 'ok' | 'filtered' | 'absent' | 'unknown';

export interface BridgeCheckResult {
  label: string;
  port: number;
  hostReachable: boolean;
  containerReachable: boolean;
  verdict: BridgeVerdict;
}

export interface BridgeDoctorSection {
  lines: string[];
  issueCount: number;
  /** Command that fixes every filtered port, when one could be derived. */
  remediationCommands: string[];
}

function docker(args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 10_000 });
  return { ok: result.status === 0, stdout: (result.stdout ?? '').trim() };
}

/** TCP connect from the host itself. Proves the service is listening. */
export function probeHostPort(port: number, host = '127.0.0.1', timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (reachable: boolean) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/**
 * TCP connect from inside the running Hub container, over the same host-gateway
 * path the backend uses. Node is always present in this image, so no extra
 * tooling is required.
 */
export function probeFromHubContainer(port: number, timeoutMs = PROBE_TIMEOUT_MS): boolean {
  const script = `const net=require('net');const s=new net.Socket();s.setTimeout(${timeoutMs});const end=c=>{s.destroy();process.exit(c)};s.once('connect',()=>end(0));s.once('timeout',()=>end(1));s.once('error',()=>end(1));s.connect(${port},'host.docker.internal');`;
  const result = spawnSync('docker', ['exec', HUB_CONTAINER, 'node', '-e', script], {
    encoding: 'utf8',
    timeout: timeoutMs + 7000,
  });
  return result.status === 0;
}

export function isHubContainerRunning(): boolean {
  const result = docker(['ps', '--filter', `name=^/${HUB_CONTAINER}$`, '--filter', 'status=running', '--format', '{{.Names}}']);
  return result.ok && result.stdout.split('\n').includes(HUB_CONTAINER);
}

/**
 * The Hub container's own network in CIDR form — the source range for a firewall rule.
 *
 * Takes the first network; the Hub is attached to exactly one compose network,
 * so that is unambiguous today.
 */
export function resolveHubContainerCidr(): string | undefined {
  const result = docker(['inspect', HUB_CONTAINER, '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}/{{.IPPrefixLen}} {{end}}']);
  if (!result.ok) return undefined;

  const [first] = result.stdout.split(/\s+/).filter(Boolean);
  if (!first) return undefined;

  const [address, prefix] = first.split('/');
  const bits = Number(prefix);
  const octets = address?.split('.').map(Number);
  if (!octets || octets.length !== 4 || !Number.isInteger(bits) || bits < 0 || bits > 32) return undefined;

  const maskInt = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const addressInt = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const networkInt = (addressInt & maskInt) >>> 0;
  const network = [(networkInt >>> 24) & 255, (networkInt >>> 16) & 255, (networkInt >>> 8) & 255, networkInt & 255].join('.');
  return `${network}/${bits}`;
}

/** The host-gateway address the container resolves `host.docker.internal` to. */
export function resolveHostGatewayIp(): string | undefined {
  const result = spawnSync(
    'docker',
    ['exec', HUB_CONTAINER, 'node', '-e', "require('dns').lookup('host.docker.internal',{family:4},(e,a)=>{if(e)process.exit(1);console.log(a)})"],
    { encoding: 'utf8', timeout: 10_000 },
  );
  if (result.status !== 0) return undefined;
  const address = (result.stdout ?? '').trim();
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(address) ? address : undefined;
}

/**
 * Host services the Hub stack dials over the bridge.
 *
 * The Hub API entry matters because cloudflared reaches the Hub through it — a
 * filtered 5002 means the public tunnel URL never loads even though every
 * container is healthy.
 */
export function resolveBridgeServices(envFileName: string): BridgeServiceSpec[] {
  let vars: Record<string, string> = {};
  try {
    vars = parseEnvFile(envFileName);
  } catch {
    vars = {};
  }
  const port = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };

  return [
    { label: 'Hub API (cloudflared origin)', port: port(vars.API_PORT, 5002) },
    { label: 'Ollama', port: port(portFromUrl(vars.OLLAMA_URL), 11434) },
    { label: 'vLLM', port: port(portFromUrl(vars.VLLM_URL), 8000) },
    { label: 'Lemonade', port: port(portFromUrl(vars.LEMONADE_URL), 13305) },
  ];
}

function portFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).port || undefined;
  } catch {
    return undefined;
  }
}

export async function checkBridgeService(spec: BridgeServiceSpec): Promise<BridgeCheckResult> {
  const hostReachable = await probeHostPort(spec.port);
  // Nothing is listening on the host, so there is nothing for the container to
  // reach. Reporting this as a firewall problem would be a false alarm.
  if (!hostReachable) {
    return { ...spec, hostReachable, containerReachable: false, verdict: 'absent' };
  }

  const containerReachable = probeFromHubContainer(spec.port);
  return {
    ...spec,
    hostReachable,
    containerReachable,
    verdict: containerReachable ? 'ok' : 'filtered',
  };
}

export function formatBridgeLines(results: BridgeCheckResult[]): string[] {
  const pad = (label: string) => label.padEnd(28, ' ');
  return results
    .filter((result) => result.verdict !== 'absent')
    .map((result) => {
      const detail =
        result.verdict === 'ok'
          ? `reachable from container (:${result.port})`
          : `BLOCKED — answers on the host but not from the Hub container (:${result.port})`;
      return `  ${pad(result.label)} ${detail}`;
    });
}

/**
 * Run the bridge section for `cihub doctor`.
 *
 * Requires the stack to be up: the checks run from inside the Hub container
 * because that is the only vantage point where a firewalled bridge is visible.
 */
export async function runBridgeDoctorSection(envFileName: string): Promise<BridgeDoctorSection> {
  if (!isHubContainerRunning()) {
    return {
      lines: ['Docker bridge            skipped (Hub container not running — start the stack first)'],
      issueCount: 0,
      remediationCommands: [],
    };
  }

  const services = resolveBridgeServices(envFileName);
  const results: BridgeCheckResult[] = [];
  for (const spec of services) {
    results.push(await checkBridgeService(spec));
  }

  const blocked = results.filter((result) => result.verdict === 'filtered');
  const checked = results.filter((result) => result.verdict !== 'absent');

  if (checked.length === 0) {
    return { lines: ['Docker bridge            no host services listening'], issueCount: 0, remediationCommands: [] };
  }

  const lines = [`Docker bridge            ${blocked.length === 0 ? 'ok' : `${blocked.length} port(s) blocked`}`, ...formatBridgeLines(results)];

  if (blocked.length === 0) {
    return { lines, issueCount: 0, remediationCommands: [] };
  }

  const cidr = resolveHubContainerCidr();
  const gateway = resolveHostGatewayIp();
  const remediationCommands =
    cidr && gateway ? blocked.map((result) => `sudo ufw allow from ${cidr} to ${gateway} port ${result.port} proto tcp`) : [];

  lines.push(
    '  A host firewall is dropping these — the services themselves are running.',
    ...(remediationCommands.length > 0
      ? ['  Run on the host (ufw shown; adapt for firewalld/nftables):', ...remediationCommands.map((command) => `    ${command}`)]
      : ['  Allow the Hub container network to reach the host gateway on these ports.']),
  );

  return { lines, issueCount: blocked.length, remediationCommands };
}
