/**
 * Cross-platform Docker engine pin shared with the desktop app
 * (`packages/desktop/src-tauri/src/docker_engine.rs`).
 *
 * Reads/writes `{dataDir}/state/docker-engine.json` so `cihub` and the desktop
 * shell cannot diverge. Selection rules: affinity to an existing Hub stack,
 * else prefer Docker Desktop, else platform fallback.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveCanonicalDataDir } from './paths';

export const DOCKER_ENGINE_STATE_FILENAME = 'docker-engine.json';
export const DOCKER_CONTEXT_WSL_ENGINE = 'wsl-engine';

export type DockerEngineKind = 'desktop' | 'system' | 'wsl-engine' | 'rootless' | 'other';

export type PinnedDockerEngine = {
  dockerHost: string;
  kind: DockerEngineKind;
  contextName?: string;
  reason: string;
  selectedAt: number;
  /** Windows bind-mount style paired with the pinned engine. */
  pathStyle?: 'drive' | 'wsl-mnt';
};

export type DockerEngineCandidate = {
  label: string;
  dockerHost: string;
  kind: DockerEngineKind;
  contextName?: string;
};

export type ReachableEngine = {
  candidate: DockerEngineCandidate;
  hasHubIdentity: boolean;
  hubHostPorts: string[];
};

const HUB_IDENTITY_CONTAINERS = ['ci-hub-db', 'ci-os-hub'] as const;
const HUB_IDENTITY_NETWORK = 'ci-os-hub_network';
const HUB_IDENTITY_VOLUME = 'ci_hub_pgdata';
const HUB_HOST_PORTS = ['6543', '5002', '80', '443'] as const;

let processPin: PinnedDockerEngine | null = null;

export function dockerEngineStatePath(dataDir: string): string {
  return path.join(dataDir, 'state', DOCKER_ENGINE_STATE_FILENAME);
}

export function clearProcessDockerEnginePin(): void {
  processPin = null;
}

export function getProcessDockerEnginePin(): PinnedDockerEngine | null {
  return processPin;
}

export function pinDockerEngine(engine: PinnedDockerEngine): void {
  processPin = engine;
}

function explicitDockerHostOverride(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const key of ['CI_HUB_DOCKER_HOST', 'DOCKER_HOST']) {
    const value = (env[key] ?? '').trim();
    if (value.length > 0) return value;
  }
  return null;
}

function pathStyleForKind(kind: DockerEngineKind): 'drive' | 'wsl-mnt' | undefined {
  if (kind === 'desktop') return 'drive';
  if (kind === 'wsl-engine') return 'wsl-mnt';
  return undefined;
}

function kindFromContextName(contextName: string): DockerEngineKind {
  if (contextName === 'desktop-linux' || contextName === 'desktop-windows') return 'desktop';
  if (contextName === DOCKER_CONTEXT_WSL_ENGINE) return 'wsl-engine';
  return 'other';
}

function labelFor(kind: DockerEngineKind, contextName: string | undefined, host: string): string {
  switch (kind) {
    case 'desktop':
      return 'Docker Desktop';
    case 'system':
      return 'system Docker Engine';
    case 'wsl-engine':
      return 'WSL Engine';
    case 'rootless':
      return 'rootless Docker Engine';
    default:
      return contextName ? `Docker context \`${contextName}\`` : `Docker at ${host}`;
  }
}

function runDocker(
  args: string[],
  dockerHost?: string,
  env: NodeJS.ProcessEnv = process.env,
): { status: number | null; stdout: string; stderr: string } {
  const nextEnv = { ...env };
  if (dockerHost) {
    nextEnv.DOCKER_HOST = dockerHost;
    delete nextEnv.DOCKER_CONTEXT;
  }
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    env: nextEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
  });
  return {
    status: result.status,
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
  };
}

