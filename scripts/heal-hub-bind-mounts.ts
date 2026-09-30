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
  chownSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
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
import { effectiveDockerHost, pinnedPathStyle } from './lib/docker-engine';
import { resolveCanonicalDataDir } from './lib/paths';

/** MSYS/Git-Bash bind-mount input (`/c/...`). */
function isMsysDockerPath(value: string): boolean {
  return value.length >= 3 && value[0] === '/' && value[2] === '/' && /[a-zA-Z]/.test(value[1] ?? '');
}

/** WSL-style Docker bind-mount input (`/mnt/<drive>/...`). */
function isMntDockerPath(value: string): boolean {
  return value.length >= 7 && value.startsWith('/mnt/') && /[a-zA-Z]/.test(value[5] ?? '') && value[6] === '/';
}

/**
 * How Windows host paths must be rendered for the active Docker backend
 * (mirrors `WindowsDockerHostStyle` in `hub_manager.rs`):
 * - `drive` (`/c/Users/...`): Docker Desktop translates this form itself.
 * - `wsl-mnt` (`/mnt/c/Users/...`): a native Docker Engine inside WSL2 sees the
 *   Windows drive only under /mnt; a `/c/...` source does not exist there, so the
 *   daemon silently fabricates an empty directory and mounts that instead.
 */
export type WindowsDockerPathStyle = 'drive' | 'wsl-mnt';

/** docker CLI context the desktop's WSL2-engine installer creates and activates
 * (`DOCKER_CONTEXT_WSL_ENGINE` in `hub_manager.rs`). */
const DOCKER_CONTEXT_WSL_ENGINE = 'wsl-engine';

/** Sticky per-process fallback guess — repeated calls must not flip mid-run and
 * must not re-spawn `docker info` per normalized path. */
let cachedWindowsDockerPathStyleGuess: WindowsDockerPathStyle | null = null;

/** Style from deterministic CLI configuration, mirroring the docker CLI's own
 * precedence: CI_HUB_DOCKER_PATH_STYLE override > DOCKER_HOST env (bypasses
 * contexts — fall through to the daemon self-report) > DOCKER_CONTEXT env >
 * config.json currentContext. */
