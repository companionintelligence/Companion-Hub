/**
 * Intelligent bind-mount permission repair for CI Hub data directories.
 *
 * Detects how the Hub container will run (host UID vs Docker Desktop root),
 * repairs ownership/permissions via Docker when needed, and verifies writes
 * as the container user before compose up.
 */
import { execSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnvFile } from './env-file';
import { BIND_MOUNT_DIRS, DATA_BEARING_BIND_MOUNT_DIRS, RECREATABLE_BIND_MOUNT_DIRS } from './lib/bind-mounts';

/** MSYS/Git-Bash bind-mount input (`/c/...`). */
function isMsysDockerPath(value: string): boolean {
  return value.length >= 3 && value[0] === '/' && value[2] === '/' && /[a-zA-Z]/.test(value[1] ?? '');
}

/** Legacy WSL-style Docker bind-mount input (`/mnt/<drive>/...`). */
function isMntDockerPath(value: string): boolean {
  return value.length >= 7 && value.startsWith('/mnt/') && /[a-zA-Z]/.test(value[5] ?? '') && value[6] === '/';
}

/** Normalize Windows host paths to `/<drive>/...` (lowercase drive). */
function normalizeWindowsDockerPath(value: string): string {
  const trimmed = value.trim().replace(/\\/g, '/');

  if (isMntDockerPath(trimmed)) {
    const drive = (trimmed[5] ?? 'c').toLowerCase();
    return `/${drive}${trimmed.slice(6)}`;
  }

  if (isMsysDockerPath(trimmed)) {
    const drive = (trimmed[1] ?? 'c').toLowerCase();
    return `/${drive}${trimmed.slice(2)}`;
  }

  const driveMatch = /^([a-zA-Z]):\/(.*)$/.exec(trimmed);
  const driveLetter = driveMatch?.[1];
  if (driveLetter) {
    const drive = driveLetter.toLowerCase();
    const rest = driveMatch[2] ?? '';
    return rest.length === 0 ? `/${drive}` : `/${drive}/${rest}`;
  }

  return trimmed;
}

/**
 * Host path for Docker bind mounts (`-v`, compose volume sources).
 *
 * On Windows the canonical form is `/<drive>/...` (lowercase drive), matching
 * the desktop runtime (`hub_manager.rs`). Inputs `C:/...`, `C:\...`, and MSYS
 * `/c/...` are normalized to that form; native `C:/...` breaks compose parsing
 * because Docker treats the first `:` as the volume delimiter.
 */
export function dockerBindMountPath(hostPath: string): string {
  // Use path.posix.resolve on non-Windows so that absolute POSIX paths (e.g.
  // /var/lib/companion-hub) are never interpreted by the Windows path resolver
  // (which would add a drive letter prefix).
  if (process.platform !== 'win32') return path.posix.resolve(hostPath);

  const trimmed = hostPath.trim();
  if (isMntDockerPath(trimmed) || isMsysDockerPath(trimmed)) {
    return normalizeWindowsDockerPath(trimmed);
  }
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return normalizeWindowsDockerPath(trimmed);
  }
  return normalizeWindowsDockerPath(path.win32.resolve(trimmed));
}

/** Log files a prior root-owned Hub container may leave behind. */
export const STALE_ROOT_OWNED_FILES = [
  ['state', '.env.resolved'],
  ['logs', 'app.log'],
  ['logs', 'error.log'],
  ['state', 'traefik', 'dynamic', 'hub.yml'],
] as const;

/** Tunnel token lives beside ROOT_FOLDER_HOST (compose bind: ../tunnel). */
export function resolveTunnelDir(rootFolderHost: string): string {
  return path.resolve(rootFolderHost, '..', 'tunnel');
}

export function resolveTunnelTokenPath(rootFolderHost: string): string {
  return path.join(resolveTunnelDir(rootFolderHost), 'token');
}

export function resolveTraefikHubRoutePath(rootFolderHost: string): string {
  return path.join(rootFolderHost, 'state', 'traefik', 'dynamic', 'hub.yml');
}

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

