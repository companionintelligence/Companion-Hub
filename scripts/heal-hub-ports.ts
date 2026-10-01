import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnvFile, upsertEnvVar } from './cihub-cli';
import { hostPortState, isPortAvailable } from './port-availability';

const HUB_STACK_CONTAINERS = new Set([
  'ci-hub',
  'ci-os-hub',
  'ci-hub-db',
  'ci-hub-queue',
  'ci-os-hub-queue',
  'traefik',
  'cloudflared',
  'hub-tailscale',
]);

function noopLog(_message: string): void {
  // Optional logging callback when none is provided.
}

const FIXED_PORTS: Array<{ defaultPort: number; var: string; fallbackStart: number }> = [
  { defaultPort: 80, var: 'HTTP_PORT', fallbackStart: 8880 },
  { defaultPort: 443, var: 'HTTPS_PORT', fallbackStart: 8443 },
];

const DYNAMIC_PORTS: Array<{ defaultPort: number; var: string }> = [
  { defaultPort: 5002, var: 'API_PORT' },
  { defaultPort: 6543, var: 'POSTGRES_PORT' },
  { defaultPort: 5001, var: 'RABBITMQ_PORT' },
  { defaultPort: 8080, var: 'TRAEFIK_DASHBOARD_PORT' },
];

/**
 * The port an env file configures for `varName`, or `defaultPort` when the value is not a TCP
 * port. `Number(parsed[varName] || defaultPort)` was the previous reading, and it let a mangled
 * line through: `TRAEFIK_DASHBOARD_PORT=8080LEMONADE_URL=http://…` (a key appended to a file
 * with no trailing newline) became `NaN`, `isPortAvailable(NaN)` said yes — a bind to port NaN
 * is a bind to port 0 — and `NaN` was written straight back into the env file, where compose
 * refused it with `invalid hostPort: NaN` and the whole stack stayed down until someone edited
 * the file by hand. Two fleet nodes, 2026-09-20.
 */
export function configuredPort(parsed: Record<string, string>, varName: string, defaultPort: number): number {
  const raw = parsed[varName]?.trim();
  if (!raw) return defaultPort;
  if (!/^\d{1,5}$/.test(raw)) return defaultPort;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : defaultPort;
}

function docker(args: string[]): { ok: boolean; out: string; err: string } {
  const result = spawnSync('docker', args, { encoding: 'utf-8' });
  return {
    ok: result.status === 0,
    out: (result.stdout || '').trim(),
    err: (result.stderr || '').trim(),
  };
}

function getOurRunningContainerPorts(): Set<number> {
  const ports = new Set<number>();
  const filters = [...HUB_STACK_CONTAINERS].flatMap((name) => ['--filter', `name=${name}`, '--filter', 'status=running']);
  const result = docker(['ps', '--format', '{{.Ports}}', ...filters]);
  if (!result.ok) return ports;

  for (const line of result.out.split('\n')) {
    for (const mapping of line.split(',')) {
      const trimmed = mapping.trim();
      const arrowPos = trimmed.indexOf('->');
      if (arrowPos === -1) continue;
      const hostPart = trimmed.slice(0, arrowPos);
      const colonPos = hostPart.lastIndexOf(':');
      if (colonPos === -1) continue;
      const port = Number(hostPart.slice(colonPos + 1));
      if (Number.isFinite(port)) ports.add(port);
    }
  }
  return ports;
}

function isPortAvailableOrOurs(port: number, ourPorts: Set<number>): boolean {
  return ourPorts.has(port) || isPortAvailable(port);
}

function canAssignPort(port: number, ourPorts: Set<number>, assignedPorts: Set<number>): boolean {
  return !assignedPorts.has(port) && isPortAvailableOrOurs(port, ourPorts);
}

function findAvailablePort(start: number, ourPorts: Set<number>, assignedPorts: Set<number>): number | undefined {
  for (let port = start; port <= start + 100; port += 1) {
    if (canAssignPort(port, ourPorts, assignedPorts)) return port;
  }
  return undefined;
}

export function parseBindConflictPort(output: string): number | undefined {
  for (const token of output.split(/\s+/)) {
    for (const prefix of ['0.0.0.0:', '[::]:']) {
      if (token.startsWith(prefix)) {
        const port = Number(token.slice(prefix.length).replace(/[^\d].*$/, ''));
        if (Number.isFinite(port)) return port;
      }
    }
  }
  const lower = output.toLowerCase();
  if (lower.includes(':80') || lower.includes('port 80')) return 80;
  if (lower.includes(':443') || lower.includes('port 443')) return 443;
  return undefined;
}