export function probeDockerHostReachable(dockerHost: string, env?: NodeJS.ProcessEnv): boolean {
  const result = runDocker(['info', '--format', '{{.ServerVersion}}'], dockerHost, env);
  return result.status === 0;
}

export function engineHasHubIdentity(dockerHost: string, env?: NodeJS.ProcessEnv): boolean {
  for (const name of HUB_IDENTITY_CONTAINERS) {
    const result = runDocker(['ps', '-aq', '--filter', `name=^${name}$`], dockerHost, env);
    if (result.status === 0 && result.stdout.trim().length > 0) return true;
  }
  const network = runDocker(['network', 'ls', '-q', '--filter', `name=^${HUB_IDENTITY_NETWORK}$`], dockerHost, env);
  if (network.status === 0 && network.stdout.trim().length > 0) return true;
  const volume = runDocker(['volume', 'ls', '-q', '--filter', `name=^${HUB_IDENTITY_VOLUME}$`], dockerHost, env);
  return volume.status === 0 && volume.stdout.trim().length > 0;
}

export function engineHubHostPorts(dockerHost: string, env?: NodeJS.ProcessEnv): string[] {
  const result = runDocker(['ps', '--format', '{{.Ports}}', '--filter', 'status=running'], dockerHost, env);
  if (result.status !== 0) return [];
  const owned: string[] = [];
  for (const port of HUB_HOST_PORTS) {
    const patterns = [`0.0.0.0:${port}->`, `:::${port}->`, `*:${port}->`, `127.0.0.1:${port}->`];
    if (result.stdout.split('\n').some((line) => patterns.some((p) => line.includes(p)))) {
      owned.push(port);
    }
  }
  return owned;
}

