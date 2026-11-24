import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { usableXdgDataHome } from './lib/paths';

type CleanupLevel = 'INFO' | 'WARN' | 'ERROR';

export type CleanupLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type ExecResult = {
  ok: boolean;
  stdout: string;
  error?: string;
};

export type CleanupSummary = {
  removedDirs: number;
  skippedDirs: number;
  failedDirs: number;
  attemptedCommands: number;
  failedCommands: number;
  dryRun: boolean;
};

export type CleanupOptions = {
  cwd?: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  dryRun?: boolean;
  logger?: CleanupLogger;
  /** Runs a program with an argv. No shell sits in between, so a docker template arrives as written. */
  execFile?: (file: string, args: string[], cwd?: string) => ExecResult;
  exists?: (targetPath: string) => boolean;
  removeDir?: (targetPath: string) => void;
};

type CleanupDirTarget = {
  path: string;
  label: string;
};

const HUB_STATE_NAMES = ['Companion Hub', 'companion-hub', 'ci-hub', 'CI-Hub', 'computer.ci.app.hub'];
const WINDOWS_STATE_NAMES = ['Companion Hub', 'companion-hub', 'CI-Hub', 'computer.ci.app.hub'];

function defaultLogger(): CleanupLogger {
  const format = (level: CleanupLevel, message: string) => `[cleanup][${level}] ${message}`;
  return {
    info: (message: string) => console.log(format('INFO', message)),
    warn: (message: string) => console.warn(format('WARN', message)),
    error: (message: string) => console.error(format('ERROR', message)),
  };
}