function shouldRemovePublisher(names: string, status: string, options: { forceTraefik?: boolean; forceHubStack?: boolean }): boolean {
  const { forceTraefik = false, forceHubStack = false } = options;
  const statusLower = status.toLowerCase();
  const isRunning = statusLower.startsWith('up');
  const nameList = names.split(',').map((name) => name.trim());
  const isTraefik = nameList.some((name) => name.toLowerCase() === 'traefik');
  const isOurs = nameList.some((name) => HUB_STACK_CONTAINERS.has(name));

  if (forceHubStack && isOurs) return true;
  if (forceTraefik && isTraefik) return true;
  if (isTraefik && !isRunning) return true;
  if (isOurs && !isRunning) return true;
  if (!isRunning) return true;
  return false;
}

function hasExactHubStackName(names: string): boolean {
  return names.split(',').some((name) => HUB_STACK_CONTAINERS.has(name.trim()));
}

export function releaseStalePortPublishers(
  port: number,
  options: { forceTraefik?: boolean; forceHubStack?: boolean; log?: (message: string) => void } = {},
): void {
  const { forceTraefik = false, forceHubStack = false, log = noopLog } = options;
  const listed = docker(['ps', '-a', '--format', '{{.ID}}\t{{.Names}}\t{{.Status}}', '--filter', `publish=${port}`]);
  if (!listed.ok || !listed.out) return;

  for (const line of listed.out.split('\n')) {
    const [id, names, status] = line.split('\t');
    if (!id || !names || !status) continue;
    if (!shouldRemovePublisher(names, status, { forceTraefik, forceHubStack })) continue;

    log(`Removing container ${id} (${names}, ${status}) to release host port ${port}.`);
    docker(['rm', '-f', id]);
  }
}

function configuredPortsFromEnv(envFilePath: string): number[] {
  const parsed = parseEnvFile(envFilePath);
  const ports = new Set<number>();

  for (const { defaultPort, var: varName, fallbackStart } of FIXED_PORTS) {
    ports.add(configuredPort(parsed, varName, defaultPort));
    ports.add(defaultPort);
    ports.add(fallbackStart);
  }
  for (const { defaultPort, var: varName } of DYNAMIC_PORTS) {
    ports.add(configuredPort(parsed, varName, defaultPort));
    ports.add(defaultPort);
  }

  return [...ports];
}

/** Stop any running Hub stack containers before a fresh `cihub up`. */
export function stopRunningHubStack(log: (message: string) => void = noopLog): void {
  const filters = [...HUB_STACK_CONTAINERS].flatMap((name) => ['--filter', `name=${name}`, '--filter', 'status=running']);
  const result = docker(['ps', '--format', '{{.ID}}\t{{.Names}}', ...filters]);
  if (!result.ok || !result.out) return;

  for (const line of result.out.split('\n')) {
    const [id, names] = line.split('\t');
    if (!id?.trim()) continue;
    if (!hasExactHubStackName(names ?? '')) continue;
    log(`Stopping previous Hub container ${id.trim()} (${names?.trim() || 'unknown'}).`);
    docker(['rm', '-f', id.trim()]);
  }
}

function upsertEnvPorts(envFilePath: string, assignments: Record<string, number>): void {
  for (const [key, value] of Object.entries(assignments)) {
    upsertEnvVar(envFilePath, key, String(value));
  }
}

function noteInvalidPort(parsed: Record<string, string>, varName: string, resolved: number, info: string[]): void {
  const raw = parsed[varName]?.trim();
  if (raw && raw !== String(resolved)) {
    info.push(`${varName}=${raw} is not a TCP port — using ${resolved}. Check the env file for a line that lost its newline.`);
  }
}

/** A rootless engine cannot publish a privileged port even when nothing holds it, so say which it was. */
function whyPortMoved(port: number, varName: string): string {
  return hostPortState(port) === 'rootless-privileged'
    ? `Rootless Docker cannot publish privileged port ${port} (${varName})`
    : `Port ${port} (${varName}) occupied`;
}

