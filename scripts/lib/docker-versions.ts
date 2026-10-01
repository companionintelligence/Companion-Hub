/**
 * The oldest Docker the Hub's stack file runs on, checked before `cihub up` starts the stack.
 *
 * `gw_priority` in docker-compose.prod.yml, which keeps the Hub's own traffic on ci-hub_network,
 * is new in Compose 2.33 and Engine 28. An older Compose refuses the whole file ("Additional
 * property gw_priority is not allowed"), and nothing in that error says Docker is too old. The
 * desktop app runs the same check (packages/desktop/src-tauri/src/hub_manager/docker_versions.rs).
 */
import { spawnSync } from 'node:child_process';
import { colorize, printMessageBox } from './cli-ui.js';

type DockerVersion = [major: number, minor: number, patch: number];

const MIN_DOCKER_COMPOSE_VERSION: DockerVersion = [2, 33, 0];
const MIN_DOCKER_ENGINE_VERSION: DockerVersion = [28, 0, 0];

/** What this computer reports for `docker compose version --short` and the engine, as printed; null when unreadable. */
export type DockerVersions = { compose: string | null; engine: string | null };

/**
 * The first `major.minor[.patch]` in what Docker printed, so a leading `v` (`v2.33.0`), a build
 * suffix (`2.40.3-desktop.1`) or a distribution's tag (`28.2.2-0ubuntu1`) does not hide it.
 */
export function parseDockerVersion(raw: string | null | undefined): DockerVersion | null {
  const match = /([0-9]+)\.([0-9]+)(?:\.([0-9]+))?/.exec(raw ?? '');
  if (!match) return null;
  const fields = [match[1], match[2], match[3] ?? '0'].map(Number);
  return fields.every(Number.isSafeInteger) ? (fields as DockerVersion) : null;
}

/** Negative when `a` is older than `b`, zero when they match, positive when `a` is newer. */
export function compareDockerVersions(a: DockerVersion, b: DockerVersion): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * What to tell someone whose Compose or engine is older than the stack file needs, one sentence per
 * line, naming what this computer has: the desktop app's message, word for word. Null when both are
 * new enough, and for a version that cannot be read or parsed: not knowing is no reason to refuse
 * a start that may well work.
 */
export function dockerTooOldLines(versions: DockerVersions): string[] | null {
  const olderThan = (found: string | null, minimum: DockerVersion) => {
    const version = parseDockerVersion(found);
    return version !== null && compareDockerVersions(version, minimum) < 0;
  };
  if (!olderThan(versions.compose, MIN_DOCKER_COMPOSE_VERSION) && !olderThan(versions.engine, MIN_DOCKER_ENGINE_VERSION)) {
    return null;
  }
  const found = (
    [
      ['Compose', versions.compose],
      ['Engine', versions.engine],
    ] as const
  ).flatMap(([label, version]) => (version === null ? [] : [`${label} ${version.replace(/^v/, '')}`]));
  const [composeMajor, composeMinor] = MIN_DOCKER_COMPOSE_VERSION;
  const [engineMajor] = MIN_DOCKER_ENGINE_VERSION;
  return [
    `Companion Hub needs Docker Compose ${composeMajor}.${composeMinor} or newer and Docker Engine ${engineMajor} or newer.`,
    `This computer has ${found.join(' and ')}.`,
    'Update Docker, then start the Hub again.',
  ];
}

function dockerStdout(args: string[], env: Record<string, string | undefined>): string | null {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
  });
  const stdout = (result.stdout ?? '').trim();
  return result.status === 0 && stdout ? stdout : null;
}

/** Both versions, from the Docker that `env` points at (the pinned engine on an appliance). */
export function readDockerVersions(env: Record<string, string | undefined> = {}): DockerVersions {
  return {
    compose: dockerStdout(['compose', 'version', '--short'], env),
    engine: dockerStdout(['version', '--format', '{{.Server.Version}}'], env),
  };
}

/**
 * Stop before the stack starts when Docker is too old for the stack file, with a message that says
 * so. A version that cannot be read is reported and the start goes on, so compose says whatever is
 * actually wrong, as it did before this check.
 */
export function requireDockerForHubStack(env: Record<string, string | undefined> = {}, versions: DockerVersions = readDockerVersions(env)): void {
  const tooOld = dockerTooOldLines(versions);
  if (tooOld) {
    printMessageBox('Docker update needed', tooOld, 'red');
    process.exit(1);
  }
  const shown = (version: string | null) => (parseDockerVersion(version) ? (version as string) : 'unknown');
  console.log(colorize(`→ Docker Compose ${shown(versions.compose)}, Docker Engine ${shown(versions.engine)}`, 'dim'));
  for (const [label, version] of [
    ['Docker Compose', versions.compose],
    ['Docker Engine', versions.engine],
  ] as const) {
    if (!parseDockerVersion(version)) {
      console.log(colorize(`Could not read the ${label} version; starting without checking it.`, 'yellow'));
    }
  }
}
