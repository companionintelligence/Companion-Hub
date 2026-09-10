#!/usr/bin/env tsx
/**
 * Create Hub bind-mount directories on the host with owner-writable permissions.
 *
 * Required when the Hub container runs as the host UID/GID (not root): paths like
 * /data/cache and /data/.docker must exist on the host before compose up.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { isDirectScriptRun } from './lib/is-direct-run';
import { removeEnvVar, parseEnvFile, upsertEnvVar } from './env-file';
import { resolveRootFolderHostForRuntime } from './lib/paths';
import {
  dockerSocketIsRootOnlyInsideContainers,
  ensureHubBindMountsWritable,
  isDockerAvailable,
  likelyDockerDesktop,
  logBindMountHeal,
  resolveHostDockerSocketPath,
} from './heal-hub-bind-mounts';

function resolveRootFolderHost(): string {
  return resolveRootFolderHostForRuntime();
}

function healPoisonedEnvMount(cwd: string): void {
  const envFile = process.env.ENV_FILE || '.env.dev';
  const envPath = path.isAbsolute(envFile) ? envFile : path.join(cwd, envFile);
  if (!existsSync(envPath)) return;
  try {
    if (statSync(envPath).isDirectory()) {
      rmSync(envPath, { recursive: true, force: true });
      console.warn(
        `init-hub-data-dirs: removed poisoned env mount at ${envPath} (Docker creates a directory when the bind-mount source file is missing)`,
      );
    }
  } catch {
    // Best-effort.
  }
}

function resolveDockerGid(): string {
  if (process.platform !== 'win32') {
    try {
      const line = execSync('getent group docker', { encoding: 'utf8' }).trim();
      const gid = line.split(':')[2]?.trim();
      if (gid) return gid;
    } catch {
      // getent missing (macOS) or docker group absent
    }
  }
  try {
    return String(statSync(resolveHostDockerSocketPath()).gid);
  } catch {
    return '973';
  }
}

function ensureContainerIdentityInEnvFile(cwd: string): void {
  const envFile = process.env.ENV_FILE || '.env.dev';
  const envPath = path.isAbsolute(envFile) ? envFile : path.join(cwd, envFile);
  if (!existsSync(envPath)) return;

  upsertEnvVar(envFile, 'ENV_FILE', envFile);

  const socketRootOnly = dockerSocketIsRootOnlyInsideContainers();
  if (socketRootOnly === true || (socketRootOnly === null && likelyDockerDesktop())) {
    if (socketRootOnly === null) {
      console.warn(
        'init-hub-data-dirs: Docker is not running; assuming Docker Desktop (Hub container will use UID 0 for socket access). Start Docker before compose up.',
      );
    } else {
      console.warn(
        'init-hub-data-dirs: Docker socket is root:root inside containers (common on Docker Desktop); Hub will run as root for socket access. Bind mounts remain on the host.',
      );
    }
    upsertEnvVar(envFile, 'CI_HUB_CONTAINER_UID', '0');
    upsertEnvVar(envFile, 'CI_HUB_CONTAINER_GID', '0');
    return;
  }

  const gid = resolveDockerGid();
  upsertEnvVar(envFile, 'DOCKER_GID', gid);

  // Deliberately NOT pinning CI_HUB_CONTAINER_UID/GID here in the ordinary case.
  //
  // Writing `getuid()` looks harmless — it is what the entrypoint would pick anyway on a
  // normal install, because the env file this very function is editing was created by the
  // same user. But it is a PIN, and it is rewritten on every `cihub up`, so it silently
  // outranks the entrypoint's own derivation forever after. That is what made #1370 and
  // #1378 inert on the fleet: every node carried `CI_HUB_CONTAINER_UID=1000` in .env.prod,
  // so the container dropped to 1000 no matter who owned the install, and a root-owned one
  // crash-looped on EACCES reading its own 0600 /data/.env.
  //
  // The two identities only diverge in exactly the case that breaks: when the install
  // directory is owned by someone other than whoever is running the CLI — a root-owned
  // install driven through sudo or docker-group membership. There the pin is wrong and the
  // entrypoint's reading of the config file's owner is right, so deferring is strictly
  // better than agreeing.
  //
  // The Docker-Desktop branch above still pins 0:0, because that is a real override the
  // entrypoint cannot infer: it is a fact about the socket, not about the files.
  //
  // Existing installs are unpinned only where the pin is provably this function's own work
  // — the value still equals the current uid/gid. A value that differs was set by an
  // operator or by the branch above and is left untouched.
  const uid = process.getuid?.();
  const userGid = process.getgid?.();
  const vars = parseEnvFile(envFile);
  if (typeof uid === 'number' && vars.CI_HUB_CONTAINER_UID === String(uid)) {
    removeEnvVar(envFile, 'CI_HUB_CONTAINER_UID');
  }
  if (typeof userGid === 'number' && vars.CI_HUB_CONTAINER_GID === String(userGid)) {
    removeEnvVar(envFile, 'CI_HUB_CONTAINER_GID');
  }
}

export function initHubDataDirs(): void {
  const cwd = process.cwd();
  healPoisonedEnvMount(cwd);
  ensureContainerIdentityInEnvFile(cwd);

  const envFile = process.env.ENV_FILE || '.env.dev';
  const root = resolveRootFolderHost();
  const envFilePath = path.isAbsolute(envFile) ? envFile : path.join(cwd, envFile);
  const dockerAvailable = isDockerAvailable();

  if (!dockerAvailable) {
    console.warn('init-hub-data-dirs: Docker is not available; skipping Docker-based bind-mount verification until Docker starts.');
  }

  const identity = ensureHubBindMountsWritable(root, { envFile: envFilePath, skipDockerHeal: !dockerAvailable });
  logBindMountHeal(
    root,
    `init-hub-data-dirs: bind mounts ready under ${root} (container ${identity.uid}:${identity.gid}, source=${identity.source})`,
  );

  const dockerDir = path.join(root, '.docker');
  const cliPlugins = path.join(dockerDir, 'cli-plugins');
  mkdirSync(cliPlugins, { recursive: true });

  console.log(`init-hub-data-dirs: ensured bind-mount tree under ${root}`);
}

const isDirectRun = isDirectScriptRun(import.meta.url, import.meta.main);

if (isDirectRun) {
  initHubDataDirs();
}