export function dockerContextHostFromInspectOutput(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as Array<{
      Endpoints?: { docker?: { Host?: string } };
    }>;
    const host = parsed[0]?.Endpoints?.docker?.Host?.trim();
    return host && host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

export function currentDockerContextName(hostDockerDir?: string, _env: NodeJS.ProcessEnv = process.env): string | null {
  const dockerDir = hostDockerDir ?? path.join(os.homedir(), '.docker');
  try {
    const raw = readFileSync(path.join(dockerDir, 'config.json'), 'utf8');
    const parsed = JSON.parse(raw) as { currentContext?: unknown };
    const contextName = typeof parsed.currentContext === 'string' ? parsed.currentContext.trim() : '';
    if (!contextName || contextName === 'default') return null;
    return contextName;
  } catch {
    return null;
  }
}

function inspectContextHost(contextName: string, env?: NodeJS.ProcessEnv): string | null {
  const result = runDocker(['context', 'inspect', contextName], undefined, env);
  if (result.status !== 0) return null;
  return dockerContextHostFromInspectOutput(result.stdout);
}

function pushUnique(out: DockerEngineCandidate[], candidate: DockerEngineCandidate): void {
  if (out.some((existing) => existing.dockerHost === candidate.dockerHost)) return;
  out.push(candidate);
}

function candidateFromUnixSocket(socket: string, kind: DockerEngineKind, contextName?: string): DockerEngineCandidate | null {
  if (!existsSync(socket)) return null;
  const dockerHost = `unix://${socket}`;
  return {
    label: labelFor(kind, contextName, dockerHost),
    dockerHost,
    kind,
    contextName,
  };
}

export function enumerateDockerEngineCandidates(
  platform: NodeJS.Platform = process.platform,
  hostDockerDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): DockerEngineCandidate[] {
  const out: DockerEngineCandidate[] = [];
  const home = os.homedir();

  if (platform === 'linux') {
    const current = currentDockerContextName(hostDockerDir, env);
    if (current) {
      const host = inspectContextHost(current, env);
      if (host) {
        const kind = kindFromContextName(current);
        pushUnique(out, {
          label: labelFor(kind, current, host),
          dockerHost: host,
          kind,
          contextName: current,
        });
      }
    }
    for (const [rel, kind, ctx] of [
      [path.join(home, '.docker', 'desktop', 'docker.sock'), 'desktop', 'desktop-linux'],
      [path.join(home, '.docker', 'run', 'docker.sock'), 'desktop', undefined],
    ] as const) {
      const candidate = candidateFromUnixSocket(rel, kind, ctx);
      if (candidate) pushUnique(out, candidate);
    }
    const system = candidateFromUnixSocket('/var/run/docker.sock', 'system');
    if (system) pushUnique(out, system);

    const rootless: string[] = [];
    if (env.XDG_RUNTIME_DIR) rootless.push(path.join(env.XDG_RUNTIME_DIR, 'docker.sock'));
    if (typeof process.getuid === 'function') {
      rootless.push(`/run/user/${process.getuid()}/docker.sock`);
    }
    for (const socket of rootless) {
      const candidate = candidateFromUnixSocket(socket, 'rootless');
      if (candidate) pushUnique(out, candidate);
    }
    return out;
  }

  if (platform === 'win32') {
    const names = ['desktop-linux', 'desktop-windows', DOCKER_CONTEXT_WSL_ENGINE];
    const current = currentDockerContextName(hostDockerDir, env);
    if (current && !names.includes(current)) names.push(current);
    for (const contextName of names) {
      const host = inspectContextHost(contextName, env);
      if (!host) continue;
      const kind = kindFromContextName(contextName);
      pushUnique(out, {
        label: labelFor(kind, contextName, host),
        dockerHost: host,
        kind,
        contextName,
      });
    }
    pushUnique(out, {
      label: 'Docker Desktop',
      dockerHost: 'npipe:////./pipe/docker_engine',
      kind: 'desktop',
      contextName: 'desktop-linux',
    });
    return out;
  }

  if (platform === 'darwin') {
    const desktop = candidateFromUnixSocket(path.join(home, '.docker', 'run', 'docker.sock'), 'desktop', 'desktop-linux');
    if (desktop) pushUnique(out, desktop);
    const current = currentDockerContextName(hostDockerDir, env);
    if (current) {
      const host = inspectContextHost(current, env);
      if (host) {
        const kind = kindFromContextName(current);
        pushUnique(out, {
          label: labelFor(kind, current, host),
          dockerHost: host,
          kind,
          contextName: current,
        });
      }
    }
    const contexts = runDocker(['context', 'ls', '--format', '{{.Name}}'], undefined, env);
    if (contexts.status === 0) {
      for (const name of contexts.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)) {
        if (name === 'default') continue;
        if (out.some((c) => c.contextName === name)) continue;
        const host = inspectContextHost(name, env);
        if (!host) continue;
        const kind = kindFromContextName(name);
        pushUnique(out, {
          label: labelFor(kind, name, host),
          dockerHost: host,
          kind,
          contextName: name,
        });
      }
    }
  }

  return out;
}

export function probeReachableEngines(candidates: DockerEngineCandidate[], env?: NodeJS.ProcessEnv): ReachableEngine[] {
  const reachable: ReachableEngine[] = [];
  for (const candidate of candidates) {
    if (!probeDockerHostReachable(candidate.dockerHost, env)) continue;
    const hasHubIdentity = engineHasHubIdentity(candidate.dockerHost, env);
    reachable.push({
      candidate,
      hasHubIdentity,
      hubHostPorts: engineHubHostPorts(candidate.dockerHost, env),
    });
  }
  return reachable;
}

