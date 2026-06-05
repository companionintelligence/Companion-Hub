import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseEnvFile, upsertEnvVar } from './cihub-cli';
import { isPortAvailable } from './port-availability';

const HUB_STACK_CONTAINERS = new Set(['ci-os-hub', 'ci-hub-db', 'ci-os-hub-queue', 'traefik', 'cloudflared', 'hub-tailscale']);

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
  return isPortAvailable(port) || ourPorts.has(port);
}

function findAvailablePort(start: number, ourPorts: Set<number>): number | undefined {
  for (let port = start; port <= start + 100; port += 1) {
    if (isPortAvailableOrOurs(port, ourPorts)) return port;
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

function shouldRemovePublisher(names: string, status: string, forceTraefik: boolean): boolean {
  const statusLower = status.toLowerCase();
  const isRunning = statusLower.startsWith('up');
  const nameList = names.split(',').map((name) => name.trim());
  const isTraefik = nameList.some((name) => name.toLowerCase() === 'traefik');
  const isOurs = nameList.some((name) => HUB_STACK_CONTAINERS.has(name));

  if (forceTraefik && isTraefik) return true;
  if (isTraefik && !isRunning) return true;
  if (isOurs && !isRunning) return true;
  if (!isRunning) return true;
  return false;
}

export function releaseStalePortPublishers(port: number, options: { forceTraefik?: boolean; log?: (message: string) => void } = {}): void {
  const { forceTraefik = false, log = noopLog } = options;
  const listed = docker(['ps', '-a', '--format', '{{.ID}}\t{{.Names}}\t{{.Status}}', '--filter', `publish=${port}`]);
  if (!listed.ok || !listed.out) return;

  for (const line of listed.out.split('\n')) {
    const [id, names, status] = line.split('\t');
    if (!id || !names || !status) continue;
    if (!shouldRemovePublisher(names, status, forceTraefik)) continue;

    log(`Removing container ${id} (${names}, ${status}) to release host port ${port}.`);
    docker(['rm', '-f', id]);
  }
}

function upsertEnvPorts(envFilePath: string, assignments: Record<string, number>): void {
  for (const [key, value] of Object.entries(assignments)) {
    upsertEnvVar(envFilePath, key, String(value));
  }
}

export interface PortHealResult {
  assignments: Record<string, number>;
  info: string[];
}

export function resolveHubPorts(envFilePath: string): PortHealResult {
  const existing = readFileSync(envFilePath, 'utf-8');
  const parsed = parseEnvFile(envFilePath);
  const ourPorts = getOurRunningContainerPorts();
  const assignments: Record<string, number> = {};
  const info: string[] = [];

  for (const { defaultPort, var: varName, fallbackStart } of FIXED_PORTS) {
    const current = Number(parsed[varName] || defaultPort);
    if (isPortAvailableOrOurs(current, ourPorts)) {
      assignments[varName] = current;
      continue;
    }
    if (isPortAvailableOrOurs(defaultPort, ourPorts)) {
      if (current !== defaultPort) {
        info.push(`Port ${current} (${varName}) now free — restored default host port ${defaultPort}.`);
      }
      assignments[varName] = defaultPort;
      continue;
    }
    const reassigned = findAvailablePort(fallbackStart, ourPorts);
    if (reassigned === undefined) {
      throw new Error(`Cannot find available host port near ${fallbackStart} for ${varName} (${defaultPort} is occupied).`);
    }
    info.push(
      `Port ${current === defaultPort ? defaultPort : current} (${varName}) occupied — using host port ${reassigned} (Public Web via Cloudflare is unaffected).`,
    );
    assignments[varName] = reassigned;
  }

  for (const { defaultPort, var: varName } of DYNAMIC_PORTS) {
    const current = Number(parsed[varName] || defaultPort);
    if (isPortAvailableOrOurs(current, ourPorts)) {
      assignments[varName] = current;
      continue;
    }
    const reassigned = findAvailablePort(defaultPort, ourPorts);
    if (reassigned === undefined) {
      throw new Error(`Cannot find available host port near ${defaultPort} for ${varName}.`);
    }
    info.push(`Port ${current} (${varName}) occupied — reassigned to ${reassigned}.`);
    assignments[varName] = reassigned;
  }

  const changed = [...FIXED_PORTS, ...DYNAMIC_PORTS].some(({ var: varName, defaultPort }) => {
    const previous = Number(parsed[varName] || defaultPort);
    return assignments[varName] !== previous;
  });

  if (changed || !existing.includes('HTTP_PORT=')) {
    upsertEnvPorts(envFilePath, assignments);
  }

  return { assignments, info };
}

export function healHubPortsBeforeStartup(envFilePath: string, log: (message: string) => void = noopLog): PortHealResult {
  for (const port of [80, 443]) {
    releaseStalePortPublishers(port, { log });
  }
  return resolveHubPorts(envFilePath);
}

export function healHubPortBindConflict(envFilePath: string, errorOutput: string, log: (message: string) => void = noopLog): PortHealResult {
  const conflictPort = parseBindConflictPort(errorOutput);
  const ports = conflictPort ? [conflictPort] : [80, 443];
  for (const port of ports) {
    releaseStalePortPublishers(port, { forceTraefik: true, log });
  }
  return resolveHubPorts(envFilePath);
}
