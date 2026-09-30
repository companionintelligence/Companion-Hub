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
const HUB_CONTAINERS = ['ci-hub', 'ci-os-hub'] as const;

/**
 * Name of the running Hub container, or undefined when there is none.
 *
 * Exported because `pool-diagnostics-cli.ts` needs the same vantage point for its DNS timing: a
 * compose service name resolves inside the container and nowhere else, so a host-side lookup cannot
 * tell a broken URL from an internal one.
 */
export function resolveHubContainerName(): string | undefined {
  return resolveHubContainer();
}

function resolveHubContainer(): string | undefined {
  for (const name of HUB_CONTAINERS) {
    const result = docker(['ps', '--filter', `name=^/${name}$`, '--filter', 'status=running', '--format', '{{.Names}}']);
    if (result.ok && result.stdout.split('\n').includes(name)) return name;
  }
  return undefined;
}
const PROBE_TIMEOUT_MS = 3000;

export interface BridgeServiceSpec {
  label: string;
  port: number;
}

/**
 * - `filtered` — the container's connect expired with no answer: a packet filter dropped it.
 * - `refused`  — an RST came back immediately: the bridge works, the service is bound to
 *   loopback only (Ollama's default) or listening on a different address. A firewall rule
 *   cannot fix this, so it must not be reported as a firewall problem.
 * - `dns`      — `host.docker.internal` did not resolve inside the container.
 */
export type BridgeVerdict = 'ok' | 'filtered' | 'refused' | 'dns' | 'absent' | 'unknown';

/**
 * Exit codes of the injected container probe, mapped back to a verdict.
 *
 * Deliberately above the codes anything else in this path can produce: node
 * exits 1 on an uncaught exception, and `docker exec` itself exits 1 when the
 * daemon rejects the call (a container that stopped between the running-check
 * and the probe, for instance). Reusing 1 here would report those as `filtered`
 * — the one verdict that tells the operator to open a firewall port, for a
 * bridge that was never actually tested.
 */
const PROBE_EXIT_VERDICT: Record<number, BridgeVerdict> = {
  0: 'ok',
  10: 'filtered',
  11: 'refused',
  12: 'dns',
};

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
  /**
   * The subset of `issueCount` that names something broken. `unknown` counts as an issue — the
   * header must not read `ok` when a port went unchecked — but not as a failure: the probe never
   * ran, so there is nothing it proves about the bridge.
   */
  failureCount: number;
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
    // net.Socket#connect throws synchronously on an out-of-range port, which
    // would otherwise reject out of the doctor run and lose the whole report.
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      resolve(false);
      return;
    }
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
 *
 * The exit code carries WHY it failed, not just that it did. A refusal is an
 * instant RST and proves the bridge works, so collapsing it into the timeout
 * case would blame a firewall for a service that is merely bound to loopback.
 */
export function probeFromHubContainer(port: number, timeoutMs = PROBE_TIMEOUT_MS): BridgeVerdict {
  const script =
    `const net=require('net');const s=new net.Socket();s.setTimeout(${timeoutMs});` +
    'const end=c=>{s.destroy();process.exit(c)};' +
    "s.once('connect',()=>end(0));s.once('timeout',()=>end(10));" +
    "s.once('error',e=>end(e.code==='ECONNREFUSED'||e.code==='ECONNRESET'?11:e.code==='ENOTFOUND'||e.code==='EAI_AGAIN'?12:10));" +
    `s.connect(${port},'host.docker.internal');`;
  const hubContainer = resolveHubContainer();
  if (!hubContainer) return 'absent';
  const result = spawnSync('docker', ['exec', hubContainer, 'node', '-e', script], {
    encoding: 'utf8',
    timeout: timeoutMs + 7000,
  });
  // A killed or failed `docker exec` says nothing about the bridge. Any code the
  // probe did not choose for itself (notably 1) falls through to `unknown`
  // rather than being read as a verdict.
  if (result.status === null) return 'unknown';
  return PROBE_EXIT_VERDICT[result.status] ?? 'unknown';
}