/** Pure selection among already-probed engines (unit-tested). */
export function selectDockerEngine(reachable: ReachableEngine[], explicitHost: string | null): { candidate: DockerEngineCandidate; reason: string } {
  if (explicitHost) {
    const match = reachable.find((e) => e.candidate.dockerHost === explicitHost);
    if (match) {
      return {
        candidate: match.candidate,
        reason: `explicit override DOCKER_HOST/CI_HUB_DOCKER_HOST=${explicitHost}`,
      };
    }
    return {
      candidate: {
        label: `explicit Docker host ${explicitHost}`,
        dockerHost: explicitHost,
        kind: 'other',
      },
      reason: `explicit override DOCKER_HOST/CI_HUB_DOCKER_HOST=${explicitHost}`,
    };
  }

  if (reachable.length === 0) {
    throw new Error('No reachable Docker engine found. Start Docker Desktop (or your Docker Engine) and try again.');
  }

  const withStack = reachable.filter((e) => e.hasHubIdentity);
  if (withStack.length === 1) {
    const engine = withStack[0];
    if (!engine) {
      throw new Error('No reachable Docker engine found. Start Docker Desktop (or your Docker Engine) and try again.');
    }
    return {
      candidate: engine.candidate,
      reason: `affinity: Hub stack already on ${engine.candidate.label} (${engine.candidate.dockerHost})`,
    };
  }
  if (withStack.length > 1) {
    const desktop = withStack.find((e) => e.candidate.kind === 'desktop');
    const engine = desktop ?? withStack[0];
    if (!engine) {
      throw new Error('No reachable Docker engine found. Start Docker Desktop (or your Docker Engine) and try again.');
    }
    return {
      candidate: engine.candidate,
      reason: desktop
        ? `multiple engines have Hub identity; preferring Desktop among them (${engine.candidate.dockerHost})`
        : `multiple engines have Hub identity; using ${engine.candidate.label} (${engine.candidate.dockerHost})`,
    };
  }

  const desktop = reachable.find((e) => e.candidate.kind === 'desktop');
  if (desktop) {
    return {
      candidate: desktop.candidate,
      reason: `fresh install: prefer Docker Desktop at ${desktop.candidate.dockerHost}`,
    };
  }
  const engine = reachable[0];
  if (!engine) {
    throw new Error('No reachable Docker engine found. Start Docker Desktop (or your Docker Engine) and try again.');
  }
  return {
    candidate: engine.candidate,
    reason: `fresh install: platform fallback ${engine.candidate.label} (${engine.candidate.dockerHost})`,
  };
}

