import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

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
  execCommand?: (command: string, cwd?: string) => ExecResult;
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

function defaultExecCommand(command: string, cwd = process.cwd()): ExecResult {
  try {
    const stdout = execSync(command, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return { ok: true, stdout };
  } catch (error) {
    return {
      ok: false,
      stdout: '',
      error: String(error),
    };
  }
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
    volumeName.startsWith('runtipi_') ||
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

  const xdgDataHome = process.env.XDG_DATA_HOME || pathLib.join(homeDir, '.local', 'share');
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

function isSafeDeletionTarget(targetPath: string, cwd: string, homeDir: string, platform: NodeJS.Platform): boolean {
  return isWithinPath(targetPath, homeDir, platform) || (isWithinPath(cwd, homeDir, platform) && isWithinPath(targetPath, cwd, platform));
}

function runCommand(
  command: string,
  options: {
    dryRun: boolean;
    logger: CleanupLogger;
    cwd: string;
    execCommand: (cmd: string, cwd?: string) => ExecResult;
    summary: CleanupSummary;
  },
): string {
  options.summary.attemptedCommands += 1;
  if (options.dryRun) {
    options.logger.info(`[dry-run] ${command}`);
    return '';
  }

  const result = options.execCommand(command, options.cwd);
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
  const execCommand = options?.execCommand ?? defaultExecCommand;
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
    execCommand,
    summary,
  };

  const containerNames = new Set<string>();
  const containerCommands = [
    'docker ps -a --filter network=ci_os_hub_network --format "{{.Names}}"',
    'docker ps -a --filter network=ci-os-hub_network --format "{{.Names}}"',
    'docker ps -a --filter label=com.docker.compose.project=ci-os-hub --format "{{.Names}}"',
    'docker ps -a --filter label=com.docker.compose.project=ci-hub --format "{{.Names}}"',
    'docker ps -a --filter label=com.docker.compose.project=runtipi --format "{{.Names}}"',
    'docker ps -a --filter "name=e2e-" --format "{{.Names}}"',
  ];

  for (const command of containerCommands) {
    const output = runCommand(command, commandContext);
    for (const name of parseNames(output)) {
      containerNames.add(name);
    }
  }

  for (const name of containerNames) {
    runCommand(`docker rm -f ${name}`, commandContext);
  }

  const volumeOutput = runCommand('docker volume ls --format "{{.Name}}"', commandContext);
  for (const volumeName of parseNames(volumeOutput).filter(isRelatedVolume)) {
    runCommand(`docker volume rm ${volumeName}`, commandContext);
  }

  runCommand('docker network rm ci_os_hub_network', commandContext);
  runCommand('docker network rm ci-os-hub_network', commandContext);

  const networkOutput = runCommand('docker network ls --format "{{.Name}}"', commandContext);
  for (const networkName of parseNames(networkOutput).filter((name) => name.includes('e2e'))) {
    runCommand(`docker network rm ${networkName}`, commandContext);
  }

  runCommand('docker compose --project-name ci-os-hub -f docker-compose.prod.yml down -v', commandContext);
  runCommand('docker compose --project-name ci-hub -f docker-compose.prod.yml down -v', commandContext);
  runCommand('docker compose --project-name runtipi -f docker-compose.prod.yml down -v', commandContext);
  runCommand('docker compose --project-name ci-hub -f docker-compose.local.yml down -v', commandContext);

  if (platform !== 'win32' && exists('/tmp/.buildx-cache')) {
    runCommand('rm -rf /tmp/.buildx-cache', commandContext);
  }

  const stateDirs = getHubStateDirs({ cwd, homeDir, platform });
  const directTargets: CleanupDirTarget[] = [
    { path: pathLib.join(cwd, '.internal'), label: '.internal' },
    { path: pathLib.join(cwd, 'tunnel', 'token'), label: 'tunnel/token' },
    { path: pathLib.join(cwd, 'tunnel', 'certs'), label: 'tunnel/certs' },
    ...stateDirs,
  ];

  for (const target of directTargets) {
    removeDirectory(target, {
      dryRun,
      cwd,
      homeDir,
      platform,
      logger,
      exists,
      removeDir: removeDirImpl,
      summary,
    });
  }

  logger.info('Cleanup complete');
  logger.info(
    `Summary: removedDirs=${summary.removedDirs} skippedDirs=${summary.skippedDirs} failedDirs=${summary.failedDirs} attemptedCommands=${summary.attemptedCommands} failedCommands=${summary.failedCommands}`,
  );

  return summary;
}
