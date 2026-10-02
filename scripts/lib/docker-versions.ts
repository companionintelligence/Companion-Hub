/**
 * The Docker versions the Hub's stack file needs, checked before `cihub up` starts the stack.
 *
 * `gw_priority` in docker-compose.prod.yml keeps the Hub, Traefik and the Tailscale sidecar on
 * ci-hub_network for their own traffic. It is new in Compose 2.33 and Engine 28, and the two fail
 * differently without it. An older Compose refuses the whole file ("Additional property
 * gw_priority is not allowed"), and nothing in that error says Docker is too old, so `cihub up`
 * stops with a message that does. An older Engine runs the file and ignores the setting: measured
 * on Engine 27.5.1 (API 1.47) with Compose 5.1.4, `up` succeeded and the default route went to the
 * network that sorts first. Every 0.2.77 Hub on Engine 27 starts and works with that routing, so
 * `cihub up` warns and goes on. The desktop app runs the same check
 * (packages/desktop/src-tauri/src/hub_manager/docker_versions.rs).
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
 * `found` as printed, without a leading `v`, when it parses and is older than `minimum`. Null for a
 * version that cannot be read or parsed: not knowing is no reason to refuse or to warn.
 */
function olderThan(found: string | null, minimum: DockerVersion): string | null {
  const version = parseDockerVersion(found);
  return found !== null && version !== null && compareDockerVersions(version, minimum) < 0 ? found.replace(/^v/, '') : null;
}

/** The message to stop on when Compose is too old to read the stack file at all, one sentence per line. */
export function dockerComposeTooOldLines(versions: DockerVersions): string[] | null {
  const found = olderThan(versions.compose, MIN_DOCKER_COMPOSE_VERSION);
  if (found === null) return null;
  const [major, minor] = MIN_DOCKER_COMPOSE_VERSION;
  return [
    `Companion Hub needs Docker Compose ${major}.${minor} or newer.`,
    `This computer has Compose ${found}.`,
    'Update Docker, then start the Hub again.',
  ];
}

/** What to warn about when the engine runs the stack file but ignores `gw_priority`, one sentence per line. */
export function dockerEngineTooOldLines(versions: DockerVersions): string[] | null {
  const found = olderThan(versions.engine, MIN_DOCKER_ENGINE_VERSION);
  if (found === null) return null;
  return [
    `Docker Engine ${found} ignores the network priority the Hub relies on, so the Hub, Traefik, and the Tailscale helper may use the wrong network for internet and host traffic.`,
    `Update Docker Engine to ${MIN_DOCKER_ENGINE_VERSION[0]} or newer.`,
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
 * Stop before the stack starts when Compose is too old for the stack file, with a message that says
 * so. An engine too old for `gw_priority` gets a warning and the start goes on, as does a version
 * that cannot be read, so compose says whatever is actually wrong, as it did before this check.
 * Everything is printed in the order the desktop app logs it: the versions, what could not be
 * read, the engine warning, and last the refusal.
 */
export function requireDockerForHubStack(env: Record<string, string | undefined> = {}, versions: DockerVersions = readDockerVersions(env)): void {
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
  const engineTooOld = dockerEngineTooOldLines(versions);
  if (engineTooOld) {
    printMessageBox('Docker Engine update recommended', engineTooOld, 'yellow');
  }
  const composeTooOld = dockerComposeTooOldLines(versions);
  if (composeTooOld) {
    printMessageBox('Docker update needed', composeTooOld, 'red');
    process.exit(1);
  }
}
