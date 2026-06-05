/**
 * Intelligent bind-mount permission repair for CI Hub data directories.
 *
 * Detects how the Hub container will run (host UID vs Docker Desktop root),
 * repairs ownership/permissions via Docker when needed, and verifies writes
 * as the container user before compose up.
 */
import { execSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnvFile } from './cihub-cli';

export const BIND_MOUNT_DIRS = ['cache', 'state', 'logs', 'apps', 'media', 'repos', 'app-data', 'user-config', 'backups'] as const;

/** Log files a prior root-owned Hub container may leave behind. */
export const STALE_ROOT_OWNED_FILES = [
  ['state', '.env.resolved'],
  ['logs', 'app.log'],
  ['logs', 'error.log'],
] as const;

export const STATE_FILES_NEED_WRITE = [
  ['state', 'settings.json'],
  ['state', 'seed'],
] as const;

export interface HubContainerIdentity {
  uid: number;
  gid: number;
  dockerGid: number;
  source: 'env' | 'docker-desktop-root' | 'docker-socket' | 'host-user';
}

export function likelyDockerDesktop(): boolean {
  const home = os.homedir();
  return existsSync(path.join(home, '.docker', 'desktop')) || (process.env.DOCKER_HOST || '').includes('docker-desktop');
}

function resolveDockerGid(): number {
  try {
    const line = execSync('getent group docker', { encoding: 'utf8' }).trim();
    const gid = line.split(':')[2]?.trim();
    if (gid) return Number.parseInt(gid, 10);
  } catch {
    // macOS / missing group
  }
  try {
    return statSync('/var/run/docker.sock').gid;
  } catch {
    return 973;
  }
}

function dockerSocketIsRootOnlyInsideContainers(): boolean | null {
  try {
    const out = execSync('docker run --rm -v /var/run/docker.sock:/var/run/docker.sock:ro alpine stat -c "%u:%g" /var/run/docker.sock 2>/dev/null', {
      encoding: 'utf8',
    }).trim();
    return out === '0:0';
  } catch {
    return null;
  }
}

function parseUidGid(raw: string | undefined): number | undefined {
  if (!raw?.trim()) return undefined;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Mirror hub_manager.rs / init-hub-data-dirs.ts container identity resolution. */
export function resolveHubContainerIdentity(envFilePath?: string): HubContainerIdentity {
  const dockerGid = resolveDockerGid();
  const envVars = envFilePath && existsSync(envFilePath) ? parseEnvFile(envFilePath) : {};
  const envUid = parseUidGid(process.env.CI_HUB_CONTAINER_UID || envVars.CI_HUB_CONTAINER_UID);
  const envGid = parseUidGid(process.env.CI_HUB_CONTAINER_GID || envVars.CI_HUB_CONTAINER_GID);

  if (envUid !== undefined && envGid !== undefined) {
    return { uid: envUid, gid: envGid, dockerGid, source: 'env' };
  }

  const socketRootOnly = dockerSocketIsRootOnlyInsideContainers();
  if (socketRootOnly === true || (socketRootOnly === null && likelyDockerDesktop())) {
    return { uid: 0, gid: 0, dockerGid, source: 'docker-desktop-root' };
  }

  if (socketRootOnly === false) {
    const hostUid = typeof process.getuid === 'function' ? process.getuid() : 1000;
    const hostGid = typeof process.getgid === 'function' ? process.getgid() : 1000;
    return { uid: hostUid, gid: hostGid, dockerGid, source: 'docker-socket' };
  }

  const hostUid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const hostGid = typeof process.getgid === 'function' ? process.getgid() : 1000;
  return { uid: hostUid, gid: hostGid, dockerGid, source: 'host-user' };
}

export function isDockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Best-effort host-side write probe (fast path). */
export function hostPathWritable(targetPath: string): boolean {
  try {
    if (!existsSync(targetPath)) {
      const parent = path.dirname(targetPath);
      if (!existsSync(parent)) return false;
      return hostPathWritable(parent);
    }

    if (statSync(targetPath).isDirectory()) {
      const probe = path.join(targetPath, '.ci-hub-write-probe');
      writeFileSync(probe, 'ok');
      unlinkSync(probe);
      return true;
    }

    const fd = openSync(targetPath, 'a');
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

/** Authoritative check: can the Hub container user write to this directory? */
export function verifyContainerCanWriteDir(hostDir: string, uid: number, gid: number): boolean {
  if (!existsSync(hostDir) || !isDockerAvailable()) return false;

  const mount = `${path.resolve(hostDir)}:/mnt:rw`;
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--user',
      `${uid}:${gid}`,
      '-v',
      mount,
      'alpine:3.20',
      'sh',
      '-c',
      'touch /mnt/.ci-hub-write-probe && rm -f /mnt/.ci-hub-write-probe',
    ],
    { encoding: 'utf8', stdio: 'pipe' },
  );

  return result.status === 0;
}

export function healBindMountViaDocker(hostSubdir: string, uid: number, gid: number): void {
  if (!existsSync(hostSubdir)) {
    throw new Error(`Cannot repair permissions: directory does not exist: ${hostSubdir}`);
  }
  if (!isDockerAvailable()) {
    throw new Error('Docker is not available; cannot repair bind-mount permissions automatically.');
  }

  const mount = `${path.resolve(hostSubdir)}:/mnt:rw`;
  const script = `chown -R ${uid}:${gid} /mnt 2>/dev/null || true; chmod -R u+rwX,g+rwX,o+rwX /mnt 2>/dev/null || chmod -R a+rwX /mnt 2>/dev/null || true`;

  const result = spawnSync('docker', ['run', '--rm', '--user', '0:0', '-v', mount, 'alpine:3.20', 'sh', '-c', script], {
    encoding: 'utf8',
    stdio: 'pipe',
  });

  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join(' ').trim();
    throw new Error(`Docker permission repair failed for ${hostSubdir}${detail ? `: ${detail}` : ''}`);
  }
}

