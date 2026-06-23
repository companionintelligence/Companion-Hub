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
import { upsertEnvVar } from './env-file';
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
  if (envFile === '.env') return;
  const poisoned = path.join(cwd, '.env');
  if (!existsSync(poisoned)) return;
  try {
    if (statSync(poisoned).isDirectory()) {
      rmSync(poisoned, { recursive: true, force: true });
      console.warn(
        `init-hub-data-dirs: removed poisoned .env/ directory (Docker creates this when the bind-mount source file is missing; use ENV_FILE=${envFile})`,
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
  const uid = process.getuid?.();
  const userGid = process.getgid?.();
  if (typeof uid === 'number') upsertEnvVar(envFile, 'CI_HUB_CONTAINER_UID', String(uid));
  if (typeof userGid === 'number') upsertEnvVar(envFile, 'CI_HUB_CONTAINER_GID', String(userGid));
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
