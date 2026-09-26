/**
 * Stopping, wiping, and removing a Hub install.
 *
 * The four levels are deliberately distinct and are documented in docs/RESET_RUNBOOK.md:
 * `down` stops containers, `clean` removes generated files, `reset` wipes one environment's
 * data, and `uninstall` removes the whole install.
 */

import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { dockerBindMountPath } from '../heal-hub-bind-mounts.js';
import {
  type AppTeardownPlan,
  executeAppTeardown,
  isRelatedVolume,
  parseNames,
  planAppTeardown,
  removeManagedAppProjects,
} from '../hub-cleanup-lib.js';
import { buildEnvOverrides, getEnvFileOrExit } from './cli-compose-env.js';
import { startHub } from './cli-lifecycle.js';
import { run, runBestEffort, runCapture } from './cli-proc.js';
import { confirmDestructiveAction } from './cli-prompt.js';
import { isApplianceMode, requireRepoRoot } from './cli-repo-context.js';
import type { HubEnv } from './cli-types.js';
import { dim, printMessageBox } from './cli-ui.js';
import { composeArgsForContext, envOverridesForContext, type HubContext, requireRepoOrApplianceContext, resolveHubContext } from './hub-context.js';
import { CANONICAL_DATA_DIR_NAME, resolveRootFolderHost } from './paths.js';

function removeProjectContainers(project: string): void {
  const { stdout, ok } = runCapture('docker', ['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}']);
  if (!ok || !stdout) return;
  const ids = stdout
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
  if (ids.length === 0) return;
  runBestEffort('docker', ['rm', '-f', ...ids]);
}

function removeLeftoverProjectContainers(): void {
  removeProjectContainers('ci-hub');
}

/**
 * Label/volume/network teardown for a prod install, independent of any env file or compose file.
 * Used as the appliance fallback so a broken or partially provisioned Hub can still be cleaned.
 */
function applianceDockerTeardown(removeVolumes: boolean): void {
  for (const project of ['ci-hub', 'ci-os-hub']) {
    removeProjectContainers(project);
  }
  if (!removeVolumes) return;

  const { stdout, ok } = runCapture('docker', ['volume', 'ls', '--format', '{{.Name}}']);
  if (ok && stdout) {
    for (const volume of parseNames(stdout).filter(isRelatedVolume)) {
      runBestEffort('docker', ['volume', 'rm', volume]);
    }
  }
  for (const network of ['ci_hub_network', 'ci-hub_network', 'ci_os_hub_network', 'ci-os-hub_network']) {
    runBestEffort('docker', ['network', 'rm', network]);
  }
}

/** Tear down a desktop-installed prod Hub from anywhere (canonical data dir). */
function downApplianceHub(ctx: HubContext, options?: { volumes?: boolean }) {
  const dataDir = ctx.dataDir as string;
  const composePath = ctx.composeFiles[0];
  const composeExists = composePath !== undefined && existsSync(composePath) && existsSync(ctx.envFile);
  printMessageBox(options?.volumes ? 'Resetting prod hub runtime' : 'Stopping prod hub', [`Data dir: ${dataDir}`], 'yellow');

  if (composeExists) {
    const args = composeArgsForContext(ctx);
    args.push('down');
    if (options?.volumes) args.push('-v', '--remove-orphans');
    runBestEffort('docker', args, envOverridesForContext(ctx), dataDir);
  }
  // Fallback: remove anything the compose teardown missed (or everything when no seed is present).
  applianceDockerTeardown(Boolean(options?.volumes));
}