function defaultExecFile(file: string, args: string[], cwd = process.cwd()): ExecResult {
  const result = spawnSync(file, args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  if (result.error) {
    return { ok: false, stdout: '', error: String(result.error) };
  }
  if (result.status !== 0) {
    return { ok: false, stdout: '', error: `exit ${result.status ?? result.signal}: ${(result.stderr ?? '').trim()}` };
  }
  return { ok: true, stdout: (result.stdout ?? '').trim() };
}

export function isWithinPath(targetPath: string, basePath: string, platform: NodeJS.Platform = process.platform): boolean {
  const pathLib = platform === 'win32' ? path.win32 : path.posix;
  // Strip trailing separators so normalize('/home/user/') + sep never produces '//'
  const stripTrailing = (p: string) => p.replace(new RegExp(`${pathLib.sep.replace('\\', '\\\\')}+$`), '');
  const normalizedTarget = stripTrailing(pathLib.normalize(targetPath));
  const normalizedBase = stripTrailing(pathLib.normalize(basePath));
  const comparableTarget = platform === 'win32' ? normalizedTarget.toLowerCase() : normalizedTarget;
  const comparableBase = platform === 'win32' ? normalizedBase.toLowerCase() : normalizedBase;
  return comparableTarget === comparableBase || comparableTarget.startsWith(comparableBase + pathLib.sep);
}

export function isRelatedVolume(volumeName: string): boolean {
  return (
    volumeName.includes('ci_os_hub') ||
    volumeName.includes('ci-os-hub') ||
    // Both legacy prefixes: appliances created `runtipi_*` volumes, and #1143
    // (c88a83580) renamed the string to `runcihub_` by substring. Docker volume
    // names are fixed at create time, so only `runtipi_` is actually out there.
    volumeName.startsWith('runtipi_') ||
    volumeName.startsWith('runcihub_') ||
    volumeName.includes('ci_hub_pgdata') ||
    volumeName.includes('ci_hub_app_data') ||
    volumeName.includes('hub_tailscale_state') ||
    volumeName.startsWith('e2e-') ||
    volumeName.startsWith('test-e2e-') ||
    /^(ci_os_hub|ci-os-hub|ci_hub|ci-hub)[-_].*_data$/.test(volumeName)
  );
}

export function parseNames(output: string): string[] {
  return output
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * The Hub's own compose projects. Their services carry the managed labels too, but they are not apps.
 *
 * `runtipi` is the project name real appliances were installed under — CI-Portal's production
 * runbook still uses it. #1143 (c88a83580) renamed it to `runcihub` by substring; both are kept
 * because a compose project name is fixed at install time and cannot be renamed in place.
 */
export const HUB_STACK_PROJECT_NAMES = ['ci-os-hub', 'ci-hub', 'runtipi', 'runcihub'] as const;
const HUB_STACK_PROJECTS = new Set<string>(HUB_STACK_PROJECT_NAMES);

/** The Hub sets both on every app container. Apps installed before the rename carry only the second. */
const MANAGED_LABEL_FILTERS = ['label=ci-hub.managed=true', 'label=ci-os-hub.managed=true'] as const;

/**
 * The compose project label on its own. `{{.Labels}}` joins every `key=value` with commas and
 * escapes none, so it cannot be split back into labels. Pass it in an argv: in a shell string
 * cmd.exe strips the inner quotes.
 */
const COMPOSE_PROJECT_FORMAT = '{{.Label "com.docker.compose.project"}}';

export type DockerCliRunner = (args: string[]) => { ok: boolean; stdout: string };

/**
 * Every network name the Hub stack has used. Each app's main service joins it, and so does
 * anything else that talks to the Hub by container name.
 */
export const HUB_NETWORK_NAMES = ['ci-hub_network', 'ci_hub_network', 'ci-os-hub_network', 'ci_os_hub_network'] as const;

/** Docker's container, network, and compose-project charset. Nothing else reaches a docker argv. */
const DOCKER_OBJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** The `docker` filter for one compose project's containers, networks, volumes, or images. */
function byComposeProject(project: string): string[] {
  return ['--filter', `label=com.docker.compose.project=${project}`];
}

/** `{{.Names}}` joins legacy link aliases with commas; the first entry is the container itself. */
function containerNameOf(names: string): string {
  return names.split(',')[0] ?? names;
}

/**
 * The compose projects of Hub-installed apps, read from the containers that carry a managed label.
 * `list` runs `docker` with an argv and returns the output lines.
 *
 * An app's whole project goes with it, including services the user added in the app's user-config
 * docker-compose.yml, which lack the managed labels. Compose sets the project label itself, over
 * any the service declares, so an app cannot name another project there.
 */
export function findManagedAppProjects(list: (args: string[]) => string[]): string[] {
  const projects = new Set<string>();
  for (const filter of MANAGED_LABEL_FILTERS) {
    for (const project of list(['ps', '-a', '--filter', filter, '--format', COMPOSE_PROJECT_FORMAT])) {
      if (!HUB_STACK_PROJECTS.has(project) && DOCKER_OBJECT_NAME.test(project)) projects.add(project);
    }
  }
  return [...projects];
}

export type AppProjectTeardown = {
  project: string;
  containers: string[];
  networks: string[];
  /** Empty unless the plan was made with `removeVolumes`. */
  volumes: string[];
};

export type AppTeardownPlan = {
  /**
   * False when Docker could not list containers. That is not "no apps": an app container with a
   * restart policy comes back with the daemon, against whatever was deleted meanwhile.
   */
  listed: boolean;
  /** Hub-installed apps, found by the managed labels, with everything of theirs that goes. */
  projects: AppProjectTeardown[];
  /**
   * Containers attached to a Hub network that belong neither to the Hub stack nor to an installed
   * app. The Hub cannot see or manage them, and a reset deletes the network and data they use.
   */
  unmanaged: string[];
};

/**
 * Lists what {@link executeAppTeardown} would remove, without changing anything.
 *
 * Apps are found by the managed labels, as before. Containers on a Hub network are found as well,
 * because the labels only cover what the Hub created. On beta-max (2026-09-22) four containers
 * named like Hub apps (`ci-hermes_ci-marketplace-ci-hermes-1`, …) had been started with
 * `docker run` after a reset: no compose or managed labels, on `ci-hub_network`, bind-mounting
 * `app-data/`. The fresh Hub had no rows for them and could not stop, expose, or uninstall them,
 * and a label-only reset would leave them running. `cihub uninstall` already removes every
 * container on these networks (runHubCleanup).
 *
 * This assumes one Hub per Docker daemon, as the managed labels carry no Hub identity.
 */
export function planAppTeardown(docker: DockerCliRunner, options: { removeVolumes: boolean }): AppTeardownPlan {
  let listed = true;
  const list = (args: string[]): string[] => {
    const { ok, stdout } = docker(args);
    if (!ok) listed = false;
    return ok ? parseNames(stdout) : [];
  };
  const listIfOk = (args: string[]): string[] => {
    const { ok, stdout } = docker(args);
    return ok ? parseNames(stdout) : [];
  };

  const projects = findManagedAppProjects(list).map((project) => ({
    project,
    containers: listIfOk(['ps', '-a', ...byComposeProject(project), '--format', '{{.Names}}'])
      .map(containerNameOf)
      .filter((name) => DOCKER_OBJECT_NAME.test(name)),
    networks: listIfOk(['network', 'ls', ...byComposeProject(project), '--format', '{{.Name}}']).filter((name) => DOCKER_OBJECT_NAME.test(name)),
    volumes: options.removeVolumes
      ? listIfOk(['volume', 'ls', '-q', ...byComposeProject(project)]).filter((name) => DOCKER_OBJECT_NAME.test(name))
      : [],
  }));

  // Repeated `network` filters match a container on ANY of them. A container name has no spaces,
  // so everything after the first one is its compose project, empty when it has none.
  const onHubNetwork = list([
    'ps',
    '-a',
    ...HUB_NETWORK_NAMES.flatMap((network) => ['--filter', `network=${network}`]),
    '--format',
    `{{.Names}} ${COMPOSE_PROJECT_FORMAT}`,
  ]);
  const owned = new Set<string>([...HUB_STACK_PROJECT_NAMES, ...projects.map((entry) => entry.project)]);
  const unmanaged = new Set<string>();
  for (const line of onHubNetwork) {
    const space = line.indexOf(' ');
    const name = containerNameOf(space === -1 ? line : line.slice(0, space));
    const project = space === -1 ? undefined : line.slice(space + 1);
    if (project !== undefined && owned.has(project)) continue;
    if (DOCKER_OBJECT_NAME.test(name)) unmanaged.add(name);
  }

  return { listed, projects, unmanaged: [...unmanaged] };
}

/**
 * Removes what {@link planAppTeardown} listed: each app's containers, networks, and (when planned)
 * named volumes, then the unmanaged containers. Those lose only the container. No named volume can
 * be traced to them, and their bind mounts live in the data directory the caller deletes, or keeps,
 * by its own policy.
 */
export function executeAppTeardown(docker: DockerCliRunner, plan: AppTeardownPlan): void {
  for (const { containers, networks, volumes } of plan.projects) {
    if (containers.length > 0) {
      docker(['rm', '-f', ...containers]);
    }
    for (const network of networks) {
      docker(['network', 'rm', network]);
    }
    for (const volume of volumes) {
      docker(['volume', 'rm', volume]);
    }
  }
  if (plan.unmanaged.length > 0) {
    docker(['rm', '-f', ...plan.unmanaged]);
  }
}

/**
 * Removes every Hub-managed marketplace app: its containers, its project networks, and, when
 * `removeVolumes` is set, its named volumes. Also removes any other container on a Hub network
 * (see {@link planAppTeardown}). Returns what it removed.
 *
 * Run this BEFORE deleting the Hub state the apps depend on. Each app is its own compose project
 * outside the Hub stack, with bind mounts under the Hub data directory and Hub-issued credentials
 * in its environment. On core-2 (2026-09-17) a wipe that removed only the Hub stack and its data
 * directory left ci-memory, OpenClaw, Hermes, and import-tools running against deleted bind
 * sources, and their Hub MCP calls to the fresh Hub returned 401.
 */
export function removeManagedAppProjects(docker: DockerCliRunner, options: { removeVolumes: boolean }): AppTeardownPlan {
  const plan = planAppTeardown(docker, options);
  executeAppTeardown(docker, plan);
  return plan;
}

/**
 * Build all removable Hub state directories for the current platform.
 */
export function getHubStateDirs(input?: { cwd?: string; homeDir?: string; platform?: NodeJS.Platform }): CleanupDirTarget[] {
  const cwd = input?.cwd ?? process.cwd();
  const homeDir = input?.homeDir ?? homedir();
  const platform = input?.platform ?? process.platform;
  const pathLib = platform === 'win32' ? path.win32 : path.posix;

  if (platform === 'win32') {
    const appData = process.env.APPDATA || pathLib.join(homeDir, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || pathLib.join(homeDir, 'AppData', 'Local');

    if (!isWithinPath(appData, homeDir, platform) || !isWithinPath(localAppData, homeDir, platform)) {
      throw new Error('Windows app data directories point outside the user home directory; refusing cleanup.');
    }

    return [
      ...WINDOWS_STATE_NAMES.map((name) => ({ path: pathLib.join(appData, name), label: 'roaming data dir' })),
      ...WINDOWS_STATE_NAMES.map((name) => ({ path: pathLib.join(localAppData, name), label: 'local data dir' })),
      { path: pathLib.join(cwd, '.local'), label: 'repo-local .local' },
      { path: pathLib.join(cwd, '.config'), label: 'repo-local .config' },
      { path: pathLib.join(cwd, '.cache'), label: 'repo-local .cache' },
    ];
  }

  const xdgDataHome = usableXdgDataHome(process.env, homeDir) || pathLib.join(homeDir, '.local', 'share');
  const xdgConfigHome = process.env.XDG_CONFIG_HOME || pathLib.join(homeDir, '.config');
  const xdgCacheHome = process.env.XDG_CACHE_HOME || pathLib.join(homeDir, '.cache');

  if (
    !isWithinPath(xdgDataHome, homeDir, platform) ||
    !isWithinPath(xdgConfigHome, homeDir, platform) ||
    !isWithinPath(xdgCacheHome, homeDir, platform)
  ) {
    throw new Error('XDG directories point outside the user home directory; refusing cleanup.');
  }

  return [
    ...HUB_STATE_NAMES.map((name) => ({ path: pathLib.join(xdgDataHome, name), label: 'data dir' })),
    ...HUB_STATE_NAMES.map((name) => ({ path: pathLib.join(xdgConfigHome, name), label: 'config dir' })),
    ...HUB_STATE_NAMES.map((name) => ({ path: pathLib.join(xdgCacheHome, name), label: 'cache dir' })),
    { path: pathLib.join(cwd, '.local'), label: 'repo-local .local' },
    { path: pathLib.join(cwd, '.config'), label: 'repo-local .config' },
    { path: pathLib.join(cwd, '.cache'), label: 'repo-local .cache' },
  ];
}

/**
 * The desktop's tunnel folder: `tunnel` beside the `companion-hub` data folder that
 * {@link getHubStateDirs} lists (compose mounts `${ROOT_FOLDER_HOST}/../tunnel`).
 */
export function getDesktopTunnelDir(input?: { homeDir?: string; platform?: NodeJS.Platform }): string {
  const homeDir = input?.homeDir ?? homedir();
  const platform = input?.platform ?? process.platform;
  const pathLib = platform === 'win32' ? path.win32 : path.posix;
  const dataHome =
    platform === 'win32'
      ? process.env.APPDATA || pathLib.join(homeDir, 'AppData', 'Roaming')
      : usableXdgDataHome(process.env, homeDir) || pathLib.join(homeDir, '.local', 'share');
  return pathLib.join(dataHome, 'tunnel');
}

/**
 * True when `content` is a cloudflared tunnel token: base64 of a JSON object holding the account
 * tag (a), tunnel id (t) and tunnel secret (s). Missing base64 padding is accepted.
 */
export function isCloudflaredTunnelToken(content: string): boolean {
  const encoded = content.replace(/\s/g, '');
  // Buffer.from skips characters that are not base64, so reject them before decoding.
  if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && ['a', 't', 's'].every((key) => key in parsed);
  } catch {
    return false;
  }
}

const TUNNEL_TOKEN_MAX_BYTES = 4096;

function lstatOrNull(targetPath: string) {
  try {
    return lstatSync(targetPath, { throwIfNoEntry: false }) ?? null;
  } catch {
    return null;
  }
}

/** True for a real (not symlinked) folder with nothing in it. */
export function isEmptyRealDir(targetPath: string): boolean {
  const stat = lstatOrNull(targetPath);
  if (!stat?.isDirectory()) {
    return false;
  }
  try {
    return readdirSync(targetPath).length === 0;
  } catch {
    return false;
  }
}

function readRegularFile(targetPath: string, maxBytes = Number.POSITIVE_INFINITY): string | null {
  const stat = lstatOrNull(targetPath);
  if (!stat?.isFile() || stat.size > maxBytes) {
    return null;
  }
  try {
    return readFileSync(targetPath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Hub files in a tunnel folder beside a data folder. `tunnel` is a generic name another program
 * could also use, so this applies the package uninstallers' rules: the token only when it is a
 * cloudflared token, and the markers only when they carry a tunnelId. Symlinked files are skipped.
 * `cihub reset` and `cihub clean` use the same rules on an appliance (removeHubTunnelFiles).
 */
export function hubFilesInTunnelDir(tunnelDir: string, pathLib: typeof path.posix = path): string[] {
  const files: string[] = [];
  const tokenPath = pathLib.join(tunnelDir, 'token');
  const token = readRegularFile(tokenPath, TUNNEL_TOKEN_MAX_BYTES);
  if (token !== null && isCloudflaredTunnelToken(token)) {
    files.push(tokenPath);
  }
  for (const marker of ['registration.json', 'leftover.json']) {
    const markerPath = pathLib.join(tunnelDir, marker);
    if (readRegularFile(markerPath)?.includes('"tunnelId"')) {
      files.push(markerPath);
    }
  }
  const clearedMarker = pathLib.join(tunnelDir, '.user-cleared-token');
  const clearedStat = lstatOrNull(clearedMarker);
  if (clearedStat && !clearedStat.isDirectory()) {
    files.push(clearedMarker);
  }
  return files;
}

function isSafeDeletionTarget(targetPath: string, cwd: string, homeDir: string, platform: NodeJS.Platform): boolean {
  return isWithinPath(targetPath, homeDir, platform) || (isWithinPath(cwd, homeDir, platform) && isWithinPath(targetPath, cwd, platform));
}

function runCommand(
  file: string,
  args: string[],
  options: {
    dryRun: boolean;
    logger: CleanupLogger;
    cwd: string;
    execFile: (file: string, args: string[], cwd?: string) => ExecResult;
    summary: CleanupSummary;
  },
): string {
  const command = [file, ...args].join(' ');
  options.summary.attemptedCommands += 1;
  if (options.dryRun) {
    options.logger.info(`[dry-run] ${command}`);
    return '';
  }

  const result = options.execFile(file, args, options.cwd);
  if (!result.ok) {
    options.summary.failedCommands += 1;
    options.logger.warn(`Command failed: ${command}`);
    if (result.error) {
      options.logger.warn(result.error);
    }
    return '';
  }
  return result.stdout;
}

function removeDirectory(
  target: CleanupDirTarget,
  options: {
    dryRun: boolean;
    cwd: string;
    homeDir: string;
    platform: NodeJS.Platform;
    logger: CleanupLogger;
    exists: (targetPath: string) => boolean;
    removeDir: (targetPath: string) => void;
    summary: CleanupSummary;
  },
) {
  if (!isSafeDeletionTarget(target.path, options.cwd, options.homeDir, options.platform)) {
    options.summary.failedDirs += 1;
    options.logger.error(`Blocked unsafe path: ${target.path}`);
    return;
  }

  if (!options.exists(target.path)) {
    options.summary.skippedDirs += 1;
    return;
  }

  if (options.dryRun) {
    options.summary.removedDirs += 1;
    options.logger.info(`[dry-run] remove ${target.label}: ${target.path}`);
    return;
  }

  try {
    options.removeDir(target.path);
    options.summary.removedDirs += 1;
    options.logger.info(`Removed ${target.label}: ${target.path}`);
  } catch (error) {
    options.summary.failedDirs += 1;
    options.logger.error(`Failed removing ${target.label}: ${target.path}`);
    options.logger.error(String(error));
  }
}

/**
 * Execute the Hub uninstall cleanup workflow.
 */
export function runHubCleanup(options?: CleanupOptions): CleanupSummary {
  const cwd = options?.cwd ?? process.cwd();
  const homeDir = options?.homeDir ?? homedir();
  const platform = options?.platform ?? process.platform;
  const pathLib = platform === 'win32' ? path.win32 : path.posix;
  const dryRun = options?.dryRun ?? false;
  const logger = options?.logger ?? defaultLogger();
  const execFile = options?.execFile ?? defaultExecFile;
  const exists = options?.exists ?? existsSync;
  const removeDirImpl = options?.removeDir ?? ((targetPath: string) => rmSync(targetPath, { recursive: true, force: true }));

  const summary: CleanupSummary = {
    removedDirs: 0,
    skippedDirs: 0,
    failedDirs: 0,
    attemptedCommands: 0,
    failedCommands: 0,
    dryRun,
  };

  logger.info(`Starting comprehensive uninstall cleanup${dryRun ? ' (dry-run)' : ''}`);

  const commandContext = {
    dryRun,
    logger,
    cwd,
    execFile,
    summary,
  };
  const docker = (...args: string[]) => runCommand('docker', args, commandContext);

  // Collect the unique image IDs used by a compose project's containers (pulled or built). Must be
  // called before those containers are removed, because the refs can't be recovered after.
  const snapshotProjectImages = (project: string, containerIds: string[]): string[] => {
    const fromContainers = containerIds.flatMap((id) => parseNames(docker('inspect', '--format', '{{.Image}}', id)));
    const labeled = parseNames(docker('images', ...byComposeProject(project), '-q'));
    return [...new Set([...fromContainers, ...labeled])];
  };

  const containerNames = new Set<string>();
  const containerListings = [
    ...HUB_NETWORK_NAMES.map((network) => ['ps', '-a', '--filter', `network=${network}`, '--format', '{{.Names}}']),
    ...HUB_STACK_PROJECT_NAMES.map((project) => ['ps', '-a', ...byComposeProject(project), '--format', '{{.Names}}']),
    ['ps', '-a', '--filter', 'name=e2e-', '--format', '{{.Names}}'],
  ];

  for (const args of containerListings) {
    const output = docker(...args);
    for (const names of parseNames(output)) {
      containerNames.add(containerNameOf(names));
    }
  }

  // Snapshot Hub stack image IDs before any containers are removed.
  const hubImages = [
    ...new Set(
      HUB_STACK_PROJECT_NAMES.flatMap((project) =>
        snapshotProjectImages(project, parseNames(docker('ps', '-a', ...byComposeProject(project), '-q'))),
      ),
    ),
  ];

  // Marketplace apps installed by Hub run as their own compose projects (<app>_<store>),
  // separate from the Hub stack. Hub stamps every managed app container with canonical and
  // legacy managed labels (store-agnostic). Tear these down BEFORE the shared Hub networks
  // below: main app services attach to those networks, so removing either while an app
  // container is still attached would fail. The Hub stack projects are excluded here; the
  // dedicated Hub teardown (which also snapshots Hub images) handles them.
  const managedProjects = findManagedAppProjects((args) => parseNames(docker(...args)));

  const sharedNetworks = new Set<string>(['bridge', 'host', 'none', ...HUB_NETWORK_NAMES]);
  for (const project of managedProjects) {
    const containerIds = parseNames(docker('ps', '-a', ...byComposeProject(project), '-q'));
    const projectImages = snapshotProjectImages(project, containerIds);

    for (const containerId of containerIds) {
      docker('rm', '-f', containerId);
    }

    const projectNetworks = docker('network', 'ls', ...byComposeProject(project), '--format', '{{.Name}}');
    for (const networkName of parseNames(projectNetworks).filter((name) => !sharedNetworks.has(name))) {
      docker('network', 'rm', networkName);
    }

    const projectVolumes = docker('volume', 'ls', ...byComposeProject(project), '--format', '{{.Name}}');
    for (const volumeName of parseNames(projectVolumes)) {
      docker('volume', 'rm', volumeName);
    }

    for (const imageId of projectImages) {
      docker('image', 'rm', '-f', imageId);
    }
  }

  // Hub stack teardown — safe to remove the shared networks now that app containers are gone.
  for (const name of containerNames) {
    docker('rm', '-f', name);
  }

  const volumeOutput = docker('volume', 'ls', '--format', '{{.Name}}');
  for (const volumeName of parseNames(volumeOutput).filter(isRelatedVolume)) {
    docker('volume', 'rm', volumeName);
  }

  for (const network of HUB_NETWORK_NAMES) {
    docker('network', 'rm', network);
  }

  const networkOutput = docker('network', 'ls', '--format', '{{.Name}}');
  for (const networkName of parseNames(networkOutput).filter((name) => name.includes('e2e'))) {
    docker('network', 'rm', networkName);
  }

  for (const imageId of hubImages) {
    docker('image', 'rm', '-f', imageId);
  }

  for (const project of HUB_STACK_PROJECT_NAMES) {
    docker('compose', '--project-name', project, '-f', 'docker-compose.prod.yml', 'down', '-v');
  }
  docker('compose', '--project-name', 'ci-hub', '-f', 'docker-compose.local.yml', 'down', '-v');

  if (platform !== 'win32' && exists('/tmp/.buildx-cache')) {
    runCommand('rm', ['-rf', '/tmp/.buildx-cache'], commandContext);
  }

  const stateDirs = getHubStateDirs({ cwd, homeDir, platform });
  const directTargets: CleanupDirTarget[] = [
    { path: pathLib.join(cwd, '.internal'), label: '.internal' },
    { path: pathLib.join(cwd, 'tunnel', 'token'), label: 'tunnel/token' },
    // The backend's markers beside the token; a leftover registration.json would let a later token start the tunnel.
    { path: pathLib.join(cwd, 'tunnel', 'registration.json'), label: 'tunnel/registration.json' },
    { path: pathLib.join(cwd, 'tunnel', 'leftover.json'), label: 'tunnel/leftover.json' },
    { path: pathLib.join(cwd, 'tunnel', '.user-cleared-token'), label: 'tunnel/.user-cleared-token' },
    { path: pathLib.join(cwd, 'tunnel', 'certs'), label: 'tunnel/certs' },
    ...stateDirs,
  ];

  const removeOptions = {
    dryRun,
    cwd,
    homeDir,
    platform,
    logger,
    exists,
    removeDir: removeDirImpl,
    summary,
  };

  for (const target of directTargets) {
    removeDirectory(target, removeOptions);
  }

  // The desktop data folder removed above keeps its tunnel token beside it, not inside it, so a
  // reinstall would otherwise reconnect the old tunnel before pairing.
  const desktopTunnelDir = getDesktopTunnelDir({ homeDir, platform });
  // Never reach through a symlinked folder: paths below it would resolve somewhere else.
  if (lstatOrNull(desktopTunnelDir)?.isDirectory()) {
    for (const filePath of hubFilesInTunnelDir(desktopTunnelDir, pathLib)) {
      removeDirectory({ path: filePath, label: 'desktop tunnel file' }, removeOptions);
    }
    // The backend creates certs/ empty; the folder itself goes only once nothing else is left in it.
    for (const dirPath of [pathLib.join(desktopTunnelDir, 'certs'), desktopTunnelDir]) {
      if (!dryRun && isEmptyRealDir(dirPath)) {
        removeDirectory({ path: dirPath, label: 'empty desktop tunnel dir' }, removeOptions);
      }
    }
  }

  logger.info('Cleanup complete');
  logger.info(
    `Summary: removedDirs=${summary.removedDirs} skippedDirs=${summary.skippedDirs} failedDirs=${summary.failedDirs} attemptedCommands=${summary.attemptedCommands} failedCommands=${summary.failedCommands}`,
  );

  return summary;
}