export function isHubContainerRunning(): boolean {
  return resolveHubContainer() !== undefined;
}

/**
 * The Hub container's own network in CIDR form — the source range for a firewall rule.
 *
 * Takes the first network; the Hub is attached to exactly one compose network,
 * so that is unambiguous today.
 */
export function resolveHubContainerCidr(): string | undefined {
  let inspectStdout: string | undefined;
  for (const name of HUB_CONTAINERS) {
    const result = docker(['inspect', name, '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}/{{.IPPrefixLen}} {{end}}']);
    if (result.ok && result.stdout.trim()) {
      inspectStdout = result.stdout;
      break;
    }
  }
  if (!inspectStdout) return undefined;

  const [first] = inspectStdout.split(/\s+/).filter(Boolean);
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
    [
      'exec',
      resolveHubContainer() ?? 'ci-hub',
      'node',
      '-e',
      "require('dns').lookup('host.docker.internal',{family:4},(e,a)=>{if(e)process.exit(1);console.log(a)})",
    ],
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
  // parseEnvFile already treats a missing or unreadable file as empty.
  const vars = parseEnvFile(envFileName);
  const port = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
  };
  // Nothing in the Hub dials these engines by default, so they are checked only when their URL is
  // set. Probed at their usual port regardless, they found whatever else listened there, such as
  // Traefik's dashboard on 8080, and reported it as an engine bound to loopback (CI-Hub#1695).
  const ifSet = (label: string, url: string | undefined, fallback: number): BridgeServiceSpec[] =>
    url?.trim() ? [{ label, port: port(portFromUrl(url), fallback) }] : [];

  return [
    { label: 'Hub API (cloudflared origin)', port: port(vars.API_PORT, 5002) },
    { label: 'Ollama', port: port(portFromUrl(vars.OLLAMA_URL), 11434) },
    // Compose hands the Hub a host default for vLLM and Lemonade, so both are dialed even when unset.
    { label: 'vLLM', port: port(portFromUrl(vars.VLLM_URL), 8000) },
    ...ifSet('MTPLX', vars.MTPLX_URL, 8000),
    ...ifSet('Speculative inference', vars.DSPARK_URL, 8080),
    { label: 'Lemonade', port: port(portFromUrl(vars.LEMONADE_URL), 13305) },
    ...ifSet('Speculative inference', vars.SPECULATIVE_INFERENCE_URL, 8000),
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

const VERDICT_DETAIL: Record<BridgeVerdict, (port: number) => string> = {
  ok: (port) => `reachable from container (:${port})`,
  filtered: (port) => `BLOCKED — answers on the host but not from the Hub container (:${port})`,
  // The host probe used 127.0.0.1; a refusal over the bridge means the listener
  // is bound to loopback only, which no firewall rule can fix.
  refused: (port) => `REFUSED — listening on loopback only, not on the host gateway (:${port})`,
  dns: (port) => `UNRESOLVED — host.docker.internal does not resolve in the container (:${port})`,
  unknown: (port) => `unknown — the container probe did not complete (:${port})`,
  absent: (port) => `not listening on the host (:${port})`,
};

export function formatBridgeLines(results: BridgeCheckResult[]): string[] {
  const pad = (label: string) => label.padEnd(28, ' ');
  return results
    .filter((result) => result.verdict !== 'absent')
    .map((result) => `  ${pad(result.label)} ${VERDICT_DETAIL[result.verdict](result.port)}`);
}

/**
 * Run the bridge section for `cihub doctor`.
 *
 * Requires the stack to be up: the checks run from inside the Hub container
 * because that is the only vantage point where a firewalled bridge is visible.
 */
export async function runBridgeDoctorSection(envFileName: string): Promise<BridgeDoctorSection> {
  try {
    return await collectBridgeDoctorSection(envFileName);
  } catch (error) {
    // Match runNetworkDoctorSection: a failed probe degrades to one line rather
    // than taking down the whole `cihub doctor` report.
    const message = error instanceof Error ? error.message : String(error);
    return { lines: [`Docker bridge            unavailable (${message})`], issueCount: 0, failureCount: 0, remediationCommands: [] };
  }
}

async function collectBridgeDoctorSection(envFileName: string): Promise<BridgeDoctorSection> {
  if (!isHubContainerRunning()) {
    return {
      lines: ['Docker bridge            skipped (Hub container not running — start the stack first)'],
      issueCount: 0,
      failureCount: 0,
      remediationCommands: [],
    };
  }

  const services = resolveBridgeServices(envFileName);
  // The host-side probes are independent and each waits out PROBE_TIMEOUT_MS
  // when nothing answers, so run them together rather than serially.
  const hostReachable = await Promise.all(services.map((spec) => probeHostPort(spec.port)));
  const results: BridgeCheckResult[] = services.map((spec, index) => {
    // Nothing is listening on the host, so there is nothing for the container to
    // reach. Reporting this as a firewall problem would be a false alarm.
    if (!hostReachable[index]) return { ...spec, hostReachable: false, containerReachable: false, verdict: 'absent' };
    // spawnSync blocks the event loop, so these stay sequential.
    const verdict = probeFromHubContainer(spec.port);
    return { ...spec, hostReachable: true, containerReachable: verdict === 'ok', verdict };
  });

  const blocked = results.filter((result) => result.verdict === 'filtered');
  const refused = results.filter((result) => result.verdict === 'refused');
  const unresolved = results.filter((result) => result.verdict === 'dns');
  const unverified = results.filter((result) => result.verdict === 'unknown');
  const checked = results.filter((result) => result.verdict !== 'absent');

  if (checked.length === 0) {
    return { lines: ['Docker bridge            no host services listening'], issueCount: 0, failureCount: 0, remediationCommands: [] };
  }

  // `unknown` is not a bridge fault — the probe itself never completed — but the
  // header must not report `ok` when something went unchecked, and the operator
  // should see the warning tone either way.
  const summary = [
    blocked.length > 0 ? `${blocked.length} blocked` : '',
    refused.length > 0 ? `${refused.length} refused` : '',
    unresolved.length > 0 ? `${unresolved.length} unresolved` : '',
    unverified.length > 0 ? `${unverified.length} unverified` : '',
  ].filter(Boolean);
  const failureCount = blocked.length + refused.length + unresolved.length;
  const issueCount = failureCount + unverified.length;
  const lines = [`Docker bridge            ${summary.length === 0 ? 'ok' : summary.join(', ')}`, ...formatBridgeLines(results)];

  if (issueCount === 0) {
    return { lines, issueCount: 0, failureCount: 0, remediationCommands: [] };
  }

  let remediationCommands: string[] = [];
  if (blocked.length > 0) {
    const cidr = resolveHubContainerCidr();
    const gateway = resolveHostGatewayIp();
    remediationCommands = cidr && gateway ? blocked.map((result) => `sudo ufw allow from ${cidr} to ${gateway} port ${result.port} proto tcp`) : [];

    lines.push(
      '  A host firewall is dropping these — the services themselves are running.',
      ...(remediationCommands.length > 0
        ? ['  Run on the host (ufw shown; adapt for firewalld/nftables):', ...remediationCommands.map((command) => `    ${command}`)]
        : ['  Allow the Hub container network to reach the host gateway on these ports.']),
    );
  }

  if (refused.length > 0) {
    lines.push(
      '  These answer on 127.0.0.1 but refuse the host gateway — they are bound to loopback.',
      '  Rebind them to all interfaces (for Ollama: OLLAMA_HOST=0.0.0.0). A firewall rule will not help.',
    );
  }

  if (unresolved.length > 0) {
    lines.push('  host.docker.internal does not resolve in the Hub container — recreate the stack so compose reapplies extra_hosts.');
  }

  if (unverified.length > 0) {
    lines.push('  The container probe did not complete for these, so they were NOT checked — this is not evidence of a firewall.');
  }

  return { lines, issueCount, failureCount, remediationCommands };
}