export function downHub(env: HubEnv, options?: { volumes?: boolean }) {
  if (isApplianceMode()) {
    requireRepoOrApplianceContext('cihub down', 'allow-missing');
    downApplianceHub(resolveHubContext(env), options);
    return;
  }
  const envFileName = getEnvFileOrExit(env);
  const envOverrides = buildEnvOverrides(envFileName);
  const args = composeArgsForContext(resolveHubContext(env));
  args.push('down');
  if (options?.volumes) args.push('-v', '--remove-orphans');
  printMessageBox(options?.volumes ? 'Resetting hub runtime' : 'Stopping hub', [`Environment: ${env}`], 'yellow');
  run('docker', args, envOverrides);
  removeLeftoverProjectContainers();
}

export async function restartHub(env: HubEnv, detached = false) {
  downHub(env);
  await startHub(env === 'local' ? 'local-dev' : detached ? 'detached' : 'attached', env);
}

function pathIsWithin(base: string, target: string): boolean {
  const normalizedBase = path.resolve(base);
  const normalizedTarget = path.resolve(target);
  return normalizedTarget === normalizedBase || normalizedTarget.startsWith(`${normalizedBase}${path.sep}`);
}

function removeDirectoryTarget(targetPath: string, label: string, removed: string[], skipped: string[]) {
  if (!existsSync(targetPath)) {
    skipped.push(`${label}: ${targetPath}`);
    return;
  }
  const repoRoot = process.cwd();
  const homeDir = process.env.HOME || process.env.USERPROFILE || repoRoot;
  if (!pathIsWithin(repoRoot, targetPath) && !pathIsWithin(homeDir, targetPath)) {
    throw new Error(`Refusing to remove ${targetPath}; it is outside the repository and user home directory.`);
  }
  rmSync(targetPath, { recursive: true, force: true });
  removed.push(`${label}: ${targetPath}`);
}

/**
 * Full wipe of a canonical prod data dir (clean slate; re-registration required afterward).
 * Removes the entire `<data dir>/companion-hub` tree, which holds the seeded `.env`, compose file,
 * app/data mounts, and the Cloudflare tunnel token. Guarded so we only ever delete a folder named
 * `companion-hub` inside the user's data/home directory.
 */
function cleanApplianceHub(ctx: HubContext, options: CleanHubOptions) {
  const dataDir = ctx.dataDir as string;
  const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
  const safe = path.basename(dataDir) === CANONICAL_DATA_DIR_NAME && pathIsWithin(homeDir, dataDir);
  if (!safe) {
    printMessageBox(
      'Refusing to wipe data dir',
      [`Unexpected canonical data dir: ${dataDir}`, `Expected a "${CANONICAL_DATA_DIR_NAME}" folder inside your user data directory.`],
      'red',
    );
    process.exit(2);
  }
  if (!options.appsAlreadyRemoved) {
    removeAppContainersBeforeDeletingData();
  }
  if (existsSync(dataDir)) {
    rmSync(dataDir, { recursive: true, force: true });
    printMessageBox('Prod Hub data wiped', [`removed: ${dataDir}`], 'yellow');
  } else {
    printMessageBox('Prod Hub data wiped', [dim(`already absent: ${dataDir}`)], 'yellow');
  }
}

const dockerCapture = (args: string[]) => runCapture('docker', args);

type CleanHubOptions = {
  /** `cihub reset` has already removed the apps, with their volumes, before `down`. */
  appsAlreadyRemoved?: boolean;
};

/**
 * `cihub clean` deletes the data directory every app bind-mounts, so the app containers go first,
 * as in `cihub reset` (see removeManagedAppProjects). `cihub down` stops only the Hub's own
 * project, so `cihub down && cihub clean` otherwise left apps running against deleted directories,
 * which is what nuke.sh did to core-2 (2026-09-17).
 *
 * Named volumes stay. Clean removes files, and the Hub database volume, which still lists the
 * apps, survives it too.
 */
function removeAppContainersBeforeDeletingData() {
  const removed = describeAppTeardown(removeManagedAppProjects(dockerCapture, { removeVolumes: false }));
  if (removed.length > 0) {
    printMessageBox('Removed installed app containers', [...removed, dim('Their named volumes were kept.')], 'yellow');
  }
}