function dockerSocketPathFromDockerHost(): string | null {
  const dockerHost = process.env.DOCKER_HOST?.trim();
  if (!dockerHost?.startsWith('unix://')) return null;
  const socketPath = dockerHost.slice('unix://'.length).trim();
  return socketPath || null;
}

export function resolveHostDockerSocketPath(): string {
  const envSocketPath = dockerSocketPathFromDockerHost();
  if (envSocketPath) return envSocketPath;

  if (process.platform === 'linux') {
    const candidates = [
      process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, 'docker.sock') : null,
      typeof process.getuid === 'function' ? `/run/user/${process.getuid()}/docker.sock` : null,
      path.join(os.homedir(), '.docker', 'run', 'docker.sock'),
    ].filter((candidate): candidate is string => Boolean(candidate));

    const existing = candidates.find((candidate) => existsSync(candidate));
    if (existing) return existing;
  }

  return '/var/run/docker.sock';
}

function resolveDockerGid(): number {
  if (process.platform !== 'win32') {
    try {
      const line = execSync('getent group docker', { encoding: 'utf8' }).trim();
      const gid = line.split(':')[2]?.trim();
      if (gid) return Number.parseInt(gid, 10);
    } catch {
      // macOS / missing group
    }
  }
  try {
    return statSync(resolveHostDockerSocketPath()).gid;
  } catch {
    return 973;
  }
}