function seedSettingsJson(stateDir: string): void {
  const settingsPath = path.join(stateDir, 'settings.json');
  if (!existsSync(settingsPath)) {
    writeFileSync(settingsPath, '{}', { mode: 0o666 });
    return;
  }
  try {
    chmodSync(settingsPath, 0o666);
  } catch {
    // May be root-owned; Docker heal handles it.
  }
}

function removeStaleRootOwnedFiles(root: string): void {
  for (const [subdir, file] of STALE_ROOT_OWNED_FILES) {
    const stale = path.join(root, subdir, file);
    if (existsSync(stale)) {
      try {
        rmSync(stale, { force: true });
      } catch {
        // Docker heal will overwrite permissions; logs may remain append-only.
      }
    }
  }
}

function permissionRepairHint(rootFolderHost: string, identity: HubContainerIdentity): string {
  return [
    `Hub data at ${rootFolderHost} is not writable by the Hub container (UID/GID ${identity.uid}:${identity.gid}).`,
    'This usually happens after a Hub upgrade when old bind-mount files were owned by a different user.',
    `Fix manually: sudo chown -R ${identity.uid}:${identity.gid} "${path.join(rootFolderHost, 'state')}"`,
    `Or remove ${path.join(rootFolderHost, 'state', 'settings.json')} and restart the Hub.`,
  ].join(' ');
}

export interface EnsureHubBindMountsOptions {
  envFile?: string;
  /** Skip Docker-based repair (tests only). */
  skipDockerHeal?: boolean;
}

/**
 * Prepare Hub bind-mount tree on the host and verify the container can write state/.
 * Throws with an actionable message when repair fails.
 */
export function ensureHubBindMountsWritable(rootFolderHost: string, options: EnsureHubBindMountsOptions = {}): HubContainerIdentity {
  const root = path.resolve(rootFolderHost);
  mkdirSync(root, { recursive: true });

  for (const dir of BIND_MOUNT_DIRS) {
    const target = path.join(root, dir);
    mkdirSync(target, { recursive: true });
    try {
      chmodSync(target, 0o775);
    } catch {
      // Best-effort; Docker heal may still fix ownership.
    }
  }

  removeStaleRootOwnedFiles(root);

  const stateDir = path.join(root, 'state');
  seedSettingsJson(stateDir);

  for (const [subdir, file] of STATE_FILES_NEED_WRITE) {
    const filePath = path.join(root, subdir, file);
    if (existsSync(filePath)) {
      try {
        chmodSync(filePath, 0o666);
      } catch {
        // ignore
      }
    }
  }

  const identity = resolveHubContainerIdentity(options.envFile);

  if (options.skipDockerHeal) {
    return identity;
  }

  const settingsPath = path.join(stateDir, 'settings.json');
  let containerCanWrite = verifyContainerCanWriteDir(stateDir, identity.uid, identity.gid);

  if (!containerCanWrite) {
    console.warn(
      `heal-hub-bind-mounts: state/ not writable as container ${identity.uid}:${identity.gid} (${identity.source}); repairing via Docker…`,
    );
    healBindMountViaDocker(stateDir, identity.uid, identity.gid);
    containerCanWrite = verifyContainerCanWriteDir(stateDir, identity.uid, identity.gid);
  }

  if (!containerCanWrite) {
    // Last resort: host user may still need settings for local dev without Docker verify
    if (hostPathWritable(settingsPath)) {
      return identity;
    }
    throw new Error(permissionRepairHint(root, identity));
  }

  return identity;
}

/** Append a line to desktop-style logs when called from CLI setup. */
export function logBindMountHeal(rootFolderHost: string, message: string): void {
  try {
    const logDir = path.join(rootFolderHost, 'logs');
    mkdirSync(logDir, { recursive: true });
    appendFileSync(path.join(logDir, 'init.log'), `${new Date().toISOString()} - ${message}\n`);
  } catch {
    // ignore
  }
}