/** One line per app, plus its networks and volumes, then the containers the Hub never installed. */
export function describeAppTeardown(plan: AppTeardownPlan): string[] {
  const lines: string[] = [];
  for (const { project, containers, networks, volumes } of plan.projects) {
    lines.push(`${project}: ${containers.length > 0 ? containers.join(', ') : 'no containers'}`);
    if (networks.length > 0) lines.push(dim(`  networks: ${networks.join(', ')}`));
    if (volumes.length > 0) lines.push(dim(`  volumes: ${volumes.join(', ')}`));
  }
  if (plan.unmanaged.length > 0) {
    lines.push('On the Hub network but not installed by the Hub (container only):');
    for (const name of plan.unmanaged) lines.push(`  ${name}`);
  }
  return lines;
}

/** Where reset deletes host files: the whole canonical tree (appliance), or hub-data and tunnel (checkout). */
function hostDataTargets(env: HubEnv): string[] {
  if (isApplianceMode()) {
    const { dataDir } = resolveHubContext(env);
    return dataDir ? [dataDir] : [];
  }
  const rootFolderHost = resolveRootFolderHost(getEnvFileOrExit(env));
  return [rootFolderHost, path.resolve(rootFolderHost, '..', 'tunnel')];
}

/**
 * An unlisted app is not an absent one. Deleting the data dir while Docker is down leaves every app
 * with a restart policy to come back with the daemon, against the deleted state; nuke.sh refuses for
 * the same reason (managed-app-teardown.sh).
 */
function listedOrRefuse(plan: AppTeardownPlan): boolean {
  if (plan.listed) return true;
  printMessageBox(
    'Reset stopped; nothing was removed',
    [
      'Docker did not list its containers, so reset cannot find the installed apps to remove first.',
      'Start Docker, or give this user access to it, and run the reset again.',
    ],
    'red',
  );
  process.exitCode = 1;
  return false;
}

export function cleanHub(env: HubEnv, options: CleanHubOptions = {}) {
  if (isApplianceMode()) {
    requireRepoOrApplianceContext('cihub clean', 'allow-missing');
    cleanApplianceHub(resolveHubContext(env), options);
    return;
  }
  requireRepoRoot('cihub clean');
  const envFileName = getEnvFileOrExit(env);
  const rootFolderHost = resolveRootFolderHost(envFileName);
  const tunnelDir = path.resolve(rootFolderHost, '..', 'tunnel');
  if (!options.appsAlreadyRemoved) {
    removeAppContainersBeforeDeletingData();
  }
  const removed: string[] = [];
  const skipped: string[] = [];
  removeDirectoryTarget(rootFolderHost, 'root folder', removed, skipped);
  removeDirectoryTarget(tunnelDir, 'tunnel dir', removed, skipped);
  printMessageBox('Environment files cleaned', [...removed, ...skipped.map((line) => dim(`skipped ${line}`))], 'yellow');
}