/** Probe docker.sock ownership from inside a container (avoids shell `%` expansion on Windows). */
export function probeDockerSocketOwnershipInContainer(): string | null {
  try {
    const socketPath = resolveHostDockerSocketPath();
    const result = spawnSync(
      'docker',
      ['run', '--rm', '-v', `${socketPath}:/var/run/docker.sock:ro`, 'alpine', 'stat', '-c', '%u:%g', '/var/run/docker.sock'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    if (result.status !== 0 || result.error) return null;
    const out = result.stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export function dockerSocketIsRootOnlyInsideContainers(): boolean | null {
  const ownership = probeDockerSocketOwnershipInContainer();
  if (ownership === null) return null;
  return ownership === '0:0';
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

  const mount = `${dockerBindMountPath(hostDir)}:/mnt:rw`;
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

  return result?.status === 0;
}

function isSafeBindMountFileName(fileName: string): boolean {
  return fileName.length > 0 && fileName === path.basename(fileName) && !fileName.includes('..') && !/[\0`$;|&<>]/.test(fileName);
}

/** Verify the Hub container user can update an existing bind-mounted file (not just the directory). */
export function verifyContainerCanWriteFile(hostFilePath: string, uid: number, gid: number): boolean {
  if (!isDockerAvailable()) return false;

  const hostDir = path.dirname(hostFilePath);
  const fileName = path.basename(hostFilePath);
  if (!existsSync(hostDir) || !isSafeBindMountFileName(fileName)) return false;

  if (!existsSync(hostFilePath)) {
    return verifyContainerCanWriteDir(hostDir, uid, gid);
  }

  const mount = `${dockerBindMountPath(hostDir)}:/mnt:rw`;
  const result = spawnSync('docker', ['run', '--rm', '--user', `${uid}:${gid}`, '-v', mount, 'alpine:3.20', 'touch', `/mnt/${fileName}`], {
    encoding: 'utf8',
    stdio: 'pipe',
  });

  return result?.status === 0;
}

export function healBindMountViaDocker(hostSubdir: string, uid: number, gid: number): void {
  if (!existsSync(hostSubdir)) {
    throw new Error(`Cannot repair permissions: directory does not exist: ${hostSubdir}`);
  }
  if (!isDockerAvailable()) {
    throw new Error('Docker is not available; cannot repair bind-mount permissions automatically.');
  }

  const mount = `${dockerBindMountPath(hostSubdir)}:/mnt:rw`;
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

function isHostRootOwnedPath(targetPath: string): boolean {
  // Windows NTFS does not have POSIX UID semantics; statSync().uid is always 0
  // on Windows, so every path would falsely appear root-owned. Skip this check
  // entirely — on Windows the container runs as root (UID 0) and can write
  // NTFS bind mounts without any chown repair.
  if (process.platform === 'win32') return false;
  try {
    return statSync(targetPath).uid === 0;
  } catch {
    return false;
  }
}

/** UID/GID bind-mounted files should use on the host (Docker Desktop maps container root to the host user). */
export function effectiveBindMountIdentity(identity: HubContainerIdentity): { uid: number; gid: number } {
  if (identity.uid === 0) {
    const hostUid = typeof process.getuid === 'function' ? process.getuid() : 1000;
    const hostGid = typeof process.getgid === 'function' ? process.getgid() : 1000;
    return { uid: hostUid, gid: hostGid };
  }
  return { uid: identity.uid, gid: identity.gid };
}

function trySudoChown(targetPath: string, uid: number, gid: number, recursive = true): boolean {
  // sudo and Unix-style chown do not exist on Windows.
  if (process.platform === 'win32') return false;
  const args = recursive ? ['-R'] : [];
  const result = spawnSync('sudo', ['-n', 'chown', ...args, `${uid}:${gid}`, targetPath], { encoding: 'utf8', stdio: 'pipe' });
  return result?.status === 0;
}

function trySudoChownRecursive(targetPath: string, uid: number, gid: number): boolean {
  return trySudoChown(targetPath, uid, gid, true);
}

/**
 * Rename a stale bind-mounted path aside for manual recovery instead of deleting it.
 */
export function quarantineStalePath(targetPath: string, reason = 'stale-root'): string | null {
  if (!existsSync(targetPath)) return null;

  const quarantinePath = `${targetPath}.${reason}-${Date.now()}`;
  try {
    renameSync(targetPath, quarantinePath);
    return quarantinePath;
  } catch {
    return null;
  }
}

/**
 * Move an unwritable host-root-owned bind mount aside and recreate it.
 * Works because ROOT_FOLDER_HOST is owned by the host user even when a child
 * directory was created as host root by an older Hub container.
 */
export function quarantineAndRecreateBindMountDir(targetPath: string): boolean {
  if (!existsSync(targetPath)) return false;

  const stalePath = `${targetPath}.stale-root-${Date.now()}`;
  try {
    renameSync(targetPath, stalePath);
  } catch {
    return false;
  }

  mkdirSync(targetPath, { recursive: true });
  try {
    chmodSync(targetPath, 0o775);
  } catch {
    // ignore
  }
  return true;
}

/**
 * Quarantine a host-root-owned tunnel directory and recreate it beside ROOT_FOLDER_HOST.
 * Works without sudo when the parent ci-hub directory is owned by the host user — Docker
 * bind-mount chown cannot fix true host-root files under rootless/user-namespaced Docker.
 */
export function quarantineAndRecreateTunnelDir(tunnelDir: string): boolean {
  if (!existsSync(tunnelDir)) return false;

  const tokenPath = path.join(tunnelDir, 'token');
  const tunnelBlocked = (existsSync(tokenPath) && !hostPathWritable(tokenPath)) || (!hostPathWritable(tunnelDir) && isHostRootOwnedPath(tunnelDir));
  if (!tunnelBlocked) return false;

  return quarantineAndRecreateBindMountDir(tunnelDir);
}

function repairUnwritableCriticalFile(filePath: string, root: string, effective: { uid: number; gid: number }, repaired: string[]): void {
  if (!existsSync(filePath)) return;
  if (hostPathWritable(filePath)) return;

  if (trySudoChown(filePath, effective.uid, effective.gid, false) && hostPathWritable(filePath)) {
    repaired.push(`${path.relative(root, filePath)} (chown)`);
    return;
  }

  try {
    rmSync(filePath, { force: true });
    repaired.push(`${path.relative(root, filePath)} (removed stale root-owned file)`);
    return;
  } catch {
    // fall through
  }

  if (isDockerAvailable()) {
    try {
      healBindMountViaDocker(path.dirname(filePath), effective.uid, effective.gid);
    } catch {
      // Docker chown often cannot fix true host-root files; verify step surfaces remaining issues.
    }
    if (!existsSync(filePath) || hostPathWritable(filePath)) {
      repaired.push(`${path.relative(root, filePath)} (docker heal)`);
    }
  }
}

/** Remove or chown single files that block tunnel/Traefik writes after root-owned Hub runs. */
export function repairCriticalBindMountFiles(rootFolderHost: string, identity: HubContainerIdentity): string[] {
  const root = path.resolve(rootFolderHost);
  const effective = effectiveBindMountIdentity(identity);
  const repaired: string[] = [];

  const tunnelDir = resolveTunnelDir(root);
  if (quarantineAndRecreateTunnelDir(tunnelDir)) {
    repaired.push('../tunnel/ (recreated)');
  } else {
    mkdirSync(tunnelDir, { recursive: true });
    try {
      chmodSync(tunnelDir, 0o775);
    } catch {
      // ignore
    }
  }

  const criticalFiles = [resolveTunnelTokenPath(root), resolveTraefikHubRoutePath(root)];
  for (const filePath of criticalFiles) {
    repairUnwritableCriticalFile(filePath, root, effective, repaired);
  }

  if (!hostPathWritable(tunnelDir)) {
    if (trySudoChownRecursive(tunnelDir, effective.uid, effective.gid) && hostPathWritable(tunnelDir)) {
      repaired.push('../tunnel/ (chown)');
    } else if (quarantineAndRecreateTunnelDir(tunnelDir)) {
      repaired.push('../tunnel/ (recreated)');
    } else if (isDockerAvailable()) {
      try {
        healBindMountViaDocker(tunnelDir, effective.uid, effective.gid);
      } catch {
        // verify step surfaces remaining issues
      }
      if (hostPathWritable(tunnelDir)) {
        repaired.push('../tunnel/ (docker heal)');
      }
    }
  }

  const traefikDynamicDir = path.join(root, 'state', 'traefik', 'dynamic');
  mkdirSync(traefikDynamicDir, { recursive: true });
  if (!hostPathWritable(traefikDynamicDir)) {
    if (trySudoChownRecursive(traefikDynamicDir, effective.uid, effective.gid) && hostPathWritable(traefikDynamicDir)) {
      repaired.push('state/traefik/dynamic/ (chown)');
    } else if (isDockerAvailable()) {
      healBindMountViaDocker(traefikDynamicDir, effective.uid, effective.gid);
      if (hostPathWritable(traefikDynamicDir)) {
        repaired.push('state/traefik/dynamic/ (docker heal)');
      }
    }
  }

  return repaired;
}

/** Repair bind-mount directories/files owned by host root that block container writes. */
export function repairHostRootOwnedBindMounts(
  rootFolderHost: string,
  identity: HubContainerIdentity,
): { repaired: string[]; blockedDataDirs: string[] } {
  const root = path.resolve(rootFolderHost);
  const effective = effectiveBindMountIdentity(identity);
  const repaired: string[] = [];
  const blockedDataDirs: string[] = [];

  for (const dir of RECREATABLE_BIND_MOUNT_DIRS) {
    const target = path.join(root, dir);
    if (!existsSync(target)) continue;
    if (!isHostRootOwnedPath(target) && hostPathWritable(target)) continue;

    if (trySudoChownRecursive(target, effective.uid, effective.gid) && hostPathWritable(target)) {
      repaired.push(`${dir}/ (chown)`);
      continue;
    }

    if (quarantineAndRecreateBindMountDir(target)) {
      repaired.push(`${dir}/ (recreated)`);
    }
  }

  for (const dir of DATA_BEARING_BIND_MOUNT_DIRS) {
    const target = path.join(root, dir);
    if (!existsSync(target)) continue;
    if (!isHostRootOwnedPath(target) || hostPathWritable(target)) continue;

    if (trySudoChownRecursive(target, effective.uid, effective.gid) && hostPathWritable(target)) {
      repaired.push(`${dir}/ (chown)`);
      continue;
    }

    blockedDataDirs.push(dir);
  }

  repaired.push(...removeHostRootOwnedStateFiles(root));
  return { repaired, blockedDataDirs };
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

/**
 * Remove state files owned by host root (uid 0) that the Hub container cannot write.
 * Common after older Hub runs on native Linux Docker; Docker Desktop bind mounts
 * cannot chown these files from inside a container.
 */
export function removeHostRootOwnedStateFiles(root: string): string[] {
  const quarantined: string[] = [];
  const stateDir = path.join(root, 'state');

  for (const [subdir, file] of STATE_FILES_NEED_WRITE) {
    const filePath = path.join(root, subdir, file);
    if (!existsSync(filePath)) continue;

    try {
      const st = statSync(filePath);
      if (!st.isFile() || st.uid !== 0) continue;
      if (hostPathWritable(filePath)) continue;

      const quarantinePath = quarantineStalePath(filePath);
      if (quarantinePath) {
        quarantined.push(`${path.join(subdir, file)} → ${quarantinePath}`);
      }
    } catch {
      // Best-effort; verify step will surface remaining issues.
    }
  }

  // Host-root-owned files can block unlink when state/ itself is root-owned.
  try {
    if (existsSync(stateDir) && statSync(stateDir).uid === 0 && !hostPathWritable(stateDir)) {
      console.warn(`heal-hub-bind-mounts: ${stateDir} is host-root-owned and not writable; attempting Docker repair.`);
    }
  } catch {
    // ignore
  }

  return quarantined;
}

function permissionRepairHint(rootFolderHost: string, identity: HubContainerIdentity, blockedDataDirs: string[] = []): string {
  const lines = [
    `Hub data at ${rootFolderHost} is not writable by the Hub container (UID/GID ${identity.uid}:${identity.gid}).`,
    'This usually happens after a Hub upgrade when old bind-mount files were owned by a different user.',
    `Fix manually: sudo chown -R ${identity.uid}:${identity.gid} "${path.join(rootFolderHost, 'state')}"`,
  ];

  for (const dir of blockedDataDirs) {
    lines.push(`Data directory ${dir}/ is host-root-owned; run: sudo chown -R ${identity.uid}:${identity.gid} "${path.join(rootFolderHost, dir)}"`);
  }

  lines.push(`Or quarantine ${path.join(rootFolderHost, 'state', 'settings.json')} manually and restart the Hub.`);
  return lines.join(' ');
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

  const identity = resolveHubContainerIdentity(options.envFile);
  const { repaired, blockedDataDirs } = repairHostRootOwnedBindMounts(root, identity);
  if (blockedDataDirs.length > 0) {
    throw new Error(permissionRepairHint(root, identity, blockedDataDirs));
  }
  const criticalRepaired = repairCriticalBindMountFiles(root, identity);
  if (repaired.length > 0 || criticalRepaired.length > 0) {
    console.warn(`heal-hub-bind-mounts: repaired host-root-owned bind mount path(s): ${[...repaired, ...criticalRepaired].join(', ')}`);
  }

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

  if (options.skipDockerHeal) {
    return identity;
  }

  const settingsPath = path.join(stateDir, 'settings.json');
  const cacheDir = path.join(root, 'cache');
  const tunnelTokenPath = resolveTunnelTokenPath(root);
  const hubRoutePath = resolveTraefikHubRoutePath(root);
  mkdirSync(path.dirname(tunnelTokenPath), { recursive: true });
  mkdirSync(path.dirname(hubRoutePath), { recursive: true });

  let containerCanWriteSettings = verifyContainerCanWriteFile(settingsPath, identity.uid, identity.gid);
  let containerCanWriteCache = verifyContainerCanWriteDir(cacheDir, identity.uid, identity.gid);
  let containerCanWriteTunnelToken = verifyContainerCanWriteFile(tunnelTokenPath, identity.uid, identity.gid);
  let containerCanWriteHubRoute = verifyContainerCanWriteFile(hubRoutePath, identity.uid, identity.gid);

  if (!containerCanWriteSettings || !containerCanWriteCache || !containerCanWriteTunnelToken || !containerCanWriteHubRoute) {
    console.warn(
      `heal-hub-bind-mounts: bind mounts not writable as container ${identity.uid}:${identity.gid} (${identity.source}); repairing via Docker…`,
    );
    const effective = effectiveBindMountIdentity(identity);
    if (!containerCanWriteCache) {
      healBindMountViaDocker(cacheDir, effective.uid, effective.gid);
      containerCanWriteCache = verifyContainerCanWriteDir(cacheDir, identity.uid, identity.gid);
    }
    if (!containerCanWriteSettings) {
      healBindMountViaDocker(stateDir, effective.uid, effective.gid);
      containerCanWriteSettings = verifyContainerCanWriteFile(settingsPath, identity.uid, identity.gid);
    }
    if (!containerCanWriteTunnelToken) {
      healBindMountViaDocker(path.dirname(tunnelTokenPath), effective.uid, effective.gid);
      containerCanWriteTunnelToken = verifyContainerCanWriteFile(tunnelTokenPath, identity.uid, identity.gid);
    }
    if (!containerCanWriteHubRoute) {
      healBindMountViaDocker(path.dirname(hubRoutePath), effective.uid, effective.gid);
      containerCanWriteHubRoute = verifyContainerCanWriteFile(hubRoutePath, identity.uid, identity.gid);
    }
  }

  if (!containerCanWriteSettings) {
    const removedAfterHeal = removeHostRootOwnedStateFiles(root);
    if (removedAfterHeal.length > 0) {
      seedSettingsJson(stateDir);
      containerCanWriteSettings = verifyContainerCanWriteFile(settingsPath, identity.uid, identity.gid);
    }
  }

  if (!containerCanWriteCache) {
    const { blockedDataDirs: cacheBlocked } = repairHostRootOwnedBindMounts(root, identity);
    if (cacheBlocked.length > 0) {
      throw new Error(permissionRepairHint(root, identity, cacheBlocked));
    }
    containerCanWriteCache = verifyContainerCanWriteDir(cacheDir, identity.uid, identity.gid);
  }

  if (!containerCanWriteSettings) {
    // Last resort: host user may still need settings for local dev without Docker verify
    if (hostPathWritable(settingsPath)) {
      return identity;
    }
    throw new Error(permissionRepairHint(root, identity));
  }

  if (!containerCanWriteCache) {
    throw new Error(
      `Hub cache directory is not writable by the Hub container (UID/GID ${identity.uid}:${identity.gid}). ` +
        `Fix manually: sudo chown -R ${effectiveBindMountIdentity(identity).uid}:${effectiveBindMountIdentity(identity).gid} "${cacheDir}"`,
    );
  }

  if (!containerCanWriteTunnelToken) {
    repairCriticalBindMountFiles(root, identity);
    containerCanWriteTunnelToken = verifyContainerCanWriteFile(tunnelTokenPath, identity.uid, identity.gid);
  }

  if (!containerCanWriteHubRoute) {
    repairCriticalBindMountFiles(root, identity);
    containerCanWriteHubRoute = verifyContainerCanWriteFile(hubRoutePath, identity.uid, identity.gid);
  }

  if (!containerCanWriteTunnelToken) {
    throw new Error(
      `Tunnel token at ${tunnelTokenPath} is not writable by the Hub container (UID/GID ${identity.uid}:${identity.gid}). ` +
        `Fix manually: sudo chown ${effectiveBindMountIdentity(identity).uid}:${effectiveBindMountIdentity(identity).gid} "${tunnelTokenPath}"`,
    );
  }

  if (!containerCanWriteHubRoute) {
    throw new Error(
      `Traefik hub route at ${hubRoutePath} is not writable by the Hub container (UID/GID ${identity.uid}:${identity.gid}). ` +
        `Fix manually: sudo chown ${effectiveBindMountIdentity(identity).uid}:${effectiveBindMountIdentity(identity).gid} "${hubRoutePath}"`,
    );
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
