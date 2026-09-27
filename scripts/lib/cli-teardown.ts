/**
 * Stopping, wiping, and removing a Hub install.
 *
 * The four levels are deliberately distinct and are documented in docs/RESET_RUNBOOK.md:
 * `down` stops containers, `clean` removes generated files, `reset` wipes one environment's
 * data, and `uninstall` removes the whole install.
 */

import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { dockerBindMountPath } from '../heal-hub-bind-mounts.js';
import {
  type AppTeardownPlan,
  type DockerCliRunner,
  executeAppTeardown,
  hubFilesInTunnelDir,
  isEmptyRealDir,
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
import { BASE_COMMAND, type HubEnv } from './cli-types.js';
import { dim, printMessageBox } from './cli-ui.js';
import { effectiveDockerHost, getProcessDockerEnginePin } from './docker-engine.js';
import { GPU_PROBE_INTERVAL_SECONDS, GPU_PROBE_TIMER_UNIT } from './gpu-probe-timer.js';
import {
  describeBlockedFolders,
  findFoldersBlockingRemoval,
  type HostDataRemoval,
  removeHostDataTarget,
  rootRemovalCommand,
} from './host-data-removal.js';
import { composeArgsForContext, envOverridesForContext, type HubContext, requireRepoOrApplianceContext, resolveHubContext } from './hub-context.js';
import { CANONICAL_DATA_DIR_NAME, resolveRootFolderHost } from './paths.js';

/** `docker`, pointed at the engine the Hub runs on. See {@link hubDocker}. */
type HubDocker = {
  capture: DockerCliRunner;
  bestEffort: (args: string[]) => boolean;
};

/**
 * `docker` pointed at the Hub's engine. `compose down` already used the engine the Hub is pinned to
 * (envOverridesForContext, `state/docker-engine.json`); the app teardown, the sweeps, the final
 * check, and the root container used the default one, so with two engines (Docker Desktop beside
 * colima or a WSL engine) reset could remove nothing from the Hub's engine and still find nothing left.
 *
 * The pin file is read up front and never re-resolved: it lives in the data dir this command
 * deletes, and resolving would write it back there. A pin `compose down` made meanwhile wins. A
 * checkout's compose is not pinned, so nothing here is either.
 */
function hubDocker(dataDir: string | undefined): HubDocker {
  const pinnedBeforeDelete = dataDir ? effectiveDockerHost({ dataDir, resolveIfMissing: false }) : null;
  const env = (): Record<string, string> => {
    const host = getProcessDockerEnginePin()?.dockerHost ?? pinnedBeforeDelete;
    return host ? { DOCKER_HOST: host } : {};
  };
  return {
    capture: (args) => runCapture('docker', args, env()),
    bestEffort: (args) => runBestEffort('docker', args, env()),
  };
}

function removeProjectContainers(project: string, docker: HubDocker): void {
  const { stdout, ok } = docker.capture(['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}']);
  if (!ok || !stdout) return;
  const ids = stdout
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
  if (ids.length === 0) return;
  docker.bestEffort(['rm', '-f', ...ids]);
}

/**
 * Label/volume/network teardown for a prod install, independent of any env file or compose file.
 * Used as the appliance fallback so a broken or partially provisioned Hub can still be cleaned.
 */
function applianceDockerTeardown(removeVolumes: boolean, docker: HubDocker): void {
  for (const project of ['ci-hub', 'ci-os-hub']) {
    removeProjectContainers(project, docker);
  }
  if (!removeVolumes) return;

  const { stdout, ok } = docker.capture(['volume', 'ls', '--format', '{{.Name}}']);
  if (ok && stdout) {
    for (const volume of parseNames(stdout).filter(isRelatedVolume)) {
      docker.bestEffort(['volume', 'rm', volume]);
    }
  }
  for (const network of ['ci_hub_network', 'ci-hub_network', 'ci_os_hub_network', 'ci-os-hub_network']) {
    docker.bestEffort(['network', 'rm', network]);
  }
}

/** Tear down a desktop-installed prod Hub from anywhere (canonical data dir). */
function downApplianceHub(ctx: HubContext, options?: { volumes?: boolean }) {
  const dataDir = ctx.dataDir as string;
  const composePath = ctx.composeFiles[0];
  const composeExists = composePath !== undefined && existsSync(composePath) && existsSync(ctx.envFile);
  printMessageBox(options?.volumes ? 'Resetting prod hub runtime' : 'Stopping prod hub', [`Data dir: ${dataDir}`], 'yellow');
  const docker = hubDocker(dataDir);

  if (composeExists) {
    const args = composeArgsForContext(ctx);
    args.push('down');
    if (options?.volumes) args.push('-v', '--remove-orphans');
    runBestEffort('docker', args, envOverridesForContext(ctx), dataDir);
  }
  // Fallback: remove anything the compose teardown missed (or everything when no seed is present).
  applianceDockerTeardown(Boolean(options?.volumes), docker);
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
  removeProjectContainers('ci-hub', hubDocker(undefined));
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

/** Inside `base` and not `base` itself. */
function pathIsStrictlyWithin(base: string, target: string): boolean {
  return pathIsWithin(base, target) && path.resolve(target) !== path.resolve(base);
}

/** The path with every symlink in it resolved, or as given when it does not exist. */
function realPathOrResolved(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

/**
 * Why a checkout's host data folder must not be deleted, or undefined when it may be. It must sit
 * inside the repository or the user's home, not be either one, and not hold the checkout itself:
 * ROOT_FOLDER_HOST comes from an env file or the environment, and `.`, `..`, or `$HOME` there must
 * not turn `cihub clean` into `rm -rf` of the repository, the folder above it, or the home
 * directory, followed by a root container that deletes whatever the user could not.
 *
 * Compared as real paths: process.cwd() is one already, and the repository reached through a
 * symlinked folder (on macOS `/var` itself is one) would otherwise read as some other folder in home.
 */
function checkoutTargetRefusal(target: string, repo: string, home: string): string | undefined {
  const [targetPath, repoRoot, homeDir] = [target, repo, home].map(realPathOrResolved);
  if (pathIsWithin(targetPath, repoRoot)) {
    return 'it is this repository or holds it, so it was not deleted. Check ROOT_FOLDER_HOST in the env file and the environment';
  }
  if (!pathIsStrictlyWithin(repoRoot, targetPath) && !pathIsStrictlyWithin(homeDir, targetPath)) {
    return 'it is not inside the repository or your home directory, so it was not deleted. Check ROOT_FOLDER_HOST in the env file and the environment';
  }
  return undefined;
}

/** Deletes a checkout's host data folder, unless {@link checkoutTargetRefusal} refuses it. */
function removeCheckoutTarget(targetPath: string, docker: HubDocker): HostDataRemoval {
  const repoRoot = process.cwd();
  const homeDir = process.env.HOME || process.env.USERPROFILE || repoRoot;
  const refused = existsSync(targetPath) ? checkoutTargetRefusal(targetPath, repoRoot, homeDir) : undefined;
  if (refused) {
    return { target: targetPath, existed: true, removed: false, rootContainer: 'not needed', refused, blocked: [], leftoverEntries: 0 };
  }
  return removeHostDataTarget(targetPath, { removeAsRoot: (hostPath) => removeViaRootContainer(hostPath, docker) });
}

/**
 * Deletes a host folder's contents as root through a throwaway container, for the files the Hub and
 * its apps wrote as root. Returns whether Docker started the container. The script ends in
 * `|| true`, so it exits 0 whatever it deleted; only checking the folder afterwards says whether it
 * worked. With rootless Docker the container's root is the login user, and it deletes no more than
 * the CLI could.
 *
 * A folder is emptied from inside. A file (a tunnel token or marker) is deleted from its folder,
 * which is mounted instead, because `/d/*` matches nothing when `/d` is the file itself; its name
 * reaches the script as an argument, never as script text.
 */
function removeViaRootContainer(hostPath: string, docker: HubDocker): boolean {
  printMessageBox('Cleaning root-owned hub data via Docker', [`Target: ${hostPath}`], 'yellow');
  let isFolder = true;
  try {
    isFolder = lstatSync(hostPath).isDirectory();
  } catch {
    // Gone already; the caller checks again afterwards.
  }
  const mount = `${dockerBindMountPath(isFolder ? hostPath : path.dirname(hostPath))}:/d`;
  const script = isFolder
    ? ['sh', '-c', 'rm -rf /d/* /d/.[!.]* /d/..?* 2>/dev/null || true']
    : ['sh', '-c', 'rm -rf -- "/d/$1" 2>/dev/null || true', 'sh', path.basename(hostPath)];
  return docker.bestEffort(['run', '--rm', '-v', mount, 'alpine', ...script]);
}

function currentUserLabel(): string {
  return typeof process.getuid === 'function' ? `this user (uid ${process.getuid()})` : 'this user';
}

/**
 * Names every host data folder that survived, the folders inside it that stopped the delete and
 * why, and the command that finishes the job. Sets a failing exit code, because a caller that
 * carried on (`cihub recreate`, a fleet script) would start a Hub on the old data.
 */
function reportHostDataLeftovers(results: HostDataRemoval[]): boolean {
  const survivors = results.filter((result) => !result.removed);
  if (survivors.length === 0) return true;
  const lines: string[] = [];
  for (const result of survivors) {
    if (result.refused) {
      lines.push(`${result.target}: ${result.refused}.`);
      continue;
    }
    const count = result.leftoverEntries;
    lines.push(`${result.target} is still there: ${count} ${count === 1 ? 'entry' : 'entries'} ${currentUserLabel()} cannot delete.`);
    lines.push(...describeBlockedFolders(result.blocked).map((line) => `  ${line}`));
    if (result.rootContainer === 'ran') {
      const permissionOnly = result.blocked.every((folder) => folder.code === 'EACCES' || folder.code === 'EPERM');
      lines.push(
        dim(
          `A root container (docker run --rm -v <folder>:/d alpine rm -rf) ran and did not delete them${permissionOnly ? '; with rootless Docker its root is your user' : ''}.`,
        ),
      );
    } else if (result.rootContainer === 'did not start') {
      lines.push(
        dim('The root container that deletes these (docker run --rm -v <folder>:/d alpine rm -rf) did not start; the Docker error is above.'),
      );
    }
    if (result.blocked.some((folder) => folder.code === 'EBUSY')) {
      lines.push('EBUSY: a running container or a mount still holds that path. `docker ps` and `findmnt` show which; stop it first.');
    }
    lines.push(`Delete it as root: ${rootRemovalCommand(result.target)}`);
  }
  printMessageBox('Host data left behind', lines, 'red');
  process.exitCode = 1;
  return false;
}

/**
 * The tunnel folder beside an appliance's data dir. Compose mounts `${ROOT_FOLDER_HOST}/../tunnel`
 * at /app/tunnel, and an appliance's ROOT_FOLDER_HOST is the data dir, so the Cloudflare `token`,
 * `registration.json`, and `certs/` live in `~/.local/share/tunnel` (every appliance `ci-hub`
 * container on the fleet mounts it), outside the `companion-hub` tree. Undefined when it is not a
 * real folder: a symlink there is not followed.
 */
function applianceTunnelDir(dataDir: string): string | undefined {
  const tunnelDir = path.join(path.dirname(dataDir), 'tunnel');
  try {
    return lstatSync(tunnelDir).isDirectory() ? tunnelDir : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Hub's files in {@link applianceTunnelDir}. Reset used to leave them (on core-2 `tunnel/certs`
 * dated from 2026-08-10, through every reset since), and the next `cihub up` found a token beside
 * `registration.json`, turned on the `cloudflare` profile (applyCloudflareProfile), and ran the
 * previous Hub's tunnel until the fresh backend saw it had no registration.
 *
 * `tunnel` is a generic name, so this is what `cihub uninstall` deletes there (hubFilesInTunnelDir),
 * not the folder: the token only when it is a cloudflared token, the markers only when they carry a
 * tunnelId. `certs/` and the folder go after them, once empty.
 */
function applianceTunnelFiles(dataDir: string): string[] {
  const tunnelDir = applianceTunnelDir(dataDir);
  return tunnelDir ? hubFilesInTunnelDir(tunnelDir) : [];
}

function removeApplianceTunnelFiles(dataDir: string, docker: HubDocker): HostDataRemoval[] {
  const removeAsRoot = (hostPath: string) => removeViaRootContainer(hostPath, docker);
  const results = applianceTunnelFiles(dataDir).map((file) => removeHostDataTarget(file, { removeAsRoot }));
  const tunnelDir = applianceTunnelDir(dataDir);
  if (!tunnelDir) return results;
  // The backend creates certs/ empty. As in `cihub uninstall`, it and the folder go only once
  // nothing is left in them; anything else in there is not the Hub's to delete.
  for (const folder of [path.join(tunnelDir, 'certs'), tunnelDir]) {
    if (isEmptyRealDir(folder)) results.push(removeHostDataTarget(folder, { removeAsRoot }));
  }
  return results;
}

/**
 * Full wipe of a canonical prod data dir (clean slate; re-registration required afterward).
 * Removes the entire `<data dir>/companion-hub` tree, which holds the seeded `.env`, compose file,
 * and app/data mounts, then the Hub's files in the tunnel folder beside it (see
 * {@link applianceTunnelFiles}). Guarded so we only ever delete a folder named `companion-hub`
 * inside the user's data/home directory, never the home directory itself.
 */
function cleanApplianceHub(ctx: HubContext, options: CleanHubOptions): HostDataRemoval[] {
  const dataDir = ctx.dataDir as string;
  const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
  const safe = path.basename(dataDir) === CANONICAL_DATA_DIR_NAME && pathIsStrictlyWithin(homeDir, dataDir);
  if (!safe) {
    printMessageBox(
      'Refusing to wipe data dir',
      [`Unexpected canonical data dir: ${dataDir}`, `Expected a "${CANONICAL_DATA_DIR_NAME}" folder inside your user data directory.`],
      'red',
    );
    process.exit(2);
  }
  const docker = options.docker ?? hubDocker(dataDir);
  if (!options.appsAlreadyRemoved) {
    removeAppContainersBeforeDeletingData(docker);
  }
  const result = removeHostDataTarget(dataDir, { removeAsRoot: (hostPath) => removeViaRootContainer(hostPath, docker) });
  const tunnel = removeApplianceTunnelFiles(dataDir, docker);
  if (result.removed) {
    const via = result.rootContainer === 'ran' ? ' (the root-owned part through a root container)' : '';
    printMessageBox(
      'Prod Hub data wiped',
      [
        result.existed ? `removed: ${dataDir}${via}` : dim(`already absent: ${dataDir}`),
        ...tunnel.filter((file) => file.removed).map((file) => `removed: ${file.target}`),
      ],
      'yellow',
    );
  }
  reportHostDataLeftovers([result, ...tunnel]);
  return [result, ...tunnel];
}

type CleanHubOptions = {
  /** `cihub reset` has already removed the apps, with their volumes, before `down`. */
  appsAlreadyRemoved?: boolean;
  /** The engine reset read before it removed anything; see {@link hubDocker}. */
  docker?: HubDocker;
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
function removeAppContainersBeforeDeletingData(docker: HubDocker) {
  const removed = describeAppTeardown(removeManagedAppProjects(docker.capture, { removeVolumes: false }));
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

/**
 * Where reset deletes host files: the whole canonical tree and the Hub's files in the tunnel folder
 * beside it (appliance), or hub-data and tunnel (checkout).
 */
function hostDataTargets(env: HubEnv): { path: string; label: string }[] {
  if (isApplianceMode()) {
    const { dataDir } = resolveHubContext(env);
    if (!dataDir) return [];
    return [{ path: dataDir, label: 'data dir' }, ...applianceTunnelFiles(dataDir).map((file) => ({ path: file, label: 'tunnel file' }))];
  }
  const rootFolderHost = resolveRootFolderHost(getEnvFileOrExit(env));
  return [
    { path: rootFolderHost, label: 'root folder' },
    { path: path.resolve(rootFolderHost, '..', 'tunnel'), label: 'tunnel dir' },
  ];
}

/** For --dry-run: whether a target is there, and which folders in it need the root container. */
function dryRunHostDataNotes(target: string): string[] {
  if (!existsSync(target)) return [dim('    already absent')];
  const blocked = findFoldersBlockingRemoval(target);
  if (blocked.length === 0) return [];
  return [
    `    ${currentUserLabel()} cannot delete everything in it; reset deletes these through a root container:`,
    ...describeBlockedFolders(blocked).map((line) => `      ${line}`),
  ];
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

/** Returns what happened to each host data folder; any survivor has already been reported. */
export function cleanHub(env: HubEnv, options: CleanHubOptions = {}): HostDataRemoval[] {
  if (isApplianceMode()) {
    requireRepoOrApplianceContext('cihub clean', 'allow-missing');
    return cleanApplianceHub(resolveHubContext(env), options);
  }
  requireRepoRoot('cihub clean');
  const docker = options.docker ?? hubDocker(undefined);
  if (!options.appsAlreadyRemoved) {
    removeAppContainersBeforeDeletingData(docker);
  }
  const targets = hostDataTargets(env);
  const results = targets.map(({ path: target }) => removeCheckoutTarget(target, docker));
  const lines = results.map((result, index) => {
    const line = `${targets[index].label}: ${result.target}`;
    if (!result.existed) return dim(`skipped ${line}`);
    return result.removed ? line : `left behind ${line}`;
  });
  const allRemoved = results.every((result) => result.removed);
  printMessageBox(allRemoved ? 'Environment files cleaned' : 'Environment files partly cleaned', lines, 'yellow');
  reportHostDataLeftovers(results);
  return results;
}

export async function resetHub(env: HubEnv, force: boolean, dryRun = false): Promise<boolean> {
  const appliance = isApplianceMode();
  if (appliance) {
    requireRepoOrApplianceContext('cihub reset', 'allow-missing');
  } else {
    requireRepoRoot('cihub reset');
  }
  const label = appliance ? 'prod (canonical install)' : env;
  const applianceDataDir = appliance ? resolveHubContext(env).dataDir : undefined;
  const docker = hubDocker(applianceDataDir);
  // Shown before the prompt, because the list can hold containers the Hub never installed and the
  // operator should see those by name before agreeing to remove them. See planAppTeardown.
  const plan = planAppTeardown(docker.capture, { removeVolumes: true });
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
        ...hostDataTargets(env).flatMap(({ path: target }) => [`  ${target}`, ...dryRunHostDataNotes(target)]),
        'Then it checks that those containers, volumes, and folders are gone. Anything left is listed with the command that removes it, and reset exits 1.',
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
  const current = planAppTeardown(docker.capture, { removeVolumes: true });
  if (!listedOrRefuse(current)) return false;
  executeAppTeardown(docker.capture, current);
  const removed = describeAppTeardown(current);
  if (removed.length > 0) {
    printMessageBox('Removed installed apps', removed, 'yellow');
  }
  downHub(env, { volumes: true });
  verifyHubVolumesRemoved(docker);
  const hostData = cleanHub(env, { appsAlreadyRemoved: true, docker });
  const dockerLeft = lingeringDockerState(current, appliance ? ['ci-hub', 'ci-os-hub'] : ['ci-hub'], docker);
  const hostDataLeft = hostData.filter((result) => !result.removed);
  // Every removal above is best-effort, so the success line is printed only once a fresh look finds
  // nothing left. Before this check, reset said "host data were removed" on the 3 of 17 fleet nodes
  // (core-2, core-3, fzzy; 2026-09-26) whose data dir had just failed with EACCES.
  if (dockerLeft.lines.length > 0 || hostDataLeft.length > 0) {
    printMessageBox('Reset incomplete', resetIncompleteLines(appliance ? 'prod' : env, dockerLeft, hostDataLeft), 'red');
    process.exitCode = 1;
    return false;
  }
  printMessageBox(
    'Reset complete',
    [
      'Hub runtime state, volumes, and host data were removed.',
      ...(applianceDataDir ? gpuProbeRewritesDataDirNote(applianceDataDir) : []),
      'Re-launch CI Hub or run `cihub up dev` (or `cihub up prod`) to start fresh.',
    ],
    'green',
  );
  return true;
}

/**
 * The GPU probe timer (docs/fleet-setup.md; `fleet install` sets it up) writes
 * `<data dir>/state/hardware/gpu_processes.json` every 15 s and creates the folders it needs, so a
 * `companion-hub` folder is back seconds after "Reset complete". After the 2026-09-26 rebuild's
 * resets, 13 of the 14 nodes whose data dir had been deleted held one again, with only `state/` in
 * it (core-6 also had the desktop app's `logs/`), and operators moved each aside by hand. That is not
 * needed: `cihub up` and `fleet install` seed a fresh install whenever `.env` and the compose file
 * are missing, whatever else the folder holds (resolveProdApplianceContext).
 *
 * The timer is left running. Stopping it for the reset would only delay the folder, since the Hub
 * needs the probe again once it is up, and a stopped timer is one nothing restarts after `cihub up`.
 */
function gpuProbeRewritesDataDirNote(dataDir: string): string[] {
  const unitDir = path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || homedir(), '.config'), 'systemd', 'user');
  if (!existsSync(path.join(unitDir, GPU_PROBE_TIMER_UNIT))) return [];
  return [
    dim(
      `${GPU_PROBE_TIMER_UNIT} writes ${path.join(dataDir, 'state', 'hardware')} again within ${GPU_PROBE_INTERVAL_SECONDS} s. That is expected; ` +
        '`cihub up` creates the new install beside it, so the folder does not need to be moved aside.',
    ),
  ];
}

function isHubVolume(name: string): boolean {
  return name.includes('ci_hub_pgdata') || name.includes('ci_hub_app_data') || name.includes('hub_tailscale_state');
}

function verifyHubVolumesRemoved(docker: HubDocker) {
  const { stdout } = docker.capture(['volume', 'ls', '--format', '{{.Name}}']);
  const lingering = parseNames(stdout).filter(isHubVolume);

  if (lingering.length === 0) {
    return;
  }

  printMessageBox('Removing lingering Hub volumes', lingering, 'yellow');
  for (const volume of lingering) {
    docker.bestEffort(['volume', 'rm', volume]);
  }
}

type DockerLeftovers = { lines: string[]; commands: string[] };

/**
 * The containers and volumes reset set out to remove that Docker still lists. `docker rm -f`,
 * `docker volume rm`, and `compose down` all run best-effort, and a volume still attached to a
 * container survives its `volume rm`; a surviving `ci_hub_pgdata` would hand the "fresh" Hub its
 * old database.
 */
function lingeringDockerState(plan: AppTeardownPlan, hubProjects: string[], docker: HubDocker): DockerLeftovers {
  const allContainers = docker.capture(['ps', '-a', '--format', '{{.Names}}']);
  const allVolumes = docker.capture(['volume', 'ls', '--format', '{{.Name}}']);
  const hubContainers = hubProjects.map((project) =>
    docker.capture(['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Names}}']),
  );
  if (!allContainers.ok || !allVolumes.ok || hubContainers.some((listing) => !listing.ok)) {
    return { lines: ['Docker did not list its containers and volumes, so reset could not check that they were removed.'], commands: [] };
  }
  const plannedContainers = new Set([...plan.projects.flatMap((project) => project.containers), ...plan.unmanaged]);
  const plannedVolumes = new Set(plan.projects.flatMap((project) => project.volumes));
  // `{{.Names}}` joins legacy link aliases with commas; the first entry is the container itself.
  const names = (stdout: string) => parseNames(stdout).map((line) => line.split(',')[0]);
  const containers = [
    ...new Set([
      ...names(allContainers.stdout).filter((name) => plannedContainers.has(name)),
      ...hubContainers.flatMap((listing) => names(listing.stdout)),
    ]),
  ];
  const volumes = parseNames(allVolumes.stdout).filter((name) => plannedVolumes.has(name) || isHubVolume(name));
  const lines: string[] = [];
  const commands: string[] = [];
  if (containers.length > 0) {
    lines.push(`Containers still there: ${containers.join(', ')}`);
    commands.push(`docker rm -f ${containers.join(' ')}`);
  }
  if (volumes.length > 0) {
    lines.push(`Volumes still there: ${volumes.join(', ')}`);
    lines.push(dim(`  \`docker ps -a --filter volume=${volumes[0]}\` shows a container still using one.`));
    commands.push(`docker volume rm ${volumes.join(' ')}`);
  }
  return { lines, commands };
}

function resetIncompleteLines(env: HubEnv, dockerLeft: DockerLeftovers, hostDataLeft: HostDataRemoval[]): string[] {
  const lines: string[] = [];
  lines.push(...(dockerLeft.lines.length === 0 ? ['Installed apps, Hub containers, and Hub volumes were removed.'] : dockerLeft.lines));
  if (hostDataLeft.length > 0) {
    lines.push('Host data was not fully deleted; "Host data left behind" above lists what is left and why.');
  }
  const commands = [...dockerLeft.commands, ...hostDataLeft.filter((result) => !result.refused).map((result) => rootRemovalCommand(result.target))];
  if (commands.length > 0) {
    lines.push('To finish:', ...commands.map((command) => `  ${command}`));
  }
  lines.push(
    `Then run \`${BASE_COMMAND} reset ${env} --yes\` again; it ends with "Reset complete" once nothing is left. \`${BASE_COMMAND} up ${env}\` starts fresh.`,
  );
  return lines;
}

export async function recreateHub(env: HubEnv, detached = false, force = false) {
  const resetComplete = await resetHub(env, force);
  if (!resetComplete) return;
  await startHub(env === 'local' ? 'local-dev' : detached ? 'detached' : 'attached', env);
}