export function loadPersistedDockerEngine(dataDir: string): PinnedDockerEngine | null {
  try {
    const raw = readFileSync(dockerEngineStatePath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<PinnedDockerEngine> & {
      docker_host?: string;
      context_name?: string;
      selected_at?: number;
      path_style?: string;
    };
    // Accept camelCase (TS/Rust serde rename) and snake_case just in case.
    const dockerHost = parsed.dockerHost ?? parsed.docker_host;
    const kind = parsed.kind;
    if (!dockerHost || !kind) return null;
    return {
      dockerHost,
      kind,
      contextName: parsed.contextName ?? parsed.context_name,
      reason: parsed.reason ?? '',
      selectedAt: parsed.selectedAt ?? parsed.selected_at ?? 0,
      pathStyle: (parsed.pathStyle ?? parsed.path_style) as PinnedDockerEngine['pathStyle'],
    };
  } catch {
    return null;
  }
}

export function persistDockerEngine(dataDir: string, engine: PinnedDockerEngine): void {
  const statePath = dockerEngineStatePath(dataDir);
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(engine, null, 2)}\n`, 'utf8');
}

export function resolveHubDockerEngine(options?: {
  dataDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  hostDockerDir?: string;
}): PinnedDockerEngine {
  const env = options?.env ?? process.env;
  const dataDir = options?.dataDir ?? resolveCanonicalDataDir(env);
  const platform = options?.platform ?? process.platform;
  const explicit = explicitDockerHostOverride(env);
  const candidates = enumerateDockerEngineCandidates(platform, options?.hostDockerDir, env);
  const reachable = probeReachableEngines(candidates, env);
  const { candidate, reason } = selectDockerEngine(reachable, explicit);
  const engine: PinnedDockerEngine = {
    dockerHost: candidate.dockerHost,
    kind: candidate.kind,
    contextName: candidate.contextName,
    reason,
    selectedAt: Math.floor(Date.now() / 1000),
    pathStyle: pathStyleForKind(candidate.kind),
  };
  persistDockerEngine(dataDir, engine);
  return engine;
}

export function resolveAndPinHubDockerEngine(options?: {
  dataDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}): PinnedDockerEngine {
  const engine = resolveHubDockerEngine(options);
  pinDockerEngine(engine);
  return engine;
}

/**
 * Effective DOCKER_HOST for CLI docker subprocesses.
 * Order: process pin → env override → full resolve/pin (affinity).
 */
export function effectiveDockerHost(options?: { dataDir?: string; env?: NodeJS.ProcessEnv; resolveIfMissing?: boolean }): string | null {
  const env = options?.env ?? process.env;
  if (processPin) return processPin.dockerHost;
  const explicit = explicitDockerHostOverride(env);
  if (explicit) return explicit;

  if (options?.resolveIfMissing === false) {
    const dataDir = options?.dataDir ?? resolveCanonicalDataDir(env);
    return loadPersistedDockerEngine(dataDir)?.dockerHost ?? null;
  }

  const dataDir = options?.dataDir ?? resolveCanonicalDataDir(env);
  try {
    const engine = resolveAndPinHubDockerEngine({ dataDir, env });
    return engine.dockerHost;
  } catch {
    return loadPersistedDockerEngine(dataDir)?.dockerHost ?? null;
  }
}

/** Env overlay so spawnSync('docker', ...) uses the pinned Hub engine. */
export function dockerEnvWithPinnedHost(baseEnv: NodeJS.ProcessEnv = process.env, options?: { dataDir?: string }): NodeJS.ProcessEnv {
  const host = effectiveDockerHost({ dataDir: options?.dataDir, env: baseEnv });
  if (!host) return { ...baseEnv };
  const next = { ...baseEnv, DOCKER_HOST: host };
  delete next.DOCKER_CONTEXT;
  return next;
}

export function pinnedPathStyle(options?: { dataDir?: string; env?: NodeJS.ProcessEnv }): 'drive' | 'wsl-mnt' | null {
  if (processPin?.pathStyle) return processPin.pathStyle;
  const dataDir = options?.dataDir ?? resolveCanonicalDataDir(options?.env);
  return loadPersistedDockerEngine(dataDir)?.pathStyle ?? null;
}

export function splitBrainConflict(selected: PinnedDockerEngine, reachable: ReachableEngine[]): string | null {
  const selectedHasIdentity = reachable.find((e) => e.candidate.dockerHost === selected.dockerHost)?.hasHubIdentity ?? false;
  if (selectedHasIdentity) return null;

  for (const engine of reachable) {
    if (engine.candidate.dockerHost === selected.dockerHost) continue;
    if (engine.hasHubIdentity) {
      return (
        `Hub stack is on ${engine.candidate.label} (${engine.candidate.dockerHost}) but ` +
        `${labelFor(selected.kind, selected.contextName, selected.dockerHost)} (${selected.dockerHost}) is selected. ` +
        `Hub will not start a second stack (host ports ${HUB_HOST_PORTS.join('/')}). ` +
        "Set CI_HUB_DOCKER_HOST to the stack's engine, or remove the other stack."
      );
    }
    if (engine.hubHostPorts.length > 0) {
      return (
        `Host port(s) ${engine.hubHostPorts.join(', ')} are already published on ` +
        `${engine.candidate.label} (${engine.candidate.dockerHost}), but Hub selected ` +
        `${labelFor(selected.kind, selected.contextName, selected.dockerHost)} (${selected.dockerHost}). ` +
        'Stop the conflicting containers or set CI_HUB_DOCKER_HOST to that engine.'
      );
    }
  }
  return null;
}