export async function resetHub(env: HubEnv, force: boolean, dryRun = false): Promise<boolean> {
  const appliance = isApplianceMode();
  if (appliance) {
    requireRepoOrApplianceContext('cihub reset', 'allow-missing');
  } else {
    requireRepoRoot('cihub reset');
  }
  const label = appliance ? 'prod (canonical install)' : env;
  // Shown before the prompt, because the list can hold containers the Hub never installed and the
  // operator should see those by name before agreeing to remove them. See planAppTeardown.
  const plan = planAppTeardown(dockerCapture, { removeVolumes: true });
  if (!listedOrRefuse(plan)) return false;
  const planned = describeAppTeardown(plan);
  printMessageBox(
    `Apps and containers this reset ${dryRun ? 'would remove' : 'removes'}`,
    planned.length > 0 ? planned : [dim('None: no installed apps, and nothing else on the Hub network.')],
    'yellow',
  );
  if (dryRun) {
    printMessageBox(
      'Dry run: nothing was removed',
      [
        'After the apps, reset runs `docker compose down -v` for the ci-hub project (the Hub containers and volumes such as ci_hub_pgdata)',
        'and deletes this host data:',
        ...hostDataTargets(env).map((target) => `  ${target}`),
      ],
      'cyan',
    );
    return false;
  }
  const confirmed = await confirmDestructiveAction(
    `Resetting ${label}`,
    force,
    `Reset ${label} runtime state (installed apps, containers, volumes, and host files)? [y/N]: `,
  );
  if (!confirmed) {
    printMessageBox('Reset cancelled', ['Left runtime state untouched.'], 'yellow');
    return false;
  }
  // Apps go first. `down` below only knows the Hub's own project, and the data directory this reset
  // deletes holds every app's bind mounts; apps left running keep Hub credentials the reset Hub
  // rejects, and a fresh Hub database has no row through which to stop them. Listed again because
  // the prompt can stay open while something starts another container.
  const current = planAppTeardown(dockerCapture, { removeVolumes: true });
  if (!listedOrRefuse(current)) return false;
  executeAppTeardown(dockerCapture, current);
  const removed = describeAppTeardown(current);
  if (removed.length > 0) {
    printMessageBox('Removed installed apps', removed, 'yellow');
  }
  downHub(env, { volumes: true });
  verifyHubVolumesRemoved();
  try {
    cleanHub(env, { appsAlreadyRemoved: true });
  } catch (error) {
    printMessageBox('Host cleanup reported an error', [String(error)], 'yellow');
  }
  cleanRootOwnedHubData(env);
  printMessageBox(
    'Reset complete',
    ['Hub runtime state, volumes, and host data were removed.', 'Re-launch CI Hub or run `cihub up dev` (or `cihub up prod`) to start fresh.'],
    'green',
  );
  return true;
}

function verifyHubVolumesRemoved() {
  const { stdout } = runCapture('docker', ['volume', 'ls', '--format', '{{.Name}}']);
  const lingering = stdout
    .split('\n')
    .map((value) => value.trim())
    .filter((value) => value.includes('ci_hub_pgdata') || value.includes('ci_hub_app_data') || value.includes('hub_tailscale_state'));

  if (lingering.length === 0) {
    return;
  }

  printMessageBox('Removing lingering Hub volumes', lingering, 'yellow');
  for (const volume of lingering) {
    runBestEffort('docker', ['volume', 'rm', volume]);
  }
}

function cleanRootOwnedHubData(env: HubEnv) {
  if (isApplianceMode()) return;

  const envFileName = getEnvFileOrExit(env);
  const rootFolderHost = resolveRootFolderHost(envFileName);
  if (!existsSync(rootFolderHost)) return;

  try {
    rmSync(rootFolderHost, { recursive: true, force: true });
    return;
  } catch {
    // Fall through to a root-owned bind mount cleanup via Docker.
  }

  if (!existsSync(rootFolderHost)) return;

  const hostPath = path.resolve(rootFolderHost);
  printMessageBox('Cleaning root-owned hub data via Docker', [`Target: ${hostPath}`], 'yellow');
  runBestEffort('docker', [
    'run',
    '--rm',
    '-v',
    `${dockerBindMountPath(hostPath)}:/d`,
    'alpine',
    'sh',
    '-c',
    'rm -rf /d/* /d/.[!.]* /d/..?* 2>/dev/null || true',
  ]);
  try {
    rmSync(rootFolderHost, { recursive: true, force: true });
  } catch {
    // Best effort \u2014 directory may still contain root-owned entries.
  }
}

export async function recreateHub(env: HubEnv, detached = false, force = false) {
  const resetComplete = await resetHub(env, force);
  if (!resetComplete) return;
  await startHub(env === 'local' ? 'local-dev' : detached ? 'detached' : 'attached', env);
}