export interface PortHealResult {
  assignments: Record<string, number>;
  info: string[];
}

export function resolveHubPorts(envFilePath: string): PortHealResult {
  // A brand-new environment (`cihub up <env>` before any env file was ever written) has no file
  // here yet. Tolerate that the same way parseEnvFile below does, instead of crashing with a raw
  // ENOENT — upsertEnvPorts (via upsertEnvVar) creates the file on its first write.
  const existing = existsSync(envFilePath) ? readFileSync(envFilePath, 'utf-8') : '';
  const parsed = parseEnvFile(envFilePath);
  const ourPorts = getOurRunningContainerPorts();
  const assignedPorts = new Set<number>();
  const assignments: Record<string, number> = {};
  const info: string[] = [];

  for (const { defaultPort, var: varName, fallbackStart } of FIXED_PORTS) {
    const current = configuredPort(parsed, varName, defaultPort);
    noteInvalidPort(parsed, varName, current, info);
    if (canAssignPort(current, ourPorts, assignedPorts)) {
      assignments[varName] = current;
      assignedPorts.add(current);
      continue;
    }
    if (canAssignPort(defaultPort, ourPorts, assignedPorts)) {
      if (current !== defaultPort) {
        info.push(`Port ${current} (${varName}) occupied — restored default host port ${defaultPort}.`);
      }
      assignments[varName] = defaultPort;
      assignedPorts.add(defaultPort);
      continue;
    }
    const reassigned = findAvailablePort(fallbackStart, ourPorts, assignedPorts);
    if (reassigned === undefined) {
      throw new Error(`Cannot find available host port near ${fallbackStart} for ${varName} (${defaultPort} is unavailable).`);
    }
    info.push(`${whyPortMoved(current, varName)} — using host port ${reassigned} (Public Web via Cloudflare is unaffected).`);
    assignments[varName] = reassigned;
    assignedPorts.add(reassigned);
  }

  for (const { defaultPort, var: varName } of DYNAMIC_PORTS) {
    const current = configuredPort(parsed, varName, defaultPort);
    noteInvalidPort(parsed, varName, current, info);
    if (canAssignPort(current, ourPorts, assignedPorts)) {
      assignments[varName] = current;
      assignedPorts.add(current);
      continue;
    }
    const reassigned = findAvailablePort(defaultPort, ourPorts, assignedPorts);
    if (reassigned === undefined) {
      throw new Error(`Cannot find available host port near ${defaultPort} for ${varName}.`);
    }
    info.push(`Port ${current} (${varName}) occupied — reassigned to ${reassigned}.`);
    assignments[varName] = reassigned;
    assignedPorts.add(reassigned);
  }

  // An invalid value counts as changed even when it resolves to the default: the file still
  // holds the garbage, and the whole point is to write a port compose will accept over it.
  const changed = [...FIXED_PORTS, ...DYNAMIC_PORTS].some(({ var: varName, defaultPort }) => {
    const raw = parsed[varName]?.trim();
    if (raw && String(configuredPort(parsed, varName, defaultPort)) !== raw) return true;
    return assignments[varName] !== configuredPort(parsed, varName, defaultPort);
  });

  if (changed || !existing.includes('HTTP_PORT=')) {
    upsertEnvPorts(envFilePath, assignments);
  }

  return { assignments, info };
}

export function healHubPortsBeforeStartup(envFilePath: string, log: (message: string) => void = noopLog): PortHealResult {
  stopRunningHubStack(log);
  for (const port of configuredPortsFromEnv(envFilePath)) {
    releaseStalePortPublishers(port, { forceHubStack: true, log });
  }
  for (const port of [80, 443]) {
    releaseStalePortPublishers(port, { log });
  }
  return resolveHubPorts(envFilePath);
}

export function healHubPortBindConflict(envFilePath: string, errorOutput: string, log: (message: string) => void = noopLog): PortHealResult {
  stopRunningHubStack(log);
  const conflictPort = parseBindConflictPort(errorOutput);
  const ports = new Set<number>(conflictPort ? [conflictPort] : [80, 443]);
  for (const port of configuredPortsFromEnv(envFilePath)) {
    ports.add(port);
  }
  for (const port of ports) {
    releaseStalePortPublishers(port, { forceTraefik: true, forceHubStack: true, log });
  }
  return resolveHubPorts(envFilePath);
}