function windowsDockerPathStyleFromCliSignals(): WindowsDockerPathStyle | null {
  const override = (process.env.CI_HUB_DOCKER_PATH_STYLE ?? '').trim();
  if (override === 'drive' || override === 'wsl-mnt') return override;

  if ((process.env.DOCKER_HOST ?? '').trim().length > 0) return null;

  let context = (process.env.DOCKER_CONTEXT ?? '').trim();
  if (context.length === 0 || context === 'default') {
    try {
      const raw = readFileSync(path.join(os.homedir(), '.docker', 'config.json'), 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      const current = (parsed as { currentContext?: unknown })?.currentContext;
      context = typeof current === 'string' ? current.trim() : '';
    } catch {
      context = '';
    }
  }
  if (context === DOCKER_CONTEXT_WSL_ENGINE) return 'wsl-mnt';
  if (context === 'desktop-linux' || context === 'desktop-windows') return 'drive';
  return null;
}

/** One-shot expensive detection: daemon self-report, then filesystem heuristic.
 * Mirrors `detect_windows_docker_host_style_via_daemon` in `hub_manager.rs`. */
function detectWindowsDockerPathStyleViaDaemon(): WindowsDockerPathStyle {
  try {
    const line = execSync('docker info --format "{{.OperatingSystem}}\t{{.KernelVersion}}"', {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
    })
      .toString()
      .trim();
    if (line.length > 0) {
      const [osName = '', kernel = ''] = line.split('\t');
      if (osName.includes('Docker Desktop')) return 'drive';
      // Checked after the Desktop match — Desktop's WSL2 backend also reports a WSL kernel.
      const k = kernel.toLowerCase();
      if (k.includes('microsoft') || k.includes('wsl')) return 'wsl-mnt';
      // Reachable but neither (remote engine, Windows containers): no Windows-drive
      // mapping in either style; keep the legacy drive form.
      return 'drive';
    }
  } catch {
    // Daemon unreachable — fall through to the heuristic.
  }
  if ((process.env.DOCKER_HOST ?? '').includes('docker-desktop')) return 'drive';
  return existsSync(path.join(os.homedir(), '.docker', 'desktop')) ? 'drive' : 'wsl-mnt';
}

function windowsDockerPathStyle(): WindowsDockerPathStyle {
  // Prefer the Hub-pinned engine so bind-mount path style stays paired with DOCKER_HOST.
  const pinned = pinnedPathStyle({ dataDir: resolveCanonicalDataDir() });
  if (pinned === 'drive' || pinned === 'wsl-mnt') return pinned;

  const fromSignals = windowsDockerPathStyleFromCliSignals();
  if (fromSignals) return fromSignals;
  if (!cachedWindowsDockerPathStyleGuess) {
    cachedWindowsDockerPathStyleGuess = detectWindowsDockerPathStyleViaDaemon();
  }
  return cachedWindowsDockerPathStyleGuess;
}

/** Normalize Windows host paths to the backend-correct drive form (lowercase drive). */
function normalizeWindowsDockerPath(value: string, style: WindowsDockerPathStyle): string {
  const trimmed = value.trim().replace(/\\/g, '/');

  let drive: string | null = null;
  let rest = '';
  if (isMntDockerPath(trimmed)) {
    drive = (trimmed[5] ?? 'c').toLowerCase();
    rest = trimmed.slice(6);
  } else if (isMsysDockerPath(trimmed)) {
    drive = (trimmed[1] ?? 'c').toLowerCase();
    rest = trimmed.slice(2);
  } else {
    const driveMatch = /^([a-zA-Z]):\/(.*)$/.exec(trimmed);
    const driveLetter = driveMatch?.[1];
    if (driveLetter) {
      drive = driveLetter.toLowerCase();
      const tail = driveMatch[2] ?? '';
      rest = tail.length === 0 ? '' : `/${tail}`;
    }
  }
  if (drive === null) return trimmed;

  return style === 'wsl-mnt' ? `/mnt/${drive}${rest}` : `/${drive}${rest}`;
}

/**
 * Host path for Docker bind mounts (`-v`, compose volume sources).
 *
 * On Windows the drive form depends on the active backend, matching the desktop
 * runtime (`hub_manager.rs`): `/c/...` for Docker Desktop, `/mnt/c/...` for a
 * native Docker Engine inside WSL2. Inputs `C:/...`, `C:\...`, MSYS `/c/...`,
 * and `/mnt/c/...` are all normalized to the backend-correct form; native
 * `C:/...` breaks compose parsing because Docker treats the first `:` as the
 * volume delimiter.
 */
export function dockerBindMountPath(hostPath: string): string {
  // Use path.posix.resolve on non-Windows so that absolute POSIX paths (e.g.
  // /var/lib/companion-hub) are never interpreted by the Windows path resolver
  // (which would add a drive letter prefix).
  if (process.platform !== 'win32') return path.posix.resolve(hostPath);

  const style = windowsDockerPathStyle();
  const trimmed = hostPath.trim();
  if (isMntDockerPath(trimmed) || isMsysDockerPath(trimmed)) {
    return normalizeWindowsDockerPath(trimmed, style);
  }
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return normalizeWindowsDockerPath(trimmed, style);
  }
  return normalizeWindowsDockerPath(path.win32.resolve(trimmed), style);
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

/**
 * Files in state/ that the Docker heal leaves exactly as they are: the desktop app's update listener
 * token (UPDATE_LISTENER_TOKEN_FILENAME in updater.rs). The Hub only reads it, and the listener
 * trusts it only while it is the desktop user's own file that nobody else can read or write, so the
 * heal's chown or chmod would shut the listener out.
 */
const STATE_FILES_THE_HEAL_KEEPS = ['update-listener.token'] as const;

/**
 * The mode for the state files that hold credentials, which are exactly STATE_FILES_NEED_WRITE:
 * settings.json carries the host-local and Portal device keys, and `seed` derives JWT_SECRET and
 * every app's generated passwords. Owner read and write only, the mode the backend creates and
 * keeps them at (PRIVATE_STATE_FILE_MODE in packages/backend/src/common/helpers/env-helpers.ts).
 *
 * This used to chmod both to 0666 on every start so a container running as someone else could
 * write them, which also let every local user read the device key or plant one of their own. The
 * container runs as the uid that owns the install (docker-entrypoint.sh), and where it does not,
 * the Docker chown in `ensureHubBindMountsWritable` is the repair; world-writable never was.
 */
export const PRIVATE_STATE_FILE_MODE = 0o600;

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

  // Honor the Hub-pinned engine (state/docker-engine.json) when DOCKER_HOST is unset.
  const pinnedHost = effectiveDockerHost({ resolveIfMissing: false });
  if (pinnedHost?.startsWith('unix://')) {
    const socketPath = pinnedHost.slice('unix://'.length).trim();
    if (socketPath) return socketPath;
  }

  if (process.platform === 'linux') {
    const candidates = [
      process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, 'docker.sock') : null,
      typeof process.getuid === 'function' ? `/run/user/${process.getuid()}/docker.sock` : null,
      path.join(os.homedir(), '.docker', 'run', 'docker.sock'),
      path.join(os.homedir(), '.docker', 'desktop', 'docker.sock'),
      '/var/run/docker.sock',
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

/**
 * The uid:gid the Hub process will actually run as, decided the way docker-entrypoint.sh decides
 * whom to drop to: CI_HUB_CONTAINER_UID/GID when pinned, else the owner of the env file compose
 * mounts at /data/.env, else the owner of state/, else 1000. Each half falls back on its own, as
 * the entrypoint's do.
 *
 * `resolveHubContainerIdentity` is not this. With no pin it answers with this CLI's own uid, and
 * init-hub-data-dirs deliberately leaves the pin off. The two agree on an ordinary install and part
 * exactly where a credential file can be locked away from the Hub: `sudo cihub up` on a user-owned
 * install, where it says 0 and the container drops to the env file's owner, 1000.
 */
export function resolveHubRuntimeIdentity(rootFolderHost: string, envFilePath?: string): { uid: number; gid: number } {
  const envVars = envFilePath && existsSync(envFilePath) ? parseEnvFile(envFilePath) : {};
  let dataUid: number | undefined;
  let dataGid: number | undefined;
  for (const probe of [envFilePath, path.join(path.resolve(rootFolderHost), 'state')]) {
    if (!probe) continue;
    try {
      const st = statSync(probe);
      dataUid = st.uid;
      dataGid = st.gid;
      break;
    } catch {
      // Not there yet; the entrypoint moves on to the next probe too.
    }
  }
  return {
    uid: parseUidGid(process.env.CI_HUB_CONTAINER_UID || envVars.CI_HUB_CONTAINER_UID) ?? dataUid ?? 1000,
    gid: parseUidGid(process.env.CI_HUB_CONTAINER_GID || envVars.CI_HUB_CONTAINER_GID) ?? dataGid ?? 1000,
  };
}

/**
 * Whose credential files this process may take to owner-only: the host owner the Hub reads them
 * as, or null when that is not something this process can know.
 *
 * A Hub running as anyone but root reads them as its own uid. A Hub running as root reads them as
 * whoever runs the Docker engine: host root on a rootful engine, which reads any file whatever its
 * mode, or the user running Docker Desktop or rootless Docker, which is this CLI's user unless it
 * was started through sudo. So for a root Hub only a non-root CLI tightens, and only its own files.
 * Anything skipped here the Hub restricts itself on boot, as the files' owner or as root.
 */
function hubStateFileOwnerUid(runtime: { uid: number }): number | null {
  if (runtime.uid !== 0) return runtime.uid;
  const cliUid = typeof process.getuid === 'function' ? process.getuid() : null;
  return cliUid !== null && cliUid !== 0 ? cliUid : null;
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

/**
 * The Docker heal's script: `uid:gid` owns everything on the mount, and everyone can read and write
 * it. The files in `keep`, named relative to the mount, are left exactly as they are: the tree is
 * walked with `find` instead, whose `chown -h` and skipped symlinks do what `-R` does for the rest.
 * Mirrors `bind_mount_heal_script` in the desktop app's runtime_state.rs.
 */
export function bindMountHealScript(uid: number, gid: number, keep: readonly string[] = []): string {
  if (keep.length === 0) {
    return `chown -R ${uid}:${gid} /mnt 2>/dev/null || true; chmod -R u+rwX,g+rwX,o+rwX /mnt 2>/dev/null || chmod -R a+rwX /mnt 2>/dev/null || true`;
  }
  const walk = ['find /mnt', ...keep.map((file) => `! -path '/mnt/${file}'`)].join(' ');
  return `${walk} -exec chown -h ${uid}:${gid} {} + 2>/dev/null || true; ${walk} ! -type l -exec chmod u+rwX,g+rwX,o+rwX {} + 2>/dev/null || ${walk} ! -type l -exec chmod a+rwX {} + 2>/dev/null || true`;
}

export function healBindMountViaDocker(hostSubdir: string, uid: number, gid: number, keep: readonly string[] = []): void {
  if (!existsSync(hostSubdir)) {
    throw new Error(`Cannot repair permissions: directory does not exist: ${hostSubdir}`);
  }
  if (!isDockerAvailable()) {
    throw new Error('Docker is not available; cannot repair bind-mount permissions automatically.');
  }

  const mount = `${dockerBindMountPath(hostSubdir)}:/mnt:rw`;
  const script = bindMountHealScript(uid, gid, keep);

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

function seedSettingsJson(stateDir: string, runtime: { uid: number; gid: number }): void {
  const settingsPath = path.join(stateDir, 'settings.json');
  if (existsSync(settingsPath)) return;
  writeFileSync(settingsPath, '{}', { mode: PRIVATE_STATE_FILE_MODE });
  // A root CLI seeding for a Hub that is not root (sudo on a user-owned install) would leave the Hub
  // a 0600 file it cannot read, which it then quarantines and replaces. Hand it over instead.
  const cliUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (cliUid === 0 && runtime.uid !== 0) {
    try {
      chownSync(settingsPath, runtime.uid, runtime.gid);
    } catch {
      // The Hub copes with a file it cannot read by starting a fresh one; nothing is in this one yet.
    }
  }
}

/**
 * Clears group and other bits on a credential-bearing state file, and never adds any: a file an
 * operator made 0400 stays 0400. Returns the mode it replaced, or null when it changed nothing.
 *
 * Only a file owned by `ownerUid`, the host owner the Hub reads these files as
 * (`hubStateFileOwnerUid`); null tightens nothing. Taking bits off anyone else's file could lock
 * the Hub out of it, so those are left to the Docker chown in `ensureHubBindMountsWritable`, after
 * which the Hub, as their new owner, restricts them on boot.
 */
export function restrictPrivateStateFile(filePath: string, ownerUid: number | null): number | null {
  // NTFS has no POSIX modes, and statSync reports uid 0 for everything there.
  if (process.platform === 'win32' || ownerUid === null) return null;
  try {
    const st = statSync(filePath);
    if (!st.isFile() || st.uid !== ownerUid) return null;
    const current = st.mode & 0o777;
    const restricted = current & PRIVATE_STATE_FILE_MODE;
    if (restricted === current) return null;
    chmodSync(filePath, restricted);
    return current;
  } catch {
    // Missing, or a mount that refuses chmod. The Hub tries again on boot and says so if it cannot.
    return null;
  }
}

function restrictPrivateStateFiles(root: string, ownerUid: number | null): void {
  const restricted: string[] = [];
  for (const [subdir, file] of STATE_FILES_NEED_WRITE) {
    const previous = restrictPrivateStateFile(path.join(root, subdir, file), ownerUid);
    if (previous !== null) restricted.push(`${subdir}/${file} (was 0${previous.toString(8)})`);
  }
  if (restricted.length > 0) {
    console.warn(`heal-hub-bind-mounts: restricted credential file(s) to owner-only 0600: ${restricted.join(', ')}`);
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
  // Not `identity`: that is this CLI's guess, used for the Docker probes, and under sudo it is root
  // while the Hub is not. What a credential file's owner and mode must suit is the Hub itself.
  const runtime = resolveHubRuntimeIdentity(root, options.envFile);
  const privateFileOwnerUid = hubStateFileOwnerUid(runtime);
  seedSettingsJson(stateDir, runtime);
  restrictPrivateStateFiles(root, privateFileOwnerUid);

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
      healBindMountViaDocker(stateDir, effective.uid, effective.gid, STATE_FILES_THE_HEAL_KEEPS);
      // The heal's `chmod -R a+rwX` just made the credential files world-writable. Where its chown
      // left them with the owner the Hub reads them as, they come straight back to owner-only,
      // before the check below confirms the container can still write them.
      restrictPrivateStateFiles(root, privateFileOwnerUid);
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
      seedSettingsJson(stateDir, runtime);
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
